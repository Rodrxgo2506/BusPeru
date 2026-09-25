import './helpers/testEnv';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { del, get, post, put } from './helpers/api';
import { startTestServer } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { env } from '../config/env';
import { isPublicReference } from '../services/file-storage.service';
import { slugify } from '../validators/destination.validators';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * FASE 17 · CMS de destinos, atractivos, festividades e identidad visual.
 *
 * Todo sobre `busperu_test`. Las imágenes van al almacén de pruebas (`STORAGE_DIR/public`), que la
 * suite vacía al empezar y al terminar.
 */

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(64, 3)]);
const ICO = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x00]), Buffer.alloc(64, 4)]);
const PDF = Buffer.from('%PDF-1.4 contenido');

const publicRoot = () => path.resolve(process.cwd(), env.storage.dir, 'public');
const onDisk = (reference: string) => fs.existsSync(path.resolve(process.cwd(), env.storage.dir, reference));

describe('FASE 17 · destinos, atractivos, festividades y branding', () => {
  let ctx: SuiteContext;
  let baseUrl = '';

  before(async () => {
    ctx = await prepareSuite();
    baseUrl = await startTestServer();
    fs.rmSync(publicRoot(), { recursive: true, force: true });
  });
  after(async () => {
    fs.rmSync(publicRoot(), { recursive: true, force: true });
    await teardownSuite();
  });

  beforeEach(async () => {
    await execute('DELETE FROM destinations');
  });

  const admin = () => ctx.sessions.admin.token;

  async function upload(pathname: string, token: string | undefined, file: { content: Buffer; name: string; mime: string }) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file.content)], { type: file.mime }), file.name);
    const res = await fetch(`${baseUrl}${pathname}`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form });
    let body: any = {};
    try {
      body = await res.json();
    } catch {
      body = {};
    }
    return { status: res.status, body };
  }

  async function createDestination(body: Record<string, unknown> = {}) {
    const res = await post('/destinations', { name: 'Cajamarca', status: 'ACTIVE', ...body }, admin());
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data as { id: number; slug: string; status: string };
  }

  // =====================================================================
  describe('Destinos · CRUD ADMIN', () => {
    it('slugify normaliza tildes, espacios y símbolos', () => {
      assert.equal(slugify('La Merced'), 'la-merced');
      assert.equal(slugify('  Cañón del Colca!! '), 'canon-del-colca');
      assert.equal(slugify('Huaraz'), 'huaraz');
      assert.equal(slugify('¡¡!!'), '');
    });

    it('crea con slug derivado del nombre, lista, obtiene y edita', async () => {
      const created = await createDestination({ name: 'La Merced', price_from: 110, subtitle: 'Selva central', display_order: 3 });
      assert.equal(created.slug, 'la-merced');

      const list = await get('/destinations?search=merced', admin());
      assert.equal(list.status, 200);
      assert.equal(list.body.data.length, 1);

      const one = await get(`/destinations/${created.id}`, admin());
      assert.equal(one.status, 200);
      assert.equal(Number(one.body.data.price_from), 110);

      const edited = await put(`/destinations/${created.id}`, { subtitle: 'Nuevo subtítulo', name: 'La Merced (Junín)' }, admin());
      assert.equal(edited.status, 200);
      assert.equal(edited.body.data.subtitle, 'Nuevo subtítulo');
      assert.equal(edited.body.data.slug, 'la-merced', 'renombrar no cambia la URL publicada');
    });

    it('slug duplicado → 409 al crear y al editar; slug inválido → 422', async () => {
      const a = await createDestination({ name: 'Huaraz' });
      const b = await createDestination({ name: 'Trujillo' });
      const dup = await post('/destinations', { name: 'Otro Huaraz', slug: 'huaraz' }, admin());
      assert.equal(dup.status, 409);
      const dupEdit = await put(`/destinations/${b.id}`, { slug: a.slug }, admin());
      assert.equal(dupEdit.status, 409);

      for (const slug of ['Con Mayúsculas', 'con espacio', 'tildé', '../etc', 'a--b', '-inicio', 'x'.repeat(121)]) {
        const res = await post('/destinations', { name: 'Prueba', slug }, admin());
        assert.equal(res.status, 422, `${slug} -> ${res.status}`);
      }
      const sinSlug = await post('/destinations', { name: '¡¡!!' }, admin());
      assert.equal(sinSlug.status, 422);
    });

    it('validaciones: nombre obligatorio, precio no negativo, estado y orden válidos', async () => {
      for (const body of [{}, { name: '' }, { name: 'X', price_from: -1 }, { name: 'X', status: 'PUBLISHED' }, { name: 'X', display_order: -2 }]) {
        const res = await post('/destinations', body, admin());
        assert.equal(res.status, 422, JSON.stringify(body));
      }
    });

    it('activar/desactivar por PUT de estado y reordenar en bloque', async () => {
      const a = await createDestination({ name: 'Cajamarca', display_order: 1 });
      const b = await createDestination({ name: 'Huaraz', display_order: 2 });
      const off = await put(`/destinations/${a.id}`, { status: 'INACTIVE' }, admin());
      assert.equal(off.body.data.status, 'INACTIVE');

      const reorder = await post('/destinations/reorder', { ids: [b.id, a.id] }, admin());
      assert.equal(reorder.status, 200);
      const rows = await query<{ id: number; display_order: number }>('SELECT id, display_order FROM destinations ORDER BY display_order');
      assert.deepEqual(rows.map((row) => row.id), [b.id, a.id]);

      assert.equal((await post('/destinations/reorder', { ids: [a.id, a.id] }, admin())).status, 422);
      assert.equal((await post('/destinations/reorder', { ids: [a.id, 999999] }, admin())).status, 404);
    });

    it('un destino ACTIVE no se elimina; INACTIVE sí, con sus hijos y sus imágenes', async () => {
      const dest = await createDestination();
      const attraction = await post('/destination-attractions', { destination_id: dest.id, name: 'Baños del Inca' }, admin());
      await post('/destination-festivities', { destination_id: dest.id, name: 'Carnaval', date_label: 'Febrero' }, admin());
      const hero = await upload(`/destinations/${dest.id}/image`, admin(), { content: PNG, name: 'hero.png', mime: 'image/png' });
      const img = await upload(`/destination-attractions/${attraction.body.data.id}/image`, admin(), { content: JPG, name: 'a.jpg', mime: 'image/jpeg' });
      assert.equal(hero.status, 200);
      assert.equal(img.status, 200);

      const blocked = await del(`/destinations/${dest.id}`, admin());
      assert.equal(blocked.status, 409);

      await put(`/destinations/${dest.id}`, { status: 'INACTIVE' }, admin());
      const removed = await del(`/destinations/${dest.id}`, admin());
      assert.equal(removed.status, 200);
      assert.equal(Number((await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM destination_attractions'))!.n), 0);
      assert.equal(Number((await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM destination_festivities'))!.n), 0);
      assert.equal(onDisk(hero.body.data.hero_image), false, 'la imagen principal se borró del disco');
      assert.equal(onDisk(img.body.data.image), false, 'la imagen del atractivo se borró del disco');
    });
  });

  // =====================================================================
  describe('Atractivos y festividades', () => {
    it('CRUD de atractivos y aislamiento por destino', async () => {
      const cajamarca = await createDestination({ name: 'Cajamarca' });
      const huaraz = await createDestination({ name: 'Huaraz' });

      const created = await post('/destination-attractions', { destination_id: cajamarca.id, name: 'Cumbe Mayo', description: 'Acueducto' }, admin());
      assert.equal(created.status, 201);
      const id = created.body.data.id;

      const edited = await put(`/destination-attractions/${id}`, { name: 'Cumbe Mayo (editado)', destination_id: huaraz.id }, admin());
      assert.equal(edited.status, 200);
      assert.equal(edited.body.data.name, 'Cumbe Mayo (editado)');
      assert.equal(edited.body.data.destination_id, cajamarca.id, 'un atractivo no se mueve a otro destino');

      const onlyDestination = await put(`/destination-attractions/${id}`, { destination_id: huaraz.id }, admin());
      assert.equal(onlyDestination.status, 422, 'enviar solo destination_id no es un cambio admitido');

      const list = await get(`/destination-attractions?destination_id=${huaraz.id}`, admin());
      assert.equal(list.body.data.length, 0);

      const other = await post('/destination-attractions', { destination_id: huaraz.id, name: 'Laguna 69' }, admin());
      const crossReorder = await post('/destination-attractions/reorder', { destination_id: cajamarca.id, ids: [id, other.body.data.id] }, admin());
      assert.equal(crossReorder.status, 404, 'no se reordena un atractivo de otro destino');

      assert.equal((await post('/destination-attractions', { destination_id: 999999, name: 'Huérfano' }, admin())).status, 400);

      const removed = await del(`/destination-attractions/${id}`, admin());
      assert.equal(removed.status, 200);
      assert.equal((await get(`/destination-attractions/${id}`, admin())).status, 404);
    });

    it('CRUD de festividades con fecha en texto libre y reordenación', async () => {
      const dest = await createDestination();
      const a = await post('/destination-festivities', { destination_id: dest.id, name: 'Festival de San Sebastián', date_label: '20 de Enero' }, admin());
      const b = await post('/destination-festivities', { destination_id: dest.id, name: 'Carnaval', date_label: 'Febrero' }, admin());
      assert.equal(a.status, 201);
      assert.equal(a.body.data.date_label, '20 de Enero');
      assert.equal((await post('/destination-festivities', { destination_id: dest.id, name: 'Sin fecha' }, admin())).status, 422);

      const edited = await put(`/destination-festivities/${a.body.data.id}`, { date_label: 'Enero', status: 'INACTIVE' }, admin());
      assert.equal(edited.body.data.date_label, 'Enero');

      assert.equal((await post('/destination-festivities/reorder', { destination_id: dest.id, ids: [b.body.data.id, a.body.data.id] }, admin())).status, 200);
      const order = await query<{ id: number }>('SELECT id FROM destination_festivities ORDER BY display_order');
      assert.deepEqual(order.map((row) => row.id), [b.body.data.id, a.body.data.id]);

      assert.equal((await del(`/destination-festivities/${a.body.data.id}`, admin())).status, 200);
    });
  });

  // =====================================================================
  describe('API pública', () => {
    it('solo destinos ACTIVE, en orden, con campos de tarjeta; ficha por slug con hijos ACTIVE', async () => {
      const b = await createDestination({ name: 'Huaraz', display_order: 2, price_from: 90 });
      const a = await createDestination({ name: 'Cajamarca', display_order: 1, price_from: 110 });
      await createDestination({ name: 'Oculto', status: 'INACTIVE', display_order: 0 });
      await post('/destination-attractions', { destination_id: a.id, name: 'Visible' }, admin());
      await post('/destination-attractions', { destination_id: a.id, name: 'Oculta', status: 'INACTIVE' }, admin());
      await post('/destination-festivities', { destination_id: a.id, name: 'Fiesta visible', date_label: 'Enero' }, admin());
      await post('/destination-festivities', { destination_id: a.id, name: 'Fiesta oculta', date_label: 'Marzo', status: 'INACTIVE' }, admin());

      const list = await get('/public/featured-destinations');
      assert.equal(list.status, 200);
      assert.deepEqual(list.body.data.map((row: { slug: string }) => row.slug), ['cajamarca', 'huaraz']);
      assert.deepEqual(Object.keys(list.body.data[0]).sort(), ['display_order', 'hero_image', 'id', 'name', 'price_from', 'slug', 'subtitle']);
      assert.ok(b.id);

      const detail = await get('/public/destinations/cajamarca');
      assert.equal(detail.status, 200);
      assert.deepEqual(detail.body.data.attractions.map((row: { name: string }) => row.name), ['Visible']);
      assert.deepEqual(detail.body.data.festivities.map((row: { name: string }) => row.name), ['Fiesta visible']);
      assert.equal(detail.body.data.status, undefined, 'no expone campos internos');

      assert.equal((await get('/public/destinations/oculto')).status, 404, 'INACTIVE no es público');
      assert.equal((await get('/public/destinations/no-existe')).status, 404);
      assert.equal((await get('/public/destinations/..%2F..%2Fetc')).status, 404);
      assert.equal((await get('/public/destinations/MAYUS')).status, 404);
    });

    it('la ruta pública antigua /public/destinations (viajes programados) sigue igual', async () => {
      const res = await get('/public/destinations');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
    });

    it('el texto con HTML se guarda y se devuelve como texto, en JSON', async () => {
      const payload = '<script>alert(1)</script><img src=x onerror=alert(2)>';
      await createDestination({ name: 'Trujillo', description: payload });
      const res = await fetch(`${baseUrl}/public/destinations/trujillo`);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      const body = (await res.json()) as { data: { description: string } };
      assert.equal(body.data.description, payload, 'sin transformar: el frontend lo pinta escapado');
    });
  });

  // =====================================================================
  describe('Imágenes', () => {
    it('sube, reemplaza (borrando la anterior), sirve con cabeceras seguras y quita', async () => {
      const dest = await createDestination();
      const first = await upload(`/destinations/${dest.id}/image`, admin(), { content: PNG, name: 'Hero Final.PNG', mime: 'image/png' });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      const firstRef: string = first.body.data.hero_image;
      assert.ok(isPublicReference(firstRef), firstRef);
      assert.match(firstRef, new RegExp(`^public/destinations/${dest.id}/[0-9a-f]{32}\\.png$`), 'nombre generado por el servidor');
      assert.ok(onDisk(firstRef));

      const served = await fetch(`${baseUrl}/public/media/${firstRef}`);
      assert.equal(served.status, 200);
      assert.equal(served.headers.get('content-type'), 'image/png');
      assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(served.headers.get('cross-origin-resource-policy'), 'cross-origin');
      assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);

      const second = await upload(`/destinations/${dest.id}/image`, admin(), { content: WEBP, name: 'hero.webp', mime: 'image/webp' });
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(onDisk(firstRef), false, 'la imagen reemplazada se borra');
      assert.ok(onDisk(second.body.data.hero_image));

      const removed = await del(`/destinations/${dest.id}/image`, admin());
      assert.equal(removed.status, 200);
      assert.equal(removed.body.data.hero_image, null);
      assert.equal(onDisk(second.body.data.hero_image), false);
    });

    it('rechaza formatos, MIME incoherente, bytes falsos, SVG, vacíos y sin archivo', async () => {
      const dest = await createDestination();
      const casos: Array<{ content: Buffer; name: string; mime: string }> = [
        { content: PDF, name: 'doc.pdf', mime: 'application/pdf' },
        { content: Buffer.from('<svg onload="alert(1)"/>'), name: 'logo.svg', mime: 'image/svg+xml' },
        { content: PNG, name: 'hero.png', mime: 'image/jpeg' },
        { content: PDF, name: 'falso.png', mime: 'image/png' },
        { content: Buffer.from('RIFF0000AVI LIST'), name: 'falso.webp', mime: 'image/webp' },
        { content: PNG, name: 'hero.png.exe', mime: 'image/png' },
        { content: Buffer.alloc(0), name: 'vacio.png', mime: 'image/png' },
      ];
      for (const caso of casos) {
        const res = await upload(`/destinations/${dest.id}/image`, admin(), caso);
        assert.equal(res.status, 400, `${caso.name} -> ${res.status}`);
      }
      const noFile = await fetch(`${baseUrl}/destinations/${dest.id}/image`, { method: 'POST', headers: { Authorization: `Bearer ${admin()}` } });
      assert.equal(noFile.status, 400);
      const big = await upload(`/destinations/${dest.id}/image`, admin(), { content: Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]), name: 'big.png', mime: 'image/png' });
      assert.equal(big.status, 400);
      assert.equal((await upload('/destinations/999999/image', admin(), { content: PNG, name: 'x.png', mime: 'image/png' })).status, 404);
      assert.equal(fs.existsSync(path.join(publicRoot(), 'destinations', String(dest.id))) ? fs.readdirSync(path.join(publicRoot(), 'destinations', String(dest.id))).length : 0, 0, 'nada rechazado llega a disco');
    });

    it('el canal público no sirve documentos privados ni rutas manipuladas', async () => {
      const docDir = path.resolve(process.cwd(), env.storage.dir, 'documents', '1');
      fs.mkdirSync(docDir, { recursive: true });
      fs.writeFileSync(path.join(docDir, 'secreto.pdf'), PDF);
      try {
        for (const ruta of [
          'documents/1/secreto.pdf',
          'public/../documents/1/secreto.pdf',
          'public%2F..%2Fdocuments%2F1%2Fsecreto.pdf',
          '..%2F..%2F.env',
          'public/destinations/1/../../../.env',
          `public/destinations/1/${'a'.repeat(32)}.svg`,
        ]) {
          const res = await fetch(`${baseUrl}/public/media/${ruta}`);
          assert.equal(res.status, 404, `${ruta} -> ${res.status}`);
        }
      } finally {
        // La carpeta la creó esta prueba: se retira entera para no dejar directorios vacíos en el almacén.
        fs.rmSync(docDir, { recursive: true, force: true });
        const documents = path.dirname(docDir);
        if (fs.existsSync(documents) && fs.readdirSync(documents).length === 0) fs.rmdirSync(documents);
      }
    });
  });

  // =====================================================================
  describe('Identidad visual', () => {
    it('lectura pública, subida y reemplazo por ADMIN, favicon estable y borrado', async () => {
      const empty = await get('/public/branding');
      assert.equal(empty.status, 200);
      assert.deepEqual(empty.body.data, { logo: null, favicon: null, logo_mobile: null, og_image: null });

      // F17C-BRAND-01 · sin favicon configurado la URL estable responde 204, no 404, y lleva la
      // política de recurso cruzado: el navegador no puede bloquearla ni registrarla como fallo.
      const sinFavicon = await fetch(`${baseUrl}/public/branding/favicon`);
      assert.equal(sinFavicon.status, 204);
      assert.equal(sinFavicon.headers.get('cross-origin-resource-policy'), 'cross-origin');
      assert.equal((await sinFavicon.text()).length, 0, 'sin cuerpo: no se inventa ningún icono');

      const logo = await upload('/admin/branding/logo', admin(), { content: PNG, name: 'logo.png', mime: 'image/png' });
      assert.equal(logo.status, 200, JSON.stringify(logo.body));
      assert.match(logo.body.data.logo, /^public\/branding\/logo\/[0-9a-f]{32}\.png$/);

      const replaced = await upload('/admin/branding/logo', admin(), { content: WEBP, name: 'logo.webp', mime: 'image/webp' });
      assert.equal(onDisk(logo.body.data.logo), false, 'el logo anterior se borra');

      const favicon = await upload('/admin/branding/favicon', admin(), { content: ICO, name: 'favicon.ico', mime: 'image/x-icon' });
      assert.equal(favicon.status, 200, JSON.stringify(favicon.body));
      const served = await fetch(`${baseUrl}/public/branding/favicon`);
      assert.equal(served.status, 200);
      assert.equal(served.headers.get('content-type'), 'image/x-icon');
      assert.match(served.headers.get('cache-control') ?? '', /max-age=300/);
      // Con favicon configurado la cabecera de recurso cruzado sigue siendo la de siempre.
      assert.equal(served.headers.get('cross-origin-resource-policy'), 'cross-origin');
      assert.equal(served.headers.get('x-content-type-options'), 'nosniff');

      assert.equal((await upload('/admin/branding/favicon', admin(), { content: JPG, name: 'favicon.jpg', mime: 'image/jpeg' })).status, 400, 'favicon solo PNG o ICO');
      for (const asset of ['logo_mobile', 'og_image']) {
        assert.equal((await upload(`/admin/branding/${asset}`, admin(), { content: JPG, name: 'x.jpg', mime: 'image/jpeg' })).status, 200);
      }

      const pub = await get('/public/branding');
      assert.equal(pub.body.data.logo, replaced.body.data.logo);
      assert.ok(pub.body.data.og_image);

      const removed = await del('/admin/branding/logo', admin());
      assert.equal(removed.status, 200);
      assert.equal(removed.body.data.logo, null);
      assert.equal(onDisk(replaced.body.data.logo), false);

      assert.equal((await upload('/admin/branding/otra-cosa', admin(), { content: PNG, name: 'x.png', mime: 'image/png' })).status, 404);
    });

    it('un valor manipulado en system_settings no se publica ni se sirve', async () => {
      await execute(
        `INSERT INTO system_settings (setting_key, setting_value, setting_type, is_public) VALUES ('branding.favicon', '../../.env', 'STRING', 1)
         ON DUPLICATE KEY UPDATE setting_value = '../../.env'`,
      );
      assert.equal((await get('/public/branding')).body.data.favicon, null);
      // Una referencia manipulada se trata como «no hay favicon»: 204 y sin cuerpo (F17C-BRAND-01).
      const manipulado = await fetch(`${baseUrl}/public/branding/favicon`);
      assert.equal(manipulado.status, 204);
      assert.equal((await manipulado.text()).length, 0, 'no se sirve el archivo apuntado');
    });
  });

  // =====================================================================
  describe('Permisos y seguridad', () => {
    it('COMPANY_ADMIN, OPERATOR y CUSTOMER no leen ni modifican el contenido; sin sesión 401', async () => {
      const dest = await createDestination();
      const attraction = await post('/destination-attractions', { destination_id: dest.id, name: 'A' }, admin());
      for (const role of ['companyAdmin', 'operator', 'customer'] as const) {
        const token = ctx.sessions[role].token;
        assert.equal((await get('/destinations', token)).status, 403, `${role} lista`);
        assert.equal((await post('/destinations', { name: 'Intruso' }, token)).status, 403, `${role} crea`);
        assert.equal((await put(`/destinations/${dest.id}`, { name: 'X' }, token)).status, 403, `${role} edita`);
        assert.equal((await del(`/destinations/${dest.id}`, token)).status, 403, `${role} borra`);
        assert.equal((await post('/destination-attractions', { destination_id: dest.id, name: 'X' }, token)).status, 403);
        assert.equal((await put(`/destination-attractions/${attraction.body.data.id}`, { name: 'X' }, token)).status, 403);
        assert.equal((await post('/destination-festivities', { destination_id: dest.id, name: 'X', date_label: 'Y' }, token)).status, 403);
        assert.equal((await post('/destinations/reorder', { ids: [dest.id] }, token)).status, 403);
        assert.equal((await upload(`/destinations/${dest.id}/image`, token, { content: PNG, name: 'x.png', mime: 'image/png' })).status, 403);
        assert.equal((await upload('/admin/branding/logo', token, { content: PNG, name: 'x.png', mime: 'image/png' })).status, 403, `${role} branding`);
        assert.equal((await get('/admin/branding', token)).status, 403);
      }
      assert.equal((await post('/destinations', { name: 'Anónimo' })).status, 401);
      assert.equal((await upload('/admin/branding/logo', undefined, { content: PNG, name: 'x.png', mime: 'image/png' })).status, 401);
      assert.equal((await get(`/destinations/${dest.id}`, admin())).body.data.name, 'Cajamarca', 'nada cambió');
    });

    it('ids inválidos → 404', async () => {
      for (const id of ['abc', '0', '-1', '1.5']) {
        assert.equal((await get(`/destinations/${id}`, admin())).status, 404, id);
        assert.equal((await del(`/destinations/${id}/image`, admin())).status, 404, id);
      }
    });

    it('auditoría: alta, edición, borrado, imagen y branding, sin valores sensibles', async () => {
      await execute('DELETE FROM audit_logs');
      const dest = await createDestination({ status: 'INACTIVE' });
      await put(`/destinations/${dest.id}`, { subtitle: 'x' }, admin());
      await upload(`/destinations/${dest.id}/image`, admin(), { content: PNG, name: 'x.png', mime: 'image/png' });
      await del(`/destinations/${dest.id}`, admin());
      await upload('/admin/branding/og_image', admin(), { content: PNG, name: 'og.png', mime: 'image/png' });
      const logs = await query<{ action: string; entity_type: string; user_id: number }>('SELECT action, entity_type, user_id FROM audit_logs ORDER BY id');
      const pairs = logs.map((log) => `${log.action}:${log.entity_type}`);
      for (const expected of ['CREATE:destinations', 'UPDATE:destinations', 'DELETE:destinations', 'UPDATE:branding']) {
        assert.ok(pairs.includes(expected), `${expected} en ${pairs.join(', ')}`);
      }
      assert.ok(logs.every((log) => log.user_id === ctx.fixtures.users.admin));
    });
  });
});
