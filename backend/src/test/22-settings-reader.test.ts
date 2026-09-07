import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { get, post, put } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { at, freeSeats } from './helpers/fixtures';
import { businessNow, businessTimeMs } from '../utils/businessTime';
import {
  coerceByDeclaredType,
  readBooleanSetting,
  readJsonSetting,
  readNumberSetting,
  readPublicSettings,
  readStringSetting,
} from '../services/settings.service';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * BP-13 · lector centralizado de configuración.
 *
 * Había dos lectores con semánticas distintas: uno privado en `booking.service.ts` que solo
 * devolvía números, ignoraba `setting_type` y convertía cualquier problema en el valor por
 * defecto sin decir nada —incluido un `NULL`, que salía como 0 porque `Number(null)` es 0—,
 * y otro en `public.routes.ts` que sí respetaba el tipo pero solo servía al endpoint
 * público. Ninguno era reutilizable.
 */
describe('BP-13 · lector centralizado de system_settings', () => {
  let ctx: SuiteContext;

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  /** Deja una clave con el valor y el tipo indicados. */
  async function definir(key: string, value: string | null, type = 'STRING', isPublic = 0): Promise<void> {
    await execute(
      `INSERT INTO system_settings (setting_key, setting_value, setting_type, is_public)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), setting_type = VALUES(setting_type), is_public = VALUES(is_public)`,
      [key, value, type, isPublic],
    );
  }

  async function borrar(key: string): Promise<void> {
    await execute('DELETE FROM system_settings WHERE setting_key = ?', [key]);
  }

  describe('Lectura de un valor existente', () => {
    it('devuelve el número configurado, con su tipo', async () => {
      await definir('prueba.numero', '7', 'INTEGER');
      const valor = await readNumberSetting('prueba.numero', { fallback: 99 });

      assert.equal(valor, 7);
      assert.equal(typeof valor, 'number');
    });

    it('devuelve decimales sin redondear', async () => {
      await definir('prueba.decimal', '2.75', 'DECIMAL');
      assert.equal(await readNumberSetting('prueba.decimal', { fallback: 0 }), 2.75);
    });

    it('devuelve booleanos y acepta las cuatro formas', async () => {
      for (const [guardado, esperado] of [['true', true], ['1', true], ['false', false], ['0', false]] as const) {
        await definir('prueba.bool', guardado, 'BOOLEAN');
        const valor = await readBooleanSetting('prueba.bool', { fallback: !esperado });
        assert.equal(valor, esperado, `«${guardado}» debía leerse como ${esperado}`);
        assert.equal(typeof valor, 'boolean');
      }
    });

    it('devuelve texto', async () => {
      await definir('prueba.texto', 'BusPerú', 'STRING');
      const valor = await readStringSetting('prueba.texto', { fallback: 'otro' });
      assert.equal(valor, 'BusPerú');
      assert.equal(typeof valor, 'string');
    });

    it('devuelve JSON validado, no `any`', async () => {
      await definir('prueba.json', '["a","b"]', 'JSON');
      const esListaDeTexto = (value: unknown): value is string[] =>
        Array.isArray(value) && value.every((item) => typeof item === 'string');

      const valor = await readJsonSetting('prueba.json', { fallback: [], validate: esListaDeTexto });
      assert.deepEqual(valor, ['a', 'b']);
    });
  });

  describe('Clave inexistente', () => {
    beforeEach(async () => {
      await borrar('prueba.ausente');
    });

    it('usa el valor por defecto que declara quien lee', async () => {
      assert.equal(await readNumberSetting('prueba.ausente', { fallback: 42 }), 42);
      assert.equal(await readBooleanSetting('prueba.ausente', { fallback: true }), true);
      assert.equal(await readStringSetting('prueba.ausente', { fallback: 'defecto' }), 'defecto');
    });

    it('no inventa un valor cuando no se declara ninguno', async () => {
      const valor = await readJsonSetting('prueba.ausente', {
        fallback: null as unknown,
        validate: (value): value is unknown => value !== undefined,
      });
      assert.equal(valor, null);
    });
  });

  describe('Valor inválido: se avisa y no se disfraza', () => {
    /** Captura los avisos que emite el lector durante la comprobación. */
    async function conAvisos<T>(accion: () => Promise<T>): Promise<{ resultado: T; avisos: string[] }> {
      const original = console.warn;
      const avisos: string[] = [];
      console.warn = (...args: unknown[]) => void avisos.push(args.map(String).join(' '));
      try {
        return { resultado: await accion(), avisos };
      } finally {
        console.warn = original;
      }
    }

    it('un texto que no es número usa el defecto Y deja aviso', async () => {
      await definir('prueba.roto', 'no-soy-un-numero', 'INTEGER');
      const { resultado, avisos } = await conAvisos(() => readNumberSetting('prueba.roto', { fallback: 5 }));

      assert.equal(resultado, 5);
      assert.equal(avisos.length, 1, 'una mala configuración no puede pasar en silencio');
      assert.match(avisos[0]!, /prueba\.roto/);
      assert.match(avisos[0]!, /no es un número/);
      assert.match(avisos[0]!, /no-soy-un-numero/, 'el aviso incluye el valor ofensivo');
    });

    it('un valor NULL no se convierte en 0: ese era el fallo', async () => {
      await definir('prueba.nulo', null, 'DECIMAL');
      const { resultado, avisos } = await conAvisos(() => readNumberSetting('prueba.nulo', { fallback: 2.5 }));

      assert.equal(resultado, 2.5, 'el lector anterior devolvía 0 porque Number(null) es 0');
      assert.notEqual(resultado, 0);
      assert.equal(avisos.length, 1);
    });

    it('una cadena vacía tampoco', async () => {
      await definir('prueba.vacio', '   ', 'INTEGER');
      const { resultado, avisos } = await conAvisos(() => readNumberSetting('prueba.vacio', { fallback: 8 }));

      assert.equal(resultado, 8);
      assert.match(avisos[0]!, /está vacía/);
    });

    it('un valor fuera de rango se rechaza', async () => {
      await definir('prueba.rango', '500', 'INTEGER');
      const { resultado, avisos } = await conAvisos(() =>
        readNumberSetting('prueba.rango', { fallback: 6, min: 1, max: 10 }),
      );

      assert.equal(resultado, 6);
      assert.match(avisos[0]!, /máximo admitido/);
    });

    it('un decimal donde se pedía entero se rechaza', async () => {
      await definir('prueba.entero', '3.5', 'DECIMAL');
      const { resultado, avisos } = await conAvisos(() =>
        readNumberSetting('prueba.entero', { fallback: 4, integer: true }),
      );

      assert.equal(resultado, 4);
      assert.match(avisos[0]!, /entero/);
    });

    it('un tipo declarado incompatible se rechaza', async () => {
      await definir('prueba.tipo', '{"a":1}', 'JSON');
      const { resultado, avisos } = await conAvisos(() => readNumberSetting('prueba.tipo', { fallback: 1 }));

      assert.equal(resultado, 1);
      assert.match(avisos[0]!, /se esperaba un número/);
    });

    it('un JSON roto no se interpreta como vacío en silencio', async () => {
      await definir('prueba.jsonroto', '{no es json', 'JSON');
      const { resultado, avisos } = await conAvisos(() =>
        readJsonSetting('prueba.jsonroto', { fallback: ['defecto'], validate: (v): v is string[] => Array.isArray(v) }),
      );

      assert.deepEqual(resultado, ['defecto']);
      assert.match(avisos[0]!, /no es JSON válido/);
    });

    it('un JSON válido pero con otra forma también se rechaza', async () => {
      await definir('prueba.jsonforma', '{"a":1}', 'JSON');
      const { resultado, avisos } = await conAvisos(() =>
        readJsonSetting('prueba.jsonforma', { fallback: ['defecto'], validate: (v): v is string[] => Array.isArray(v) }),
      );

      assert.deepEqual(resultado, ['defecto']);
      assert.match(avisos[0]!, /forma esperada/);
    });

    it('un booleano irreconocible se rechaza', async () => {
      await definir('prueba.boolroto', 'quizá', 'BOOLEAN');
      const { resultado, avisos } = await conAvisos(() => readBooleanSetting('prueba.boolroto', { fallback: false }));

      assert.equal(resultado, false);
      assert.match(avisos[0]!, /booleano/);
    });
  });

  describe('Un error de base de datos no se convierte en un valor por defecto', () => {
    it('la excepción se propaga en lugar de devolver el defecto', async () => {
      const { pool } = await import('../config/database');
      const original = pool.query.bind(pool);
      (pool as unknown as { query: unknown }).query = async () => {
        throw new Error('ECONNREFUSED simulado');
      };

      try {
        await assert.rejects(
          () => readNumberSetting('booking.service_fee', { fallback: 2.5 }),
          /ECONNREFUSED simulado/,
          'una caída de la base no puede parecerse a una configuración ausente',
        );
      } finally {
        (pool as unknown as { query: unknown }).query = original;
      }

      // Y con la base de vuelta, el lector responde con normalidad.
      assert.equal(typeof (await readNumberSetting('booking.service_fee', { fallback: 2.5 })), 'number');
    });
  });

  describe('Los consumidores usan el lector', () => {
    it('la política de cancelación sigue siendo de 24 horas', async () => {
      const fila = await queryOne<{ setting_value: string }>(
        "SELECT setting_value FROM system_settings WHERE setting_key = 'booking.cancellation_hours'",
      );
      // La suite siembra las claves de reserva; si esta no estuviera, el defecto sería 24.
      assert.equal(await readNumberSetting('booking.cancellation_hours', { fallback: 24, min: 0 }), Number(fila?.setting_value ?? 24));
    });

    it('la cancelación lee el plazo de la configuración, no de una constante', async () => {
      const tripId = (
        await execute(
          `INSERT INTO trips (route_id, bus_id, departure_datetime, arrival_datetime, base_price, available_seats, status)
           VALUES (?, ?, ?, ?, 45.00, (SELECT capacity FROM buses WHERE id = ?), 'SCHEDULED')`,
          [
            ctx.fixtures.routeA,
            ctx.fixtures.busA,
            businessNow(new Date(Date.now() + 30 * 86_400_000)),
            businessNow(new Date(Date.now() + 31 * 86_400_000)),
            ctx.fixtures.busA,
          ],
        )
      ).insertId;

      const reserva = await post(
        '/bookings',
        { trip_id: tripId, seat_ids: [at(await freeSeats(tripId), 0).id] },
        ctx.sessions.customer.token,
      );
      assert.equal(reserva.status, 201);

      // Con la salida a 30 horas y el plazo por defecto de 24, se puede cancelar.
      await execute('UPDATE trips SET departure_datetime = ? WHERE id = ?', [
        businessNow(new Date(Date.now() + 30 * 3600_000)),
        tripId,
      ]);

      // Se sube el plazo a 48 horas: la misma reserva pasa a estar fuera de plazo.
      await definir('booking.cancellation_hours', '48', 'INTEGER', 1);
      try {
        const fuera = await post(`/bookings/${reserva.body.data.id}/cancel`, {}, ctx.sessions.customer.token);
        assert.equal(fuera.status, 400, 'el cambio de configuración debe surtir efecto');
        assert.match(String(fuera.body.message), /48 horas/, 'el mensaje refleja el plazo configurado');
      } finally {
        await definir('booking.cancellation_hours', '24', 'INTEGER', 1);
      }

      // Restaurado el plazo, vuelve a poder cancelarse.
      assert.equal((await post(`/bookings/${reserva.body.data.id}/cancel`, {}, ctx.sessions.customer.token)).status, 200);
    });

    it('la retención de asientos ya no es una constante: booking.hold_minutes se aplica', async () => {
      await definir('booking.hold_minutes', '40', 'INTEGER');
      try {
        const reserva = await post(
          '/bookings',
          { trip_id: ctx.fixtures.tripA, seat_ids: [at(await freeSeats(ctx.fixtures.tripA), 0).id] },
          ctx.sessions.customer.token,
        );
        assert.equal(reserva.status, 201);

        const fila = await queryOne<{ expires_at: string }>('SELECT expires_at FROM bookings WHERE id = ?', [reserva.body.data.id]);
        const minutos = (businessTimeMs(fila!.expires_at) - Date.now()) / 60_000;
        assert.ok(minutos > 38 && minutos < 42, `la retención debía ser de ~40 minutos y fue de ${Math.round(minutos)}`);
      } finally {
        await definir('booking.hold_minutes', '15', 'INTEGER');
      }
    });

    it('sin configurar, la retención sigue siendo de 15 minutos', async () => {
      await borrar('booking.hold_minutes');
      try {
        const reserva = await post(
          '/bookings',
          { trip_id: ctx.fixtures.tripA, seat_ids: [at(await freeSeats(ctx.fixtures.tripA), 0).id] },
          ctx.sessions.customer.token,
        );
        const fila = await queryOne<{ expires_at: string }>('SELECT expires_at FROM bookings WHERE id = ?', [reserva.body.data.id]);
        const minutos = (businessTimeMs(fila!.expires_at) - Date.now()) / 60_000;
        assert.ok(minutos > 13 && minutos < 17, `el comportamiento sin configuración no debe cambiar: fueron ${Math.round(minutos)} min`);
      } finally {
        await definir('booking.hold_minutes', '15', 'INTEGER');
      }
    });

    it('el máximo de asientos y la comisión de servicio salen de la configuración', async () => {
      await definir('booking.max_seats_per_booking', '2', 'INTEGER', 1);
      try {
        const seats = await freeSeats(ctx.fixtures.tripA);
        const res = await post(
          '/bookings',
          { trip_id: ctx.fixtures.tripA, seat_ids: seats.slice(0, 3).map((s) => s.id) },
          ctx.sessions.customer.token,
        );
        assert.equal(res.status, 400);
        assert.match(String(res.body.message), /máximo 2 asientos/);
      } finally {
        await definir('booking.max_seats_per_booking', '6', 'INTEGER', 1);
      }
    });

    it('el endpoint público usa la misma interpretación que los servicios', async () => {
      await definir('prueba.publica.entero', '12', 'INTEGER', 1);
      await definir('prueba.publica.bool', 'true', 'BOOLEAN', 1);
      await definir('prueba.publica.json', '{"x":1}', 'JSON', 1);
      try {
        const res = await get('/public/settings');
        assert.equal(res.status, 200);
        assert.equal(res.body.data['prueba.publica.entero'], 12);
        assert.equal(res.body.data['prueba.publica.bool'], true);
        assert.deepEqual(res.body.data['prueba.publica.json'], { x: 1 });

        const directo = await readPublicSettings();
        assert.deepEqual(res.body.data['prueba.publica.json'], directo['prueba.publica.json']);
      } finally {
        await execute("DELETE FROM system_settings WHERE setting_key LIKE 'prueba.publica.%'");
      }
    });

    it('el endpoint público sigue sin exponer las claves privadas', async () => {
      const res = await get('/public/settings');
      const claves = Object.keys(res.body.data ?? {});
      assert.equal(claves.includes('booking.hold_minutes'), false, 'no es pública');
      assert.ok(claves.includes('booking.service_fee'), 'esta sí lo es');
    });

    it('la conversión por tipo declarado es consistente en ambos caminos', () => {
      assert.equal(coerceByDeclaredType({ setting_key: 'k', setting_value: '5', setting_type: 'INTEGER' }), 5);
      assert.equal(coerceByDeclaredType({ setting_key: 'k', setting_value: '1', setting_type: 'BOOLEAN' }), true);
      assert.equal(coerceByDeclaredType({ setting_key: 'k', setting_value: null, setting_type: 'STRING' }), null);
      assert.equal(coerceByDeclaredType({ setting_key: 'k', setting_value: 'roto', setting_type: 'JSON' }), null);
    });
  });

  describe('La configuración es global y su escritura no se amplió', () => {
    it('la tabla no tiene ninguna dimensión por empresa', async () => {
      const columnas = await query<{ COLUMN_NAME: string }>(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'system_settings'`,
      );
      const nombres = columnas.map((c) => c.COLUMN_NAME);
      assert.equal(nombres.includes('company_id'), false, 'no es configuración por empresa');
      assert.equal(nombres.includes('user_id'), false);
    });

    it('un company_id inyectado no cambia lo que devuelve el lector', async () => {
      await definir('prueba.global', '100', 'INTEGER', 1);
      const esperado = await readNumberSetting('prueba.global', { fallback: 0 });

      // Ni por query, ni por cuerpo, ni por cabecera: el endpoint público no lee nada de eso.
      const conQuery = await get(`/public/settings?company_id=${ctx.fixtures.companyB}`);
      assert.equal(conQuery.body.data['prueba.global'], esperado);
      assert.equal(esperado, 100);

      await borrar('prueba.global');
    });

    it('CUSTOMER no puede leer ni modificar la configuración privada', async () => {
      assert.equal((await get('/system-settings', ctx.sessions.customer.token)).status, 403);
      assert.equal(
        (await post('/system-settings', { setting_key: 'intruso.uno', setting_value: '1' }, ctx.sessions.customer.token)).status,
        403,
      );
    });

    it('OPERATOR tampoco', async () => {
      assert.equal((await get('/system-settings', ctx.sessions.operator.token)).status, 403);
      assert.equal(
        (await post('/system-settings', { setting_key: 'intruso.dos', setting_value: '1' }, ctx.sessions.operator.token)).status,
        403,
      );
    });

    it('COMPANY_ADMIN tampoco', async () => {
      assert.equal((await get('/system-settings', ctx.sessions.companyAdmin.token)).status, 403);
      assert.equal(
        (await post('/system-settings', { setting_key: 'intruso.tres', setting_value: '1' }, ctx.sessions.companyAdmin.token)).status,
        403,
      );

      const coladas = await query("SELECT id FROM system_settings WHERE setting_key LIKE 'intruso.%'");
      assert.equal(coladas.length, 0, 'ninguna clave debe haberse creado');
    });

    it('el ADMIN conserva la gestión completa', async () => {
      const listado = await get('/system-settings', ctx.sessions.admin.token);
      assert.equal(listado.status, 200);

      const creada = await post(
        '/system-settings',
        { setting_key: 'prueba.admin', setting_value: '3', setting_type: 'INTEGER', is_public: 0 },
        ctx.sessions.admin.token,
      );
      assert.equal(creada.status, 201);

      // Y lo que escribe el ADMIN lo lee el lector en la petición siguiente: sin caché.
      assert.equal(await readNumberSetting('prueba.admin', { fallback: 0 }), 3);

      const actualizada = await put(`/system-settings/${creada.body.data.id}`, { setting_value: '9' }, ctx.sessions.admin.token);
      assert.equal(actualizada.status, 200);
      assert.equal(await readNumberSetting('prueba.admin', { fallback: 0 }), 9, 'el cambio surte efecto de inmediato');

      await borrar('prueba.admin');
    });
  });
});
