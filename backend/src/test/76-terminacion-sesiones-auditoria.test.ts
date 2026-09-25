import './helpers/testEnv';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { after, before, beforeEach, describe, it } from 'node:test';
import { execute, query, queryOne } from '../config/database';
import { env } from '../config/env';
import { get, post, put } from './helpers/api';
import { at, freeSeats, login, TEST_PASSWORD } from './helpers/fixtures';
import { expireDueBookings } from '../services/booking-expiry.service';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * F17C-SEC-10 · terminación real de sesiones y rastro de las transiciones automáticas.
 *
 * DOS PROBLEMAS DISTINTOS QUE COMPARTEN LA MISMA IDEA: que un cambio de estado importante no
 * puede quedar a medias ni sin registrar.
 *
 * A · Suspender una cuenta bloqueaba su token mientras durase la suspensión —el estado se relee
 *     en cada petición—, pero no lo terminaba: al reactivar, el token anterior volvía a servir
 *     hasta agotar sus 8 horas. Justo en el caso que importa, suspender por sospecha de robo de
 *     sesión, el token del atacante solo quedaba en pausa. El caso 4 de abajo es el crítico.
 *
 * B · Una reserva pasaba de PENDING a EXPIRED y liberaba asientos sin dejar nada en `audit_logs`.
 *     Se notificaba al usuario, pero una notificación no es una auditoría.
 *
 * Todo contra `busperu_test`. Ninguna contraseña ni token se imprime.
 */

/** Usuario propio de esta suite: suspenderlo no puede afectar a las fixtures compartidas. */
const CORREO = 'sec10-usuario@test.pe';
const CORREO_B = 'sec10-otro@test.pe';

