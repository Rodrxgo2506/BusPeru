import './helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { execute, queryOne } from '../config/database';
import { post } from './helpers/api';
import { at, freeSeats, login, type Session } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * F17C-SEC-11C · el personal de una empresa no vende los viajes de otra.
 *
 * EL DEFECTO. `POST /bookings` no comprobaba a qué empresa pertenecía quien compraba. Un
 * COMPANY_ADMIN o un OPERATOR de la empresa B podía reservar un asiento de un viaje de la empresa
 * A: la transacción se confirmaba —asiento retenido 15 minutos, `available_seats` descontado— y
 * después la ruta intentaba devolver la reserva con el alcance de lectura, que para el personal
 * es su propia empresa. La reserva le resultaba invisible y la API respondía
 * `404 "Reserva no encontrada"` a una operación que SÍ había dejado efectos. F17C-SEC-11B lo
 * demostró de forma determinista; era además la causa del fallo intermitente del caso 16 de la
 * suite 25, cuando ese comprador ganaba la carrera.
 *
 * LO QUE SE EXIGE AHORA. El rechazo ocurre ANTES de cualquier escritura: ni reserva, ni asiento,
 * ni cupo, ni pago, ni movimiento. Cada caso de rechazo compara una foto completa de la base
 * antes y después. Y la frontera se aplica solo al personal de empresa: el cliente y el
 * administrador de la plataforma conservan exactamente lo que podían hacer.
 */

type Foto = Record<string, number>;

