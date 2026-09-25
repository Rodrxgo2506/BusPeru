import './helpers/testEnv';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { del, get, post, put, startTestServer } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { env } from '../config/env';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * FASE 17B · migración 016: datos de la ficha de destino y relación con la ciudad.
 *
 * Todo sobre `busperu_test`. Las imágenes van al almacén de pruebas, que la suite vacía.
 */

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const publicRoot = () => path.resolve(process.cwd(), env.storage.dir, 'public');
const onDisk = (reference: string) => fs.existsSync(path.resolve(process.cwd(), env.storage.dir, reference));

describe('FASE 17B · campos de la ficha de destino y ciudad asociada', () => {
  let ctx: SuiteContext;
  let baseUrl = '';
  let limaId = 0;
  let huarazId = 0;

  before(async () => {
    ctx = await prepareSuite();
    baseUrl = await startTestServer();
    fs.rmSync(publicRoot(), { recursive: true, force: true });
    limaId = Number((await queryOne<{ id: number }>("SELECT id FROM locations WHERE city = 'Lima' LIMIT 1"))!.id);
    huarazId = Number((await queryOne<{ id: number }>("SELECT id FROM locations WHERE city = 'Huaraz' LIMIT 1"))!.id);
  });
  after(async () => {
    fs.rmSync(publicRoot(), { recursive: true, force: true });
    await teardownSuite();
  });

  beforeEach(async () => {
    await execute('DELETE FROM destinations');
  });

  const admin = () => ctx.sessions.admin.token;

  async function upload(pathname: string, token: string | undefined) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(PNG)], { type: 'image/png' }), 'imagen.png');
    const res = await fetch(`${baseUrl}${pathname}`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form });
    let body: any = {};
    try {
      body = await res.json();
    } catch {
      body = {};
    }
    return { status: res.status, body };
  }

  const crear = async (body: Record<string, unknown> = {}) => {
    const res = await post('/destinations', { name: 'Huaraz', status: 'ACTIVE', ...body }, admin());
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data as Record<string, any>;
  };

  // =====================================================================
  describe('Esquema de la 016', () => {
    it('la tabla tiene las columnas nuevas, sus índices y las dos claves ajenas a locations', async () => {
      const columnas = await query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = 'destinations'
           AND column_name IN ('altitude_masl','temperature','time_from_lima','ticket_schedule','package_schedule','festivities_image','location_id','origin_location_id')`,
      );
      assert.equal(columnas.length, 8);
      assert.ok(columnas.every((c) => c.is_nullable === 'YES'), 'todas opcionales');

      const fks = await query<{ constraint_name: string; delete_rule: string; referenced_table_name: string }>(
        `SELECT constraint_name, delete_rule, referenced_table_name FROM information_schema.referential_constraints
         WHERE constraint_schema = DATABASE() AND constraint_name IN ('fk_destinations_location','fk_destinations_origin_location')`,
      );
      assert.equal(fks.length, 2);
      assert.ok(fks.every((fk) => fk.referenced_table_name === 'locations' && fk.delete_rule === 'SET NULL'));

      const indices = await query(
        `SELECT index_name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'destinations'
           AND index_name IN ('idx_destinations_location','idx_destinations_origin_location') GROUP BY index_name`,
      );
      assert.equal(indices.length, 2);
    });

    it('borrar la ubicación no borra el destino: la referencia queda a NULL', async () => {
      const temporal = await execute(
        "INSERT INTO locations (name, city, type, status) VALUES ('Terminal QA 17B', 'Ciudad QA 17B', 'TERMINAL', 'ACTIVE')",
      );
      const destino = await crear({ name: 'Destino con ciudad QA', location_id: temporal.insertId });
      assert.equal(destino.location_id, temporal.insertId);

      await execute('DELETE FROM locations WHERE id = ?', [temporal.insertId]);
      const fila = await queryOne<{ location_id: number | null }>('SELECT location_id FROM destinations WHERE id = ?', [destino.id]);
      assert.equal(fila!.location_id, null, 'el destino sobrevive sin ciudad');
    });
  });

  // =====================================================================
  describe('CRUD ADMIN de los campos nuevos', () => {
    it('crea y edita altitud, temperatura, horarios, tiempo de viaje y ciudades', async () => {
      const creado = await crear({
        location_id: huarazId,
        origin_location_id: limaId,
        altitude_masl: 3052,
        temperature: '5°C - 22°C',
        time_from_lima: '8hr',
        ticket_schedule: 'Lun. a Dom. 08:00 - 20:00',
        package_schedule: 'Lun. a Sab. 09:00 - 18:00',
        travel_duration: '8 horas',
      });
      assert.equal(creado.altitude_masl, 3052);
      assert.equal(creado.temperature, '5°C - 22°C');
      assert.equal(creado.location_city, 'Huaraz', 'la API resuelve el nombre de la ciudad');
      assert.equal(creado.origin_city, 'Lima');

      const editado = await put(`/destinations/${creado.id}`, { altitude_masl: 3100, ticket_schedule: 'Solo mañanas', location_id: null }, admin());
      assert.equal(editado.status, 200);
      assert.equal(editado.body.data.altitude_masl, 3100);
      assert.equal(editado.body.data.ticket_schedule, 'Solo mañanas');
      assert.equal(editado.body.data.location_id, null, 'la ciudad se puede desasociar');
    });

    it('valida la altitud, el largo de los textos y la existencia de la ciudad', async () => {
      for (const body of [{ altitude_masl: -1 }, { altitude_masl: 9001 }, { altitude_masl: 'alto' }, { time_from_lima: 'x'.repeat(31) }, { temperature: 'x'.repeat(61) }, { location_id: 0 }, { location_id: 'abc' }]) {
        const res = await post('/destinations', { name: 'Prueba', ...body }, admin());
        assert.equal(res.status, 422, JSON.stringify(body));
      }
      const inexistente = await post('/destinations', { name: 'Prueba', location_id: 999999 }, admin());
      assert.equal(inexistente.status, 400, 'la clave ajena rechaza una ciudad que no existe');
    });

    it('se puede filtrar el listado por ciudad', async () => {
      await crear({ name: 'Con ciudad', location_id: huarazId });
      await crear({ name: 'Sin ciudad', slug: 'sin-ciudad' });
      const res = await get(`/destinations?location_id=${huarazId}`, admin());
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data.map((row: { name: string }) => row.name), ['Con ciudad']);
    });
  });

  // =====================================================================
  describe('API pública', () => {
    it('la ficha devuelve los campos nuevos y las ciudades resueltas', async () => {
      await crear({
        name: 'Huaraz',
        location_id: huarazId,
        origin_location_id: limaId,
        altitude_masl: 3052,
        temperature: '5°C - 22°C',
        time_from_lima: '8hr',
        ticket_schedule: 'Horario de pasajes',
        package_schedule: 'Horario de encomiendas',
      });
      const res = await get('/public/destinations/huaraz');
      assert.equal(res.status, 200);
      const data = res.body.data;
      assert.equal(data.altitude_masl, 3052);
      assert.equal(data.temperature, '5°C - 22°C');
      assert.equal(data.time_from_lima, '8hr');
      assert.equal(data.ticket_schedule, 'Horario de pasajes');
      assert.equal(data.package_schedule, 'Horario de encomiendas');
      assert.equal(data.city, 'Huaraz');
      assert.equal(data.origin_city, 'Lima');
      assert.equal(data.location_id, undefined, 'no expone ids internos');
      assert.equal(data.status, undefined);
    });

    it('una ciudad inactiva no se publica, y sin ciudad la ficha sigue funcionando', async () => {
      await crear({ name: 'Huaraz', location_id: huarazId, origin_location_id: limaId });
      await execute('UPDATE locations SET status = ? WHERE id = ?', ['INACTIVE', huarazId]);
      try {
        const res = await get('/public/destinations/huaraz');
        assert.equal(res.body.data.city, null, 'la ciudad inactiva no llega al público');
        assert.equal(res.body.data.origin_city, 'Lima');
      } finally {
        await execute('UPDATE locations SET status = ? WHERE id = ?', ['ACTIVE', huarazId]);
      }

      await execute('DELETE FROM destinations');
      await crear({ name: 'Sin ciudad', slug: 'sin-ciudad' });
      const sinCiudad = await get('/public/destinations/sin-ciudad');
      assert.equal(sinCiudad.status, 200);
      assert.equal(sinCiudad.body.data.city, null);
      assert.equal(sinCiudad.body.data.origin_city, null);
    });
  });

  // =====================================================================
  describe('Imagen del calendario festivo', () => {
    it('se sube, se reemplaza, se sirve, se quita y se borra con el destino', async () => {
      const destino = await crear({ status: 'INACTIVE' });
      const primera = await upload(`/destinations/${destino.id}/festivities-image`, admin());
      assert.equal(primera.status, 200, JSON.stringify(primera.body));
      const ref: string = primera.body.data.festivities_image;
      assert.match(ref, new RegExp(`^public/destinations/${destino.id}/[0-9a-f]{32}\\.png$`));
      assert.ok(onDisk(ref));
      assert.equal(primera.body.data.hero_image, null, 'no pisa la imagen principal');

      const servida = await fetch(`${baseUrl}/public/media/${ref}`);
      assert.equal(servida.status, 200);
      assert.equal(servida.headers.get('content-type'), 'image/png');

      const segunda = await upload(`/destinations/${destino.id}/festivities-image`, admin());
      assert.equal(onDisk(ref), false, 'la anterior se borra');

      const quitada = await del(`/destinations/${destino.id}/festivities-image`, admin());
      assert.equal(quitada.status, 200);
      assert.equal(quitada.body.data.festivities_image, null);
      assert.equal(onDisk(segunda.body.data.festivities_image), false);

      const tercera = await upload(`/destinations/${destino.id}/festivities-image`, admin());
      assert.equal((await del(`/destinations/${destino.id}`, admin())).status, 200);
      assert.equal(onDisk(tercera.body.data.festivities_image), false, 'el borrado del destino limpia también esta imagen');
    });

    it('solo ADMIN la administra', async () => {
      const destino = await crear();
      for (const role of ['companyAdmin', 'operator', 'customer'] as const) {
        assert.equal((await upload(`/destinations/${destino.id}/festivities-image`, ctx.sessions[role].token)).status, 403, role);
        assert.equal((await del(`/destinations/${destino.id}/festivities-image`, ctx.sessions[role].token)).status, 403, role);
      }
      assert.equal((await upload(`/destinations/${destino.id}/festivities-image`, undefined)).status, 401);
      assert.equal((await upload('/destinations/999999/festivities-image', admin())).status, 404);
    });
  });
});
