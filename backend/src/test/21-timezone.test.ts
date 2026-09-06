import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { get, post } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { at, freeSeats } from './helpers/fixtures';
import { advanceTripLifecycle } from '../services/trip.service';
import { businessNow, businessTimeMs, parseBusinessDateTime, peruUtcOffset, PERU_TIME_ZONE } from '../utils/businessTime';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * BP-12 · zona horaria.
 *
 * Las fechas de BusPerú son hora de pared de Perú y no llevan zona. `new Date(cadena)` las
 * interpretaba en la zona del PROCESO, así que el mismo dato producía instantes distintos
 * según dónde corriera Node; y el conector estaba declarado en UTC, de modo que un objeto
 * `Date` escrito como parámetro caía cinco horas por delante de lo que escribe `NOW()`.
 *
 * Aquí se comprueban las dos cosas: que la semántica es explícita y que ya no depende del
 * reloj de la máquina.
 */
describe('BP-12 · zona horaria', () => {
  let ctx: SuiteContext;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  /** Viaje con salida y llegada en la hora de pared indicada. */
  async function crearViaje(salida: string, llegada: string | null = null): Promise<number> {
    const result = await execute(
      `INSERT INTO trips (route_id, bus_id, departure_datetime, arrival_datetime, base_price, available_seats, status)
       VALUES (?, ?, ?, ?, 45.00, (SELECT capacity FROM buses WHERE id = ?), 'SCHEDULED')`,
      [ctx.fixtures.routeA, ctx.fixtures.busA, salida, llegada, ctx.fixtures.busA],
    );
    return result.insertId;
  }

  /** Ejecuta un fragmento con una zona de proceso distinta, en un Node aparte. */
  function conZona(tz: string, expresion: string): string {
    const raiz = path.resolve(__dirname, '..', '..');
    return execFileSync(
      process.execPath,
      [path.join(raiz, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '-e', expresion],
      { cwd: raiz, env: { ...process.env, TZ: tz }, encoding: 'utf8' },
    ).trim();
  }

  describe('Semántica: la hora guardada es la hora de Perú', () => {
    it('un viaje a las 08:00 sigue siendo las 08:00', async () => {
      const tripId = await crearViaje('2026-11-10 08:00:00', '2026-11-10 16:00:00');
      const fila = await queryOne<{ departure_datetime: string; arrival_datetime: string }>(
        'SELECT departure_datetime, arrival_datetime FROM trips WHERE id = ?',
        [tripId],
      );

      assert.equal(fila?.departure_datetime, '2026-11-10 08:00:00', 'la base no convierte nada');
      assert.equal(fila?.arrival_datetime, '2026-11-10 16:00:00');
    });

    it('uno a las 18:30 no se ve como 23:30 ni como 13:30', async () => {
      const tripId = await crearViaje('2026-11-10 18:30:00', '2026-11-11 02:15:00');
      const publico = await get(`/public/trips/${tripId}`);

      assert.equal(publico.status, 200);
      assert.equal(publico.body.data.departure_datetime, '2026-11-10 18:30:00');
      assert.equal(String(publico.body.data.departure_datetime).includes('23:30'), false);
      assert.equal(String(publico.body.data.departure_datetime).includes('13:30'), false);
      assert.equal(publico.body.data.arrival_datetime, '2026-11-11 02:15:00', 'llegada al día siguiente, intacta');
    });

    it('la API devuelve la fecha tal cual, sin marca de zona ni desplazamiento', async () => {
      const tripId = await crearViaje('2026-11-12 00:00:00', '2026-11-12 12:00:00');
      const detalle = await get(`/public/trips/${tripId}`);

      assert.match(String(detalle.body.data.departure_datetime), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      assert.equal(String(detalle.body.data.departure_datetime).endsWith('Z'), false, 'no se serializa como instante UTC');
    });

    for (const hora of ['00:00:00', '12:00:00', '23:59:00']) {
      it(`la hora de pared ${hora} se conserva de extremo a extremo`, async () => {
        const tripId = await crearViaje(`2026-11-15 ${hora}`, '2026-11-16 06:00:00');
        const detalle = await get(`/public/trips/${tripId}`);
        assert.equal(detalle.body.data.departure_datetime, `2026-11-15 ${hora}`);
      });
    }

    it('salida y llegada en días distintos no cruzan de día por la zona', async () => {
      const tripId = await crearViaje('2026-11-20 22:00:00', '2026-11-21 05:30:00');
      const fila = await queryOne<{ departure_datetime: string; arrival_datetime: string }>(
        'SELECT departure_datetime, arrival_datetime FROM trips WHERE id = ?',
        [tripId],
      );

      assert.ok(fila!.departure_datetime.startsWith('2026-11-20'));
      assert.ok(fila!.arrival_datetime.startsWith('2026-11-21'));
    });
  });

  describe('El reloj de la base y el del proceso coinciden', () => {
    it('la sesión de MySQL está fijada al desfase de Perú, no heredada del sistema', async () => {
      const fila = await queryOne<{ tz: string }>('SELECT @@session.time_zone AS tz');
      assert.equal(fila?.tz, peruUtcOffset(), 'la conexión fija su zona explícitamente');
      assert.notEqual(fila?.tz, 'SYSTEM', 'ya no depende de cómo esté configurada la máquina');
    });

    it('NOW() y la hora de negocio calculada en Node coinciden al minuto', async () => {
      const fila = await queryOne<{ n: string }>('SELECT NOW() AS n');
      assert.equal(String(fila?.n).slice(0, 16), businessNow().slice(0, 16));
    });

    it('escribir un objeto Date cae en la misma hora que NOW()', async () => {
      await execute('CREATE TEMPORARY TABLE tz_probe (etiqueta VARCHAR(10), dt DATETIME)');
      await execute('INSERT INTO tz_probe (etiqueta, dt) VALUES (?, ?)', ['objeto', new Date()]);
      await execute("INSERT INTO tz_probe (etiqueta, dt) VALUES ('sql', NOW())");

      const filas = await query<{ etiqueta: string; dt: string }>('SELECT etiqueta, dt FROM tz_probe ORDER BY etiqueta');
      const objeto = filas.find((f) => f.etiqueta === 'objeto')!.dt;
      const sql = filas.find((f) => f.etiqueta === 'sql')!.dt;

      // Antes de la corrección el objeto se guardaba en UTC: cinco horas por delante.
      assert.equal(objeto.slice(0, 16), sql.slice(0, 16), 'ambos deben ser la misma hora de pared');
    });
  });

  describe('El helper no depende de la zona del proceso', () => {
    it('la misma fecha produce el mismo instante en cuatro zonas distintas', () => {
      const expresion =
        "import {parseBusinessDateTime} from './src/utils/businessTime';" +
        "console.log(parseBusinessDateTime('2026-09-12 01:30:00').toISOString());";

      const resultados = ['America/Lima', 'UTC', 'Europe/Madrid', 'Asia/Tokyo'].map((tz) => conZona(tz, expresion));
      assert.equal(new Set(resultados).size, 1, `debería ser el mismo instante y salieron: ${resultados.join(' | ')}`);
      assert.equal(resultados[0], '2026-09-12T06:30:00.000Z', '01:30 en Perú son las 06:30 UTC');
    });

    it('el `new Date` ingenuo sí variaba, que era exactamente el fallo', () => {
      const expresion = "console.log(new Date('2026-09-12T01:30:00').toISOString());";
      const lima = conZona('America/Lima', expresion);
      const utc = conZona('UTC', expresion);

      assert.notEqual(lima, utc, 'la interpretación ingenua depende de la zona del proceso');
    });

    it('el desfase se resuelve desde la zona IANA y es estable', () => {
      assert.equal(PERU_TIME_ZONE, 'America/Lima');
      assert.equal(peruUtcOffset(new Date('2026-01-15T12:00:00Z')), '-05:00', 'enero');
      assert.equal(peruUtcOffset(new Date('2026-07-15T12:00:00Z')), '-05:00', 'julio: Perú no aplica horario de verano');
    });

    it('respeta una fecha que ya trae zona en vez de reinterpretarla', () => {
      assert.equal(parseBusinessDateTime('2026-09-12T06:30:00Z')!.toISOString(), '2026-09-12T06:30:00.000Z');
      assert.equal(parseBusinessDateTime('2026-09-12T01:30:00-05:00')!.toISOString(), '2026-09-12T06:30:00.000Z');
    });

    it('devuelve null ante un valor ausente o ilegible', () => {
      assert.equal(parseBusinessDateTime(null), null);
      assert.equal(parseBusinessDateTime(''), null);
      assert.equal(parseBusinessDateTime('no es una fecha'), null);
      assert.ok(Number.isNaN(businessTimeMs(null)));
    });
  });

  describe('El ciclo de vida del viaje no se adelanta ni se retrasa', () => {
    it('un viaje que sale dentro de una hora no se marca en curso', async () => {
      const tripId = await crearViaje(businessNow(new Date(Date.now() + 60 * 60_000)), businessNow(new Date(Date.now() + 5 * 3600_000)));
      await advanceTripLifecycle();

      const fila = await queryOne<{ status: string }>('SELECT status FROM trips WHERE id = ?', [tripId]);
      assert.equal(fila?.status, 'SCHEDULED', 'todavía no ha salido');
    });

    it('uno que salió hace un minuto sí pasa a IN_PROGRESS', async () => {
      const tripId = await crearViaje(businessNow(new Date(Date.now() - 60_000)), businessNow(new Date(Date.now() + 5 * 3600_000)));
      await advanceTripLifecycle();

      const fila = await queryOne<{ status: string }>('SELECT status FROM trips WHERE id = ?', [tripId]);
      assert.equal(fila?.status, 'IN_PROGRESS');
    });

    it('uno cuya llegada fue hace un minuto pasa a COMPLETED, y no antes', async () => {
      const sinLlegar = await crearViaje(businessNow(new Date(Date.now() - 3600_000)), businessNow(new Date(Date.now() + 60_000)));
      const llegado = await crearViaje(businessNow(new Date(Date.now() - 7200_000)), businessNow(new Date(Date.now() - 60_000)));

      await advanceTripLifecycle();

      assert.equal((await queryOne<{ status: string }>('SELECT status FROM trips WHERE id = ?', [sinLlegar]))?.status, 'IN_PROGRESS');
      assert.equal((await queryOne<{ status: string }>('SELECT status FROM trips WHERE id = ?', [llegado]))?.status, 'COMPLETED');
    });
  });

  describe('Reservas: expiración y cancelación con el reloj correcto', () => {
    /** Reserva pagada sobre un viaje que sale dentro de los segundos indicados. */
    async function reservaConSalidaEn(segundos: number) {
      const tripId = await crearViaje(businessNow(new Date(Date.now() + 30 * 86_400_000)), businessNow(new Date(Date.now() + 31 * 86_400_000)));
      const reserva = await post(
        '/bookings',
        { trip_id: tripId, seat_ids: [at(await freeSeats(tripId), 0).id] },
        ctx.sessions.customer.token,
      );
      assert.equal(reserva.status, 201);
      await post(`/bookings/${reserva.body.data.id}/pay`, { method: 'CASH' }, ctx.sessions.customer.token);

      await execute('UPDATE trips SET departure_datetime = ? WHERE id = ?', [
        businessNow(new Date(Date.now() + segundos * 1000)),
        tripId,
      ]);
      return reserva.body.data.id as number;
    }

    it('la retención de la reserva vence con la hora de la base', async () => {
      const tripId = await crearViaje(businessNow(new Date(Date.now() + 5 * 86_400_000)), businessNow(new Date(Date.now() + 6 * 86_400_000)));
      const reserva = await post(
        '/bookings',
        { trip_id: tripId, seat_ids: [at(await freeSeats(tripId), 0).id] },
        ctx.sessions.customer.token,
      );

      const fila = await queryOne<{ expires_at: string }>('SELECT expires_at FROM bookings WHERE id = ?', [reserva.body.data.id]);
      const margen = businessTimeMs(fila!.expires_at) - Date.now();
      assert.ok(margen > 13 * 60_000 && margen < 17 * 60_000, `la retención debía ser de ~15 min y fue de ${Math.round(margen / 60_000)} min`);

      // Y no expira antes de tiempo.
      await post('/bookings/expire', {}, ctx.sessions.admin.token);
      assert.equal((await queryOne<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [reserva.body.data.id]))?.status, 'PENDING');
    });

    it('a 24 h + 1 segundo se puede cancelar', async () => {
      const bookingId = await reservaConSalidaEn(24 * 3600 + 1);
      assert.equal((await post(`/bookings/${bookingId}/cancel`, {}, ctx.sessions.customer.token)).status, 200);
    });

    it('a 24 h exactas no', async () => {
      const bookingId = await reservaConSalidaEn(24 * 3600);
      assert.equal((await post(`/bookings/${bookingId}/cancel`, {}, ctx.sessions.customer.token)).status, 400);
    });

    it('a 24 h − 1 segundo tampoco', async () => {
      const bookingId = await reservaConSalidaEn(24 * 3600 - 1);
      assert.equal((await post(`/bookings/${bookingId}/cancel`, {}, ctx.sessions.customer.token)).status, 400);
    });

    it('la frontera no se desplaza cinco horas, que es lo que ocurriría con el reloj equivocado', async () => {
      // Si la comparación usara UTC en vez de hora de Perú, una salida a 19 h se leería como
      // si faltaran 24 y se permitiría cancelar. Debe rechazarse.
      const bookingId = await reservaConSalidaEn(19 * 3600);
      assert.equal((await post(`/bookings/${bookingId}/cancel`, {}, ctx.sessions.customer.token)).status, 400);
    });

    it('un viaje que ya partió no admite reservas nuevas', async () => {
      const tripId = await crearViaje(businessNow(new Date(Date.now() - 60_000)), businessNow(new Date(Date.now() + 3600_000)));
      const reserva = await post(
        '/bookings',
        { trip_id: tripId, seat_ids: [at(await freeSeats(tripId), 0).id] },
        ctx.sessions.customer.token,
      );
      assert.equal(reserva.status, 400);
      assert.match(String(reserva.body.message), /partió/);
    });
  });

  describe('Los timestamps técnicos siguen siendo coherentes', () => {
    it('created_at de una reserva cae en el mismo reloj que NOW()', async () => {
      const tripId = await crearViaje(businessNow(new Date(Date.now() + 10 * 86_400_000)), businessNow(new Date(Date.now() + 11 * 86_400_000)));
      const reserva = await post(
        '/bookings',
        { trip_id: tripId, seat_ids: [at(await freeSeats(tripId), 0).id] },
        ctx.sessions.customer.token,
      );

      const fila = await queryOne<{ created_at: string; ahora: string }>(
        'SELECT created_at, NOW() AS ahora FROM bookings WHERE id = ?',
        [reserva.body.data.id],
      );
      const diferencia = Math.abs(businessTimeMs(fila!.created_at) - businessTimeMs(fila!.ahora));
      assert.ok(diferencia < 60_000, `created_at y NOW() difieren en ${diferencia} ms`);
    });

    it('el código de recuperación caduca a los 15 minutos, no a las 5 horas', async () => {
      await post('/auth/forgot-password', { email: 'cliente@test.pe' });
      const fila = await queryOne<{ created_at: string; expires_at: string }>(
        'SELECT created_at, expires_at FROM password_reset_tokens WHERE user_id = ? ORDER BY id DESC LIMIT 1',
        [ctx.sessions.customer.user.id],
      );

      const minutos = (businessTimeMs(fila!.expires_at) - businessTimeMs(fila!.created_at)) / 60_000;
      assert.ok(minutos > 14 && minutos < 16, `la vigencia debía ser de 15 minutos y fue de ${minutos}`);
    });

    it('el alta por OAuth marca email_verified_at con la hora de Perú', async () => {
      const roleId = await queryOne<{ id: number }>("SELECT id FROM roles WHERE name = 'CUSTOMER'");
      const creado = await execute(
        `INSERT INTO users (role_id, first_name, last_name, email, password_hash, status, email_verified_at)
         VALUES (?, 'Zona', 'Horaria', ?, 'x', 'ACTIVE', ?)`,
        [roleId!.id, `tz-${Date.now()}@oauth.test`, businessNow()],
      );

      const fila = await queryOne<{ email_verified_at: string; ahora: string }>(
        'SELECT email_verified_at, NOW() AS ahora FROM users WHERE id = ?',
        [creado.insertId],
      );
      const diferencia = Math.abs(businessTimeMs(fila!.email_verified_at) - businessTimeMs(fila!.ahora));
      assert.ok(diferencia < 60_000, `debería coincidir con NOW() y difiere en ${Math.round(diferencia / 60_000)} min`);
    });

    it('una API Key caducada se detecta con la hora correcta', async () => {
      const creada = await post('/api-keys', { name: 'Zona', company_id: ctx.fixtures.companyA }, ctx.sessions.admin.token);
      const plain = creada.body.data.plain_key as string;

      // Caduca dentro de dos horas: con el reloj equivocado (cinco horas de desfase) se
      // habría considerado caducada.
      await execute('UPDATE api_keys SET expires_at = DATE_ADD(NOW(), INTERVAL 2 HOUR) WHERE id = ?', [creada.body.data.id]);
      assert.equal((await get('/integration/v1/trips', undefined)).status, 401);

      const { authenticateApiKey } = await import('../services/api-key.service');
      assert.ok(await authenticateApiKey(plain), 'una llave vigente no debe darse por caducada');

      await execute('UPDATE api_keys SET expires_at = DATE_SUB(NOW(), INTERVAL 2 HOUR) WHERE id = ?', [creada.body.data.id]);
      await assert.rejects(() => authenticateApiKey(plain), (error: { statusCode: number }) => error.statusCode === 401);
    });

    it('los flujos OAuth caducan con el mismo reloj', async () => {
      const inicio = await get('/auth/oauth/providers');
      assert.equal(inicio.status, 200, 'el módulo responde');

      await execute(
        `INSERT INTO oauth_flows (state_hash, provider, scope, mode, expires_at)
         VALUES (?, 'GOOGLE', 'CUSTOMER', 'LOGIN', DATE_ADD(NOW(), INTERVAL 10 MINUTE))`,
        [`hash-tz-${Date.now()}`],
      );
      const fila = await queryOne<{ created_at: string; expires_at: string }>(
        'SELECT created_at, expires_at FROM oauth_flows ORDER BY id DESC LIMIT 1',
      );
      const minutos = (businessTimeMs(fila!.expires_at) - businessTimeMs(fila!.created_at)) / 60_000;
      assert.ok(minutos > 9 && minutos < 11, `debía caducar en 10 minutos y salió ${minutos}`);
    });
  });
});
