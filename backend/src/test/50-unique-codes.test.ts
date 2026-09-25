import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { get, post, put } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { at, freeSeats } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * H-19 · los códigos de reserva y de cupón siguen siendo únicos sin sus índices duplicados.
 *
 * POR QUÉ EXISTE. La migración 012 elimina `idx_bookings_code` e `idx_coupons_code`, dos KEY
 * que repetían exactamente el UNIQUE de la misma columna. Lo que no puede perderse con ese
 * cambio es la unicidad, y ninguna prueba la comprobaba: ni que la base rechace un código
 * repetido, ni que la API lo traduzca a 409. Esto cubre solo eso y el esquema resultante.
 */
describe('H-19 · unicidad de códigos tras quitar los índices duplicados', () => {
  let ctx: SuiteContext;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  const indicesDe = (tabla: string) =>
    query<{ index_name: string; non_unique: number; columnas: string }>(
      `SELECT index_name, non_unique, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columnas
       FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = ?
       GROUP BY index_name, non_unique
       ORDER BY index_name`,
      [tabla],
    );

  const codigoDuplicado = async (sql: string, params: unknown[]) => {
    await assert.rejects(execute(sql, params), (error: { code?: string }) => error.code === 'ER_DUP_ENTRY');
  };

  // =====================================================================
  describe('Esquema', () => {
    it('1 · bookings conserva el UNIQUE de booking_code y ya no tiene el índice duplicado', async () => {
      const indices = await indicesDe('bookings');
      const nombres = indices.map((i) => i.index_name);

      const unico = indices.find((i) => i.index_name === 'booking_code');
      assert.ok(unico, 'el UNIQUE sigue existiendo');
      assert.equal(Number(unico.non_unique), 0);
      assert.equal(unico.columnas, 'booking_code');
      assert.equal(nombres.includes('idx_bookings_code'), false);
      assert.equal(indices.filter((i) => i.columnas === 'booking_code').length, 1, 'un solo índice sobre la columna');

      assert.deepEqual(
        [...nombres].sort(),
        [
          'PRIMARY', 'booking_code', 'fk_bookings_destination_stop', 'fk_bookings_origin_stop', 'idx_bookings_created_at',
          'idx_bookings_group', 'idx_bookings_status', 'idx_bookings_trip', 'idx_bookings_user',
        ].sort(),
        'no desapareció ningún otro índice',
      );
    });

    it('2 · coupons conserva el UNIQUE de code y ya no tiene el índice duplicado', async () => {
      const indices = await indicesDe('coupons');
      const nombres = indices.map((i) => i.index_name);

      const unico = indices.find((i) => i.index_name === 'code');
      assert.ok(unico, 'el UNIQUE sigue existiendo');
      assert.equal(Number(unico.non_unique), 0);
      assert.equal(unico.columnas, 'code');
      assert.equal(nombres.includes('idx_coupons_code'), false);
      assert.equal(indices.filter((i) => i.columnas === 'code').length, 1, 'un solo índice sobre la columna');
      assert.deepEqual(
        [...nombres].sort(),
        ['PRIMARY', 'code', 'idx_coupons_promotion', 'idx_coupons_status'].sort(),
        'no desapareció ningún otro índice',
      );
    });

    it('3 · las claves ajenas de ambas tablas siguen intactas', async () => {
      const fks = await query<{ constraint_name: string; delete_rule: string; update_rule: string }>(
        `SELECT constraint_name, delete_rule, update_rule FROM information_schema.referential_constraints
         WHERE constraint_schema = DATABASE() AND table_name IN ('bookings', 'coupons')
         ORDER BY constraint_name`,
      );
      assert.deepEqual(
        fks.map((fk) => `${fk.constraint_name}:${fk.delete_rule}:${fk.update_rule}`),
        [
          'fk_bookings_destination_stop:SET NULL:CASCADE',
          'fk_bookings_group:SET NULL:RESTRICT',
          'fk_bookings_origin_stop:SET NULL:CASCADE',
          'fk_bookings_trip:RESTRICT:CASCADE',
          'fk_bookings_user:RESTRICT:CASCADE',
          'fk_coupons_promotion:CASCADE:CASCADE',
        ],
      );
    });
  });

  // =====================================================================
  describe('Reservas', () => {
    it('4 · la base rechaza un booking_code repetido y la búsqueda por código sigue funcionando', async () => {
      const [asientoA, asientoB] = [at(await freeSeats(ctx.fixtures.tripA), 0), at(await freeSeats(ctx.fixtures.tripA), 1)];
      const reservar = (seatId: number) =>
        post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [seatId], passenger_email: 'cliente@test.pe' }, ctx.sessions.customer.token);
      const primera = await reservar(asientoA.id);
      const segunda = await reservar(asientoB.id);
      assert.equal(primera.status, 201, JSON.stringify(primera.body));
      assert.equal(segunda.status, 201, JSON.stringify(segunda.body));
      const codigo = String(primera.body.data.booking_code);
      assert.notEqual(codigo, String(segunda.body.data.booking_code), 'la API genera códigos distintos');

      await codigoDuplicado('UPDATE bookings SET booking_code = ? WHERE id = ?', [codigo, segunda.body.data.id]);
      assert.notEqual(
        (await queryOne<{ booking_code: string }>('SELECT booking_code FROM bookings WHERE id = ?', [segunda.body.data.id]))?.booking_code,
        codigo,
      );

      const exacta = await query<{ id: number }>('SELECT id FROM bookings WHERE booking_code = ?', [codigo]);
      assert.deepEqual(exacta.map((fila) => Number(fila.id)), [Number(primera.body.data.id)]);

      const busqueda = await get(`/bookings?search=${encodeURIComponent(codigo)}`, ctx.sessions.customer.token);
      assert.equal(busqueda.status, 200);
      assert.deepEqual((busqueda.body.data as Array<{ id: number }>).map((b) => Number(b.id)), [Number(primera.body.data.id)]);
    });
  });

  // =====================================================================
  describe('Cupones', () => {
    let promotionId = 0;

    before(async () => {
      const promo = await post(
        '/promotions',
        {
          company_id: ctx.fixtures.companyA,
          name: 'Promoción H-19',
          discount_type: 'PERCENTAGE',
          discount_value: 10,
          start_at: '2020-01-01 00:00:00',
          end_at: '2035-12-31 23:59:59',
          status: 'ACTIVE',
        },
        ctx.sessions.admin.token,
      );
      assert.equal(promo.status, 201, JSON.stringify(promo.body));
      promotionId = Number(promo.body.data.id);
    });

    const crearCupon = (code: string) =>
      post('/coupons', { promotion_id: promotionId, code, status: 'ACTIVE' }, ctx.sessions.admin.token);

    it('5 · la API rechaza con 409 un código de cupón repetido, también en distinta capitalización', async () => {
      assert.equal((await crearCupon('VERANO19')).status, 201);
      assert.equal((await crearCupon('VERANO19')).status, 409);
      assert.equal((await crearCupon('verano19')).status, 409, 'el código se guarda en mayúsculas');

      const filas = await queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM coupons WHERE code = 'VERANO19'");
      assert.equal(Number(filas?.n), 1);
    });

    it('6 · renombrar un cupón al código de otro se rechaza con 409 y no cambia nada', async () => {
      assert.equal((await crearCupon('INVIERNO19')).status, 201);
      const otro = await crearCupon('OTONO19');
      assert.equal(otro.status, 201);

      const res = await put(`/coupons/${otro.body.data.id}`, { code: 'INVIERNO19' }, ctx.sessions.admin.token);
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal((await queryOne<{ code: string }>('SELECT code FROM coupons WHERE id = ?', [otro.body.data.id]))?.code, 'OTONO19');
    });

    it('7 · la base rechaza un código repetido aunque se escriba sin pasar por la API', async () => {
      assert.equal((await crearCupon('PRIMAVERA19')).status, 201);
      await codigoDuplicado("INSERT INTO coupons (promotion_id, code, status) VALUES (?, 'PRIMAVERA19', 'ACTIVE')", [promotionId]);
      // La collation de la columna no distingue mayúsculas: también es un duplicado.
      await codigoDuplicado("INSERT INTO coupons (promotion_id, code, status) VALUES (?, 'primavera19', 'ACTIVE')", [promotionId]);
    });

    it('8 · un cupón se sigue aplicando por su código al reservar', async () => {
      assert.equal((await crearCupon('APLICA19')).status, 201);
      const asiento = at(await freeSeats(ctx.fixtures.tripA), 0);
      const reserva = await post(
        '/bookings',
        { trip_id: ctx.fixtures.tripA, seat_ids: [asiento.id], coupon_code: 'aplica19', passenger_email: 'cliente@test.pe' },
        ctx.sessions.customer.token,
      );
      assert.equal(reserva.status, 201, JSON.stringify(reserva.body));
      assert.ok(Number(reserva.body.data.discount_amount) > 0, 'el descuento del cupón se aplicó');
    });
  });
});