describe('SEC-11C · frontera entre empresas al crear reservas', () => {
  let ctx: SuiteContext;
  let operatorB: Session;
  /** Tercer viaje de la empresa A (mismo bus, otra fecha), para los itinerarios. */
  let otroViajeA = 0;

  before(async () => {
    ctx = await prepareSuite();

    // Las fixtures traen un OPERATOR solo en la empresa A: se crea su homólogo en la B.
    const rol = await queryOne<{ id: number }>("SELECT id FROM roles WHERE name = 'OPERATOR'");
    const hash = (await queryOne<{ h: string }>('SELECT password_hash AS h FROM users WHERE id = ?', [ctx.fixtures.users.operator]))!.h;
    const { insertId } = await execute(
      `INSERT INTO users (role_id, first_name, last_name, email, phone, password_hash, status, email_verified_at)
       VALUES (?, 'Otto', 'EmpresaB', 'operador-b@test.pe', '999999999', ?, 'ACTIVE', NOW())`,
      [rol!.id, hash],
    );
    await execute('INSERT INTO company_users (company_id, user_id, position) VALUES (?, ?, ?)', [ctx.fixtures.companyB, insertId, 'Operaciones']);
    operatorB = await login('operador-b@test.pe');

    otroViajeA = (await queryOne<{ id: number }>(
      'SELECT id FROM trips WHERE route_id = ? AND id <> ? ORDER BY id LIMIT 1', [ctx.fixtures.routeA, ctx.fixtures.tripA],
    ))!.id;
  });

  after(async () => {
    await execute('DELETE FROM company_users WHERE user_id IN (SELECT id FROM users WHERE email = ?)', ['operador-b@test.pe']);
    await execute('DELETE FROM users WHERE email = ?', ['operador-b@test.pe']);
    await teardownSuite();
  });

  beforeEach(async () => {
    for (const tabla of ['booking_seats', 'refunds', 'financial_transactions', 'payments', 'bookings', 'booking_groups']) {
      await execute(`DELETE FROM ${tabla}`);
    }
    await execute('UPDATE trips SET available_seats = (SELECT capacity FROM buses WHERE id = trips.bus_id)');
  });

  /** Todo lo que una reserva podría dejar en la base. Solo tablas que el flujo usa de verdad. */
  async function foto(): Promise<Foto> {
    const contar = async (tabla: string) => Number((await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${tabla}`))?.n);
    const cupo = async (viaje: number) =>
      Number((await queryOne<{ n: number }>('SELECT available_seats AS n FROM trips WHERE id = ?', [viaje]))?.n);
    return {
      bookings: await contar('bookings'),
      booking_seats: await contar('booking_seats'),
      booking_groups: await contar('booking_groups'),
      payments: await contar('payments'),
      financial_transactions: await contar('financial_transactions'),
      refunds: await contar('refunds'),
      settlement_items: await contar('settlement_items'),
      cupo_viaje_A: await cupo(ctx.fixtures.tripA),
      cupo_otro_viaje_A: await cupo(otroViajeA),
      cupo_viaje_B: await cupo(ctx.fixtures.tripB),
    };
  }

  const comprar = async (viaje: number, token: string, extra: Record<string, unknown> = {}) => {
    const asiento = at(await freeSeats(viaje), 0).id;
    return post('/bookings', { trip_id: viaje, seat_ids: [asiento], passenger_email: 'cliente@test.pe', ...extra }, token);
  };

  /* ====================================================== el bug original */
  describe('el personal de otra empresa no reserva', () => {
    /**
     * REGRESIÓN DEL BUG ORIGINAL. Antes: 404 DESPUÉS de crear la reserva. Ahora: 404 ANTES de
     * escribir nada. La foto de la base tiene que ser idéntica, campo por campo.
     */
    it('company staff cannot create booking on another company\'s trip · COMPANY_ADMIN de la B sobre un viaje de la A', async () => {
      const antes = await foto();

      const r = await comprar(ctx.fixtures.tripA, ctx.sessions.companyAdminB.token);

      assert.equal(r.status, 404, JSON.stringify(r.body));
      assert.deepEqual(await foto(), antes, 'un rechazo no puede dejar ni una fila ni un asiento descontado');
    });

    it('lo mismo para un OPERATOR de la B sobre un viaje de la A', async () => {
      const antes = await foto();

      const r = await comprar(ctx.fixtures.tripA, operatorB.token);

      assert.equal(r.status, 404, JSON.stringify(r.body));
      assert.deepEqual(await foto(), antes);
    });

    it('y en sentido contrario: el personal de la A no reserva un viaje de la B', async () => {
      for (const token of [ctx.sessions.companyAdmin.token, ctx.sessions.operator.token]) {
        const antes = await foto();
        const r = await comprar(ctx.fixtures.tripB, token);
        assert.equal(r.status, 404, JSON.stringify(r.body));
        assert.deepEqual(await foto(), antes);
      }
    });

    it('el asiento que intentó tomar sigue a la venta para quien sí puede comprarlo', async () => {
      const asiento = at(await freeSeats(ctx.fixtures.tripA), 0).id;
      await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [asiento], passenger_email: 'cliente@test.pe' }, ctx.sessions.companyAdminB.token);

      const cliente = await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [asiento], passenger_email: 'cliente@test.pe' }, ctx.sessions.customer.token);

      assert.equal(cliente.status, 201, 'antes, el intento ajeno dejaba el asiento retenido 15 minutos y esto era un 409');
    });

    it('la respuesta no distingue «es de otra empresa» de «no existe»', async () => {
      const ajeno = await comprar(ctx.fixtures.tripA, ctx.sessions.companyAdminB.token);
      const inexistente = await post('/bookings', { trip_id: 999999, seat_ids: [1], passenger_email: 'cliente@test.pe' }, ctx.sessions.companyAdminB.token);

      assert.equal(ajeno.status, inexistente.status);
      assert.equal(ajeno.body.message, inexistente.body.message, 'el mensaje no puede revelar que el viaje existe');
      assert.ok(!/empresa/i.test(String(ajeno.body.message)), 'ni mencionar a otra empresa');
    });

    it('mandar company_id en el cuerpo no abre la frontera', async () => {
      const antes = await foto();

      const r = await comprar(ctx.fixtures.tripA, ctx.sessions.companyAdminB.token, { company_id: ctx.fixtures.companyA });

      assert.ok(r.status === 404 || r.status === 400 || r.status === 422, `la empresa sale de la sesión, no del cuerpo (${r.status})`);
      assert.deepEqual(await foto(), antes);
    });
  });

  /* ====================================================== itinerarios */
  describe('la compra de varios tramos aplica la misma frontera', () => {
    /**
     * El caso más exigente para la atomicidad: el PRIMER tramo es un viaje propio (legítimo) y
     * el segundo es ajeno. El primero llega a crearse dentro de la transacción y el segundo se
     * rechaza, así que el ROLLBACK tiene que deshacer también el primero y la fila del grupo.
     */
    it('un itinerario con un tramo propio y otro ajeno se rechaza entero y no deja nada', async () => {
      const antes = await foto();
      const propio = at(await freeSeats(ctx.fixtures.tripB), 0).id;
      const ajeno = at(await freeSeats(ctx.fixtures.tripA), 0).id;

      const r = await post('/bookings/itineraries', {
        trip_type: 'MULTI_CITY',
        segments: [
          { trip_id: ctx.fixtures.tripB, seat_ids: [propio] },
          { trip_id: ctx.fixtures.tripA, seat_ids: [ajeno] },
        ],
        passenger_email: 'cliente@test.pe',
      }, ctx.sessions.companyAdminB.token);

      assert.equal(r.status, 404, `debe rechazarse por la frontera, no por otra validación: ${JSON.stringify(r.body)}`);
      assert.deepEqual(await foto(), antes, 'ni el tramo propio ni el grupo pueden sobrevivir al rechazo');
    });

    it('un itinerario íntegramente ajeno tampoco deja el grupo creado', async () => {
      const antes = await foto();

      const r = await post('/bookings/itineraries', {
        trip_type: 'MULTI_CITY',
        segments: [
          { trip_id: ctx.fixtures.tripA, seat_ids: [at(await freeSeats(ctx.fixtures.tripA), 0).id] },
          { trip_id: otroViajeA, seat_ids: [at(await freeSeats(otroViajeA), 0).id] },
        ],
        passenger_email: 'cliente@test.pe',
      }, ctx.sessions.companyAdminB.token);

      assert.equal(r.status, 404, JSON.stringify(r.body));
      assert.deepEqual(await foto(), antes);
    });
  });

  /* ====================================================== lo legítimo no cambia */
  describe('lo que ya se podía hacer sigue funcionando', () => {
    const comprobarCompra = async (viaje: number, token: string) => {
      const cupoAntes = Number((await queryOne<{ n: number }>('SELECT available_seats AS n FROM trips WHERE id = ?', [viaje]))?.n);

      const r = await comprar(viaje, token);

      assert.equal(r.status, 201, JSON.stringify(r.body));
      const reserva = await queryOne<{ status: string; asientos: number }>(
        'SELECT bk.status, (SELECT COUNT(*) FROM booking_seats WHERE booking_id = bk.id) AS asientos FROM bookings bk WHERE bk.id = ?',
        [r.body.data.id],
      );
      assert.equal(reserva?.status, 'PENDING');
      assert.equal(Number(reserva?.asientos), 1, 'el asiento queda retenido');
      assert.equal(
        Number((await queryOne<{ n: number }>('SELECT available_seats AS n FROM trips WHERE id = ?', [viaje]))?.n),
        cupoAntes - 1,
        'y el cupo baja exactamente en uno',
      );
    };

    it('el COMPANY_ADMIN reserva en su propia empresa', async () => {
      await comprobarCompra(ctx.fixtures.tripA, ctx.sessions.companyAdmin.token);
    });

    it('el OPERATOR reserva en su propia empresa', async () => {
      await comprobarCompra(ctx.fixtures.tripA, ctx.sessions.operator.token);
    });

    it('el OPERATOR de la B también, en la suya', async () => {
      await comprobarCompra(ctx.fixtures.tripB, operatorB.token);
    });

    it('el CUSTOMER sigue comprando viajes de cualquier empresa', async () => {
      await comprobarCompra(ctx.fixtures.tripA, ctx.sessions.customer.token);
      await comprobarCompra(ctx.fixtures.tripB, ctx.sessions.customer.token);
    });

    it('el ADMIN conserva su alcance sobre todas las empresas', async () => {
      await comprobarCompra(ctx.fixtures.tripA, ctx.sessions.admin.token);
      await comprobarCompra(ctx.fixtures.tripB, ctx.sessions.admin.token);
    });
  });

  /* ====================================================== la carrera que destapó el bug */
  describe('la carrera del caso 16 de la suite 25', () => {
    /**
     * Seis compradores simultáneos, uno de ellos de otra empresa. Antes, cuando ese comprador
     * ganaba, su compra se confirmaba y recibía un 404. Ahora nunca puede ganar: su intento se
     * rechaza sin tocar el asiento, y los otros cinco compiten entre ellos como siempre.
     */
    it('el comprador ajeno nunca retiene el asiento y los legítimos siguen compitiendo', async () => {
      for (let ronda = 1; ronda <= 20; ronda += 1) {
        for (const tabla of ['booking_seats', 'payments', 'bookings']) await execute(`DELETE FROM ${tabla}`);
        await execute('UPDATE trips SET available_seats = (SELECT capacity FROM buses WHERE id = trips.bus_id)');
        const asiento = at(await freeSeats(ctx.fixtures.tripA), 0).id;
        const cupoAntes = Number((await queryOne<{ n: number }>('SELECT available_seats AS n FROM trips WHERE id = ?', [ctx.fixtures.tripA]))?.n);

        const tokens = [
          ctx.sessions.customer.token,
          ctx.sessions.companyAdmin.token,
          ctx.sessions.admin.token,
          ctx.sessions.operator.token,
          ctx.sessions.companyAdminB.token,
          ctx.sessions.customer.token,
        ];
        const r = await Promise.all(tokens.map((token) =>
          post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [asiento], passenger_email: 'cliente@test.pe' }, token)));

        assert.equal(r[4]!.status, 404, `ronda ${ronda}: el comprador ajeno siempre recibe 404`);
        assert.equal(r.filter((x) => x.status === 201).length, 1, `ronda ${ronda}: ${JSON.stringify(r.map((x) => x.status))}`);
        assert.equal(r.filter((x) => x.status === 409).length, 4, `ronda ${ronda}: los otros cuatro legítimos pierden con 409`);

        const activas = await queryOne<{ n: number; ajenas: number }>(
          `SELECT COUNT(*) AS n, SUM(bk.user_id = ?) AS ajenas FROM bookings bk JOIN booking_seats bs ON bs.booking_id = bk.id
           WHERE bs.trip_id = ? AND bs.seat_id = ? AND bk.status IN ('PENDING', 'CONFIRMED')`,
          [ctx.sessions.companyAdminB.user.id, ctx.fixtures.tripA, asiento],
        );
        assert.equal(Number(activas?.n), 1, `ronda ${ronda}: una sola reserva activa, nunca doble venta`);
        assert.equal(Number(activas?.ajenas ?? 0), 0, `ronda ${ronda}: ninguna es del comprador ajeno`);
        assert.equal(
          Number((await queryOne<{ n: number }>('SELECT available_seats AS n FROM trips WHERE id = ?', [ctx.fixtures.tripA]))?.n),
          cupoAntes - 1,
          `ronda ${ronda}: el cupo baja exactamente en uno`,
        );
      }
    });
  });
});