describe('SEC-10 · terminación de sesiones y auditoría automática', () => {
  let ctx: SuiteContext;
  let usuarioId = 0;
  let usuarioBId = 0;

  const cambiarEstado = (id: number, status: string) =>
    put(`/users/${id}`, { status }, ctx.sessions.admin.token);

  const marca = async (id: number) =>
    (await queryOne<{ n: number | null }>('SELECT UNIX_TIMESTAMP(sessions_valid_from) AS n FROM users WHERE id = ?', [id]))?.n ?? null;

  before(async () => {
    ctx = await prepareSuite();
    const rol = await queryOne<{ id: number }>("SELECT id FROM roles WHERE name = 'CUSTOMER'");
    const hash = (await queryOne<{ h: string }>('SELECT password_hash AS h FROM users WHERE id = ?', [ctx.fixtures.users.customer]))!.h;
    for (const correo of [CORREO, CORREO_B]) {
      const { insertId } = await execute(
        `INSERT INTO users (role_id, first_name, last_name, email, phone, password_hash, status, email_verified_at)
         VALUES (?, 'Sec', 'Diez', ?, '999999999', ?, 'ACTIVE', NOW())`,
        [rol!.id, correo, hash],
      );
      if (correo === CORREO) usuarioId = insertId; else usuarioBId = insertId;
    }
  });

  after(async () => {
    await execute('DELETE FROM users WHERE email IN (?, ?)', [CORREO, CORREO_B]);
    await teardownSuite();
  });

  beforeEach(async () => {
    // Cada caso parte de una cuenta activa y sin marca de terminación.
    await execute('UPDATE users SET status = ?, sessions_valid_from = NULL WHERE id IN (?, ?)', ['ACTIVE', usuarioId, usuarioBId]);
    await execute('DELETE FROM revoked_sessions');
  });

  /* ============================================ PARTE A · sesiones */
  describe('A · una suspensión termina las sesiones', () => {
    it('1 · una sesión normal funciona', async () => {
      const sesion = await login(CORREO);
      const r = await get('/auth/me', sesion.token);
      assert.equal(r.status, 200);
      assert.equal(r.body.data.email, CORREO);
    });

    it('2 · suspender avanza la marca de terminación', async () => {
      assert.equal(await marca(usuarioId), null, 'una cuenta que nunca se suspendió no tiene marca');
      await login(CORREO);

      const r = await cambiarEstado(usuarioId, 'SUSPENDED');

      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok((await marca(usuarioId)) !== null, 'la marca debe quedar puesta');
    });

    it('3 · el token deja de servir en cuanto la cuenta se suspende', async () => {
      const sesion = await login(CORREO);
      assert.equal((await get('/auth/me', sesion.token)).status, 200);

      await cambiarEstado(usuarioId, 'SUSPENDED');

      const r = await get('/auth/me', sesion.token);
      assert.ok(r.status === 401 || r.status === 403, `el token no puede seguir entrando (${r.status})`);
    });

    /**
     * EL CASO CRÍTICO DE ESTA FASE. Antes, aquí el token volvía a funcionar: la comprobación era
     * solo del estado, y con la cuenta otra vez ACTIVE nada lo rechazaba. Quien hubiera robado la
     * sesión recuperaba el acceso en el momento en que el administrador reactivaba la cuenta.
     */
    it('4 · reactivar NO revive el token anterior', async () => {
      const sesion = await login(CORREO);
      await cambiarEstado(usuarioId, 'SUSPENDED');
      await cambiarEstado(usuarioId, 'ACTIVE');

      const r = await get('/auth/me', sesion.token);

      assert.equal(r.status, 401, `el token anterior a la suspensión debe seguir rechazado (${r.status})`);
      assert.match(String(r.body.message), /sesi[óo]n/i);
    });

    it('5 · tras reactivar, un inicio de sesión nuevo funciona', async () => {
      await login(CORREO);
      await cambiarEstado(usuarioId, 'SUSPENDED');
      await cambiarEstado(usuarioId, 'ACTIVE');

      // Un segundo de separación: el `iat` del JWT va en segundos y la comparación es estricta.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const nueva = await login(CORREO);

      assert.equal((await get('/auth/me', nueva.token)).status, 200, 'la cuenta reactivada debe poder usarse');
    });

    it('14 · ACTIVE → SUSPENDED → ACTIVE → SUSPENDED → ACTIVE deja fuera al token original', async () => {
      const original = await login(CORREO);

      for (const estado of ['SUSPENDED', 'ACTIVE', 'SUSPENDED', 'ACTIVE'] as const) {
        await cambiarEstado(usuarioId, estado);
      }

      assert.equal((await get('/auth/me', original.token)).status, 401, 'ningún ciclo puede devolverle la validez');
    });

    it('15 · y después de todos esos ciclos, un inicio de sesión nuevo sigue funcionando', async () => {
      await login(CORREO);
      for (const estado of ['SUSPENDED', 'ACTIVE', 'SUSPENDED', 'ACTIVE'] as const) {
        await cambiarEstado(usuarioId, estado);
      }
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const nueva = await login(CORREO);
      assert.equal((await get('/auth/me', nueva.token)).status, 200);
    });

    it('10 · suspender a un usuario no afecta a la sesión de otro', async () => {
      const a = await login(CORREO);
      const b = await login(CORREO_B);

      await cambiarEstado(usuarioId, 'SUSPENDED');

      const rechazado = await get('/auth/me', a.token);
      assert.ok(rechazado.status === 401 || rechazado.status === 403, `el suspendido queda fuera (${rechazado.status})`);
      assert.equal((await get('/auth/me', b.token)).status, 200, 'el otro sigue dentro');
      assert.equal(await marca(usuarioBId), null, 'y su marca no se toca');
    });

    it('11 · tampoco alcanza a usuarios de otras empresas', async () => {
      const empresaA = ctx.sessions.companyAdmin.token;
      const empresaB = ctx.sessions.companyAdminB.token;

      await cambiarEstado(usuarioId, 'SUSPENDED');

      assert.equal((await get('/auth/me', empresaA)).status, 200);
      assert.equal((await get('/auth/me', empresaB)).status, 200);
    });

    it('INACTIVE también termina las sesiones', async () => {
      // Cualquier estado distinto de ACTIVE significa «esta cuenta no debe tener sesiones vivas».
      const sesion = await login(CORREO);
      await cambiarEstado(usuarioId, 'INACTIVE');
      await cambiarEstado(usuarioId, 'ACTIVE');

      assert.equal((await get('/auth/me', sesion.token)).status, 401);
    });

    it('editar sin tocar el estado no cierra ninguna sesión', async () => {
      const sesion = await login(CORREO);

      const r = await put(`/users/${usuarioId}`, { first_name: 'Renombrado' }, ctx.sessions.admin.token);

      assert.equal(r.status, 200);
      assert.equal(await marca(usuarioId), null, 'no hay motivo para terminar sesiones');
      assert.equal((await get('/auth/me', sesion.token)).status, 200);
    });

    it('la suspensión queda registrada en la auditoría', async () => {
      await cambiarEstado(usuarioId, 'SUSPENDED');

      const filas = await query<{ description: string; new_values: string; user_id: number }>(
        "SELECT description, new_values, user_id FROM audit_logs WHERE entity_type = 'users' AND entity_id = ? AND action = 'UPDATE' ORDER BY id DESC",
        [usuarioId],
      );
      assert.ok(filas.length > 0);
      assert.match(String(filas[0]?.description), /cerr[óo] sus sesiones/i);
      assert.equal(JSON.parse(String(filas[0]?.new_values)).sessions_terminated, true);
      assert.equal(Number(filas[0]?.user_id), ctx.sessions.admin.user.id, 'esta sí la hizo una persona');
    });
  });

  /* ============================================ A · lo anterior sigue intacto */
  describe('A · los mecanismos que ya existían siguen funcionando', () => {
    it('6 · cambiar la contraseña invalida las sesiones anteriores', async () => {
      const sesion = await login(CORREO);

      const r = await put('/auth/me/password',
        { current_password: TEST_PASSWORD, new_password: 'OtraClaveSegura9' }, sesion.token);
      assert.equal(r.status, 200, JSON.stringify(r.body));

      assert.equal((await get('/auth/me', sesion.token)).status, 401, 'la huella `pwd` ya no coincide');
      // Se deja la cuenta como estaba para los casos siguientes.
      await execute('UPDATE users SET password_hash = (SELECT password_hash FROM (SELECT password_hash FROM users WHERE id = ?) AS x) WHERE id = ?',
        [ctx.fixtures.users.customer, usuarioId]);
    });

    it('8 · cerrar sesión revoca ese token concreto', async () => {
      const sesion = await login(CORREO);

      assert.equal((await post('/auth/logout', {}, sesion.token)).status, 200);

      assert.equal((await get('/auth/me', sesion.token)).status, 401, 'el `jti` quedó revocado');
    });

    it('9 · la revocación por `jti` es independiente de la marca de terminación', async () => {
      const primera = await login(CORREO);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const segunda = await login(CORREO);

      await post('/auth/logout', {}, primera.token);

      assert.equal((await get('/auth/me', primera.token)).status, 401, 'solo cae la que cerró sesión');
      assert.equal((await get('/auth/me', segunda.token)).status, 200, 'la otra sigue viva');
      assert.equal(await marca(usuarioId), null, 'cerrar sesión no toca la marca de la cuenta');
    });

    it('12 · un token caducado se sigue rechazando', async () => {
      const caducado = jwt.sign(
        { sub: usuarioId, roleId: 4, role: 'CUSTOMER', iat: Math.floor(Date.now() / 1000) - 7200 },
        env.jwt.secret,
        { expiresIn: '1s' },
      );
      await new Promise((resolve) => setTimeout(resolve, 1100));

      assert.equal((await get('/auth/me', caducado)).status, 401);
    });

    it('13 · un token manipulado se sigue rechazando', async () => {
      const sesion = await login(CORREO);
      const partes = sesion.token.split('.');
      const manipulado = `${partes[0]}.${partes[1]}.${'a'.repeat(String(partes[2]).length)}`;

      assert.equal((await get('/auth/me', manipulado)).status, 401, 'la firma manda, antes que nada');
    });

    it('un token firmado a mano sin `iat` no entra si la cuenta tiene marca', async () => {
      // Sin `iat` no hay forma de demostrar que el token es posterior a la terminación, así que
      // se rechaza. Es el lado seguro.
      await cambiarEstado(usuarioId, 'SUSPENDED');
      await cambiarEstado(usuarioId, 'ACTIVE');

      const hash = (await queryOne<{ h: string }>('SELECT password_hash AS h FROM users WHERE id = ?', [usuarioId]))!.h;
      const { sessionFingerprint } = await import('../utils/security');
      const sinIat = jwt.sign(
        { sub: usuarioId, roleId: 4, role: 'CUSTOMER', pwd: sessionFingerprint(hash), exp: Math.floor(Date.now() / 1000) + 3600 },
        env.jwt.secret,
        { noTimestamp: true },
      );

      assert.equal((await get('/auth/me', sinIat)).status, 401);
    });
  });

  /* ============================================ A · concurrencia */
  it('A · suspender mientras se inicia sesión no deja un token válido colado', async () => {
    /**
     * F17C-SEC-11 · LOS DOS ÓRDENES SON LEGÍTIMOS, Y EL CASO LOS ACEPTA AMBOS.
     *
     * La primera versión hacía `Promise.all([login, suspender])` y daba por hecho que el login
     * siempre gana. No está garantizado: si la suspensión se confirma antes de que el login lea
     * el estado, el login responde 403 —que es lo CORRECTO— y el helper `login()` lanza, así que
     * el caso fallaba con el producto funcionando bien. Se demostró forzando ese orden. En esta
     * máquina el login ganó 60 de 60 veces, pero en otra, o con carga, puede invertirse.
     *
     * Lo que se exige no cambia: pase lo que pase, NO puede quedar ningún token válido.
     */
    const [intento] = await Promise.allSettled([login(CORREO), cambiarEstado(usuarioId, 'SUSPENDED')]);

    if (intento.status === 'rejected') {
      // Ganó la suspensión: no se llegó a emitir token. Debe haber sido por la suspensión y no
      // por cualquier otro fallo que pasaría por éxito.
      assert.match(String(intento.reason), /403.*suspendida/i, 'el login se rechazó justamente por la suspensión');
      return;
    }

    // Ganó el login: el token existe, pero la marca de terminación lo deja fuera.
    const sesion = intento.value;
    const r = await get('/auth/me', sesion.token);
    assert.ok(r.status === 401 || r.status === 403, `la cuenta está suspendida (${r.status})`);

    await cambiarEstado(usuarioId, 'ACTIVE');
    const tras = await get('/auth/me', sesion.token);
    assert.equal(tras.status, 401, 'y al reactivar tampoco vale: nació antes o durante la terminación');
  });

  /* ============================================ PARTE B · auditoría */
  describe('B · rastro de la expiración automática', () => {
    const auditoriasDe = (bookingId: number) =>
      query<{ user_id: number | null; action: string; description: string; old_values: string; new_values: string; created_at: string }>(
        "SELECT user_id, action, description, old_values, new_values, created_at FROM audit_logs WHERE entity_type = 'bookings' AND entity_id = ? AND action = 'EXPIRE'",
        [bookingId],
      );

    const reservar = async (): Promise<number> => {
      const libres = await freeSeats(ctx.fixtures.tripA);
      const r = await post('/bookings',
        { trip_id: ctx.fixtures.tripA, seat_ids: [at(libres, 0).id], passenger_email: 'cliente@test.pe' },
        ctx.sessions.customer.token);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return Number(r.body.data.id);
    };
    const vencer = (id: number) =>
      execute('UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [id]);

    beforeEach(async () => {
      for (const tabla of ['financial_transactions', 'payments', 'booking_seats', 'notifications', 'bookings']) {
        await execute(`DELETE FROM ${tabla}`);
      }
      await execute("DELETE FROM audit_logs WHERE entity_type = 'bookings'");
      await execute("UPDATE trips t JOIN buses b ON b.id = t.bus_id SET t.available_seats = b.capacity, t.status = 'SCHEDULED'");
    });

    it('Audit 1 · expirar deja la reserva EXPIRED, libera el asiento y escribe la auditoría', async () => {
      const id = await reservar();
      const cupos = Number((await queryOne<{ n: number }>('SELECT available_seats AS n FROM trips WHERE id = ?', [ctx.fixtures.tripA]))?.n);
      await vencer(id);

      const resultado = await expireDueBookings();

      assert.equal(resultado.expired, 1);
      assert.equal((await queryOne<{ s: string }>('SELECT status AS s FROM bookings WHERE id = ?', [id]))?.s, 'EXPIRED');
      assert.equal(Number((await queryOne<{ n: number }>('SELECT available_seats AS n FROM trips WHERE id = ?', [ctx.fixtures.tripA]))?.n), cupos + 1);
      assert.equal((await auditoriasDe(id)).length, 1, 'y exactamente una entrada de auditoría');
    });

    it('Audit 2 · la entrada dice qué cambió, cuándo y que no hubo nadie detrás', async () => {
      const id = await reservar();
      await vencer(id);
      await expireDueBookings();

      const fila = (await auditoriasDe(id))[0]!;
      const antes = JSON.parse(fila.old_values) as Record<string, unknown>;
      const despues = JSON.parse(fila.new_values) as Record<string, unknown>;

      assert.equal(fila.action, 'EXPIRE');
      assert.equal(fila.user_id, null, 'no se inventa ni se atribuye a un administrador');
      assert.equal(despues.actor, 'system:booking-expiry', 'así se distingue de una acción humana');
      assert.equal(antes.status, 'PENDING');
      assert.equal(despues.status, 'EXPIRED');
      assert.ok(antes.expires_at, 'queda constancia de cuándo debía expirar');
      assert.equal(despues.reason, 'hold_expired');
      assert.equal(despues.seats_released, 1);
      assert.ok(fila.created_at, 'y cuándo ocurrió');
      assert.match(fila.description, /Expiró automáticamente/);
    });

    for (const estado of ['CONFIRMED', 'CANCELLED', 'COMPLETED'] as const) {
      it(`Audit 3-4 · una reserva ${estado} vencida no genera auditoría de expiración`, async () => {
        const id = await reservar();
        await execute('UPDATE bookings SET status = ?, expires_at = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE id = ?', [estado, id]);

        await expireDueBookings();

        assert.equal((await auditoriasDe(id)).length, 0);
      });
    }

    it('Audit 5 · barrer dos veces no escribe una segunda entrada', async () => {
      const id = await reservar();
      await vencer(id);

      await expireDueBookings();
      await expireDueBookings();

      assert.equal((await auditoriasDe(id)).length, 1, 'la revalidación bajo FOR UPDATE impide el duplicado');
    });

    it('Audit 6 · dos barridos simultáneos dan una transición y una sola auditoría', async () => {
      const ids: number[] = [];
      for (let i = 0; i < 3; i += 1) ids.push(await reservar());
      await execute(`UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id IN (${ids.join(',')})`);
      const cupos = Number((await queryOne<{ n: number }>('SELECT available_seats AS n FROM trips WHERE id = ?', [ctx.fixtures.tripA]))?.n);

      const [a, b] = await Promise.all([expireDueBookings(), expireDueBookings()]);

      assert.equal(a.expired + b.expired, 3);
      for (const id of ids) assert.equal((await auditoriasDe(id)).length, 1, `la reserva ${id} debe tener una sola auditoría`);
      assert.equal(Number((await queryOne<{ n: number }>('SELECT available_seats AS n FROM trips WHERE id = ?', [ctx.fixtures.tripA]))?.n), cupos + 3,
        'los asientos se liberan exactamente una vez');
      const avisos = await queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM notifications WHERE JSON_UNQUOTE(JSON_EXTRACT(data, '$.event_key')) IN (${ids.map((i) => `'booking.expired:${i}'`).join(',')})`);
      assert.equal(Number(avisos?.n), 3, 'y una notificación por reserva');
    });

    /**
     * Audit 7 · la garantía que SEC-06 dejó puesta sigue intacta, y además ahora es atómica: la
     * reserva que falla no expira NI deja auditoría —las dos cosas viven en la misma transacción—
     * y las sanas siguen su curso con la suya.
     */
    it('Audit 7 · una reserva problemática no arrastra a las demás ni deja auditoría huérfana', async () => {
      const ids: number[] = [];
      for (let i = 0; i < 3; i += 1) ids.push(await reservar());
      await execute(`UPDATE bookings SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id IN (${ids.join(',')})`);

      await execute('SET FOREIGN_KEY_CHECKS = 0');
      await execute('UPDATE bookings SET user_id = 999999 WHERE id = ?', [ids[0]]);
      await execute('SET FOREIGN_KEY_CHECKS = 1');

      const resultado = await expireDueBookings();

      assert.equal(resultado.failed, 1);
      assert.equal(resultado.expired, 2);
      assert.equal((await queryOne<{ s: string }>('SELECT status AS s FROM bookings WHERE id = ?', [ids[0]]))?.s, 'PENDING');
      assert.equal((await auditoriasDe(ids[0]!)).length, 0, 'sin cambio no puede haber auditoría');
      assert.equal((await auditoriasDe(ids[1]!)).length, 1);
      assert.equal((await auditoriasDe(ids[2]!)).length, 1);

      await execute('SET FOREIGN_KEY_CHECKS = 0');
      await execute('UPDATE bookings SET user_id = ? WHERE id = ?', [ctx.fixtures.users.customer, ids[0]]);
      await execute('SET FOREIGN_KEY_CHECKS = 1');
    });

    it('la auditoría no guarda datos personales del pasajero', async () => {
      const id = await reservar();
      await vencer(id);
      await expireDueBookings();

      const fila = (await auditoriasDe(id))[0]!;
      const volcado = `${fila.description} ${fila.old_values} ${fila.new_values}`;
      assert.ok(!volcado.includes('cliente@test.pe'), 'el correo del pasajero no pinta nada aquí');
      assert.ok(!/password|token/i.test(volcado));
    });
  });
});
