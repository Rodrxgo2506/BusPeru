import './helpers/testEnv';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { del, get, put, startTestServer } from './helpers/api';
import { execute, queryOne } from '../config/database';
import { env } from '../config/env';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * F17C-COMPANY-LOGO-01 · logotipo de empresa.
 *
 * Todo sobre `busperu_test`. Lo que más importa aquí no es subir un archivo, sino que una empresa
 * NO pueda tocar el logotipo de otra: el identificador sale de la sesión, nunca de la petición.
 */

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(32, 1)]);

const publicRoot = () => path.resolve(process.cwd(), env.storage.dir, 'public');
const onDisk = (reference: string) => fs.existsSync(path.resolve(process.cwd(), env.storage.dir, reference));

describe('F17C-COMPANY-LOGO-01 · logotipo de empresa', () => {
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
    await execute('UPDATE companies SET logo_url = NULL');
    fs.rmSync(path.resolve(publicRoot(), 'companies'), { recursive: true, force: true });
  });

  const token = (role: keyof SuiteContext['sessions']) => ctx.sessions[role].token;

  async function upload(token: string | undefined, body = PNG, filename = 'logo.png', type = 'image/png', search = '') {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(body)], { type }), filename);
    const res = await fetch(`${baseUrl}/company/logo${search}`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    let parsed: any = {};
    try {
      parsed = await res.json();
    } catch {
      parsed = {};
    }
    return { status: res.status, body: parsed };
  }

  const storedLogo = async (companyId: number) =>
    (await queryOne<{ logo_url: string | null }>('SELECT logo_url FROM companies WHERE id = ?', [companyId]))!.logo_url;

  // =====================================================================
  describe('Subida y reemplazo', () => {
    it('el COMPANY_ADMIN sube su logotipo, se guarda como referencia y se sirve por el canal público', async () => {
      const res = await upload(token('companyAdmin'));
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const reference: string = res.body.data.logo_url;
      assert.match(reference, new RegExp(`^public/companies/${ctx.fixtures.companyA}/[0-9a-f]{32}\\.png$`));
      assert.equal(res.body.data.company_id, ctx.fixtures.companyA);
      assert.ok(onDisk(reference));
      assert.equal(await storedLogo(ctx.fixtures.companyA), reference, 'la columna guarda la referencia, no una URL');

      const served = await fetch(`${baseUrl}/public/media/${reference}`);
      assert.equal(served.status, 200);
      assert.equal(served.headers.get('content-type'), 'image/png');
      assert.equal(served.headers.get('cross-origin-resource-policy'), 'cross-origin');
    });

    it('reemplazar borra el archivo anterior y deja uno solo en disco', async () => {
      const first = (await upload(token('companyAdmin'))).body.data.logo_url as string;
      const second = (await upload(token('companyAdmin'))).body.data.logo_url as string;

      assert.notEqual(first, second);
      assert.equal(onDisk(first), false, 'el anterior se borra');
      assert.ok(onDisk(second));
      assert.equal(await storedLogo(ctx.fixtures.companyA), second);
    });

    it('quitarlo borra el archivo y devuelve la empresa a sus iniciales', async () => {
      const reference = (await upload(token('companyAdmin'))).body.data.logo_url as string;

      const removed = await del('/company/logo', token('companyAdmin'));
      assert.equal(removed.status, 200);
      assert.equal(removed.body.data.logo_url, null);
      assert.equal(onDisk(reference), false);
      assert.equal(await storedLogo(ctx.fixtures.companyA), null);

      // Quitarlo dos veces no es un error: la segunda no tiene nada que hacer.
      assert.equal((await del('/company/logo', token('companyAdmin'))).status, 200);
    });

    it('devuelve el logotipo vigente de la propia empresa', async () => {
      assert.equal((await get('/company/logo', token('companyAdmin'))).body.data.logo_url, null);
      const reference = (await upload(token('companyAdmin'))).body.data.logo_url as string;
      const res = await get('/company/logo', token('companyAdmin'));
      assert.equal(res.body.data.logo_url, reference);
      assert.equal(res.body.data.company_id, ctx.fixtures.companyA);
    });
  });

  // =====================================================================
  describe('Pertenencia: nadie toca el logotipo de otra empresa', () => {
    it('el company_id de la petición lo ignora un rol de empresa', async () => {
      const res = await upload(token('companyAdmin'), PNG, 'logo.png', 'image/png', `?company_id=${ctx.fixtures.companyB}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.company_id, ctx.fixtures.companyA, 'la empresa sale de la sesión');
      assert.equal(await storedLogo(ctx.fixtures.companyB), null, 'la empresa B queda intacta');
    });

    it('cada empresa administra la suya sin pisar a la otra', async () => {
      const a = (await upload(token('companyAdmin'))).body.data.logo_url as string;
      const b = (await upload(token('companyAdminB'))).body.data.logo_url as string;

      assert.match(a, new RegExp(`^public/companies/${ctx.fixtures.companyA}/`));
      assert.match(b, new RegExp(`^public/companies/${ctx.fixtures.companyB}/`));

      await del('/company/logo', token('companyAdminB'));
      assert.equal(await storedLogo(ctx.fixtures.companyA), a, 'borrar el de B no toca el de A');
      assert.ok(onDisk(a));
    });

    it('el ADMIN sí puede indicar la empresa', async () => {
      const res = await upload(token('admin'), PNG, 'logo.png', 'image/png', `?company_id=${ctx.fixtures.companyB}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.company_id, ctx.fixtures.companyB);
      assert.equal(await storedLogo(ctx.fixtures.companyA), null);
    });
  });

  // =====================================================================
  describe('Cierre: el CRUD genérico ya no escribe el logotipo (F17C-COMPANY-LOGO-01-A)', () => {
    it('un COMPANY_ADMIN no puede apropiarse del logotipo de otra empresa por el CRUD', async () => {
      // La empresa B sube el suyo por el camino correcto.
      const ajeno = (await upload(token('companyAdminB'))).body.data.logo_url as string;

      // La empresa A lo reclama editando su propia ficha, que SÍ le pertenece: reenvía el
      // formulario entero, como hace el panel, con la referencia ajena colada dentro.
      const res = await put(`/companies/${ctx.fixtures.companyA}`, { name: 'Empresa A', logo_url: ajeno }, token('companyAdmin'));
      assert.equal(res.status, 200, 'sus otros datos se siguen guardando');
      assert.equal(await storedLogo(ctx.fixtures.companyA), null, 'el logotipo ajeno no se guarda');
      assert.equal(await storedLogo(ctx.fixtures.companyB), ajeno, 'y el dueño lo conserva');
    });

    it('tampoco puede apuntar a un archivo arbitrario del almacén, ni siquiera el ADMIN', async () => {
      for (const role of ['companyAdmin', 'admin'] as const) {
        const res = await put(
          `/companies/${ctx.fixtures.companyA}`,
          { name: 'Empresa A', logo_url: 'documents/1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf' },
          token(role),
        );
        assert.equal(res.status, 200);
        assert.equal(await storedLogo(ctx.fixtures.companyA), null, `${role}: la columna no se toca desde el CRUD`);
      }
    });

    it('el esquema de entrada ya no admite `logo_url`, pero la lectura lo sigue devolviendo', async () => {
      // F17C-CLEAN-01 · `logo_url` salió del esquema Zod de escritura. La empresa sube su logotipo
      // por el endpoint específico y la API lo sigue publicando; lo que ya no existe es la
      // apariencia de que el CRUD admite ese campo.
      const propio = (await upload(token('companyAdmin'))).body.data.logo_url as string;

      const res = await put(`/companies/${ctx.fixtures.companyA}`, { name: 'Empresa A', logo_url: null }, token('companyAdmin'));
      assert.equal(res.status, 200, 'el campo desconocido no invalida la petición');
      assert.equal(await storedLogo(ctx.fixtures.companyA), propio, 'el logotipo no se borra desde el CRUD');

      // La salida no cambia: el detalle y el listado público lo siguen exponiendo.
      assert.equal((await get(`/companies/${ctx.fixtures.companyA}`, token('companyAdmin'))).body.data.logo_url, propio);
      await execute('UPDATE companies SET status = ? WHERE id = ?', ['ACTIVE', ctx.fixtures.companyA]);
      const publico = await get('/public/companies');
      const fila = (publico.body.data as Array<{ id: number; logo_url: string | null }>).find((row) => row.id === ctx.fixtures.companyA);
      assert.equal(fila?.logo_url, propio, 'la respuesta pública sigue trayendo el logotipo');
    });

    it('una edición que solo trae el logotipo se rechaza: no queda nada que escribir', async () => {
      const res = await put(`/companies/${ctx.fixtures.companyA}`, { logo_url: 'public/companies/2/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png' }, token('companyAdmin'));
      // 422 desde F17C-CLEAN-01: al salir `logo_url` del esquema Zod, el cuerpo queda vacío y lo
      // rechaza el validador. Antes llegaba al CRUD y este devolvía 400. Sigue sin escribir nada.
      assert.equal(res.status, 422, 'el cuerpo se queda sin ningún campo válido');
      assert.equal(await storedLogo(ctx.fixtures.companyA), null);
    });

    it('editar la ficha no borra el logotipo que ya tenía', async () => {
      const propio = (await upload(token('companyAdmin'))).body.data.logo_url as string;
      const res = await put(`/companies/${ctx.fixtures.companyA}`, { phone: '999888777' }, token('companyAdmin'));
      assert.equal(res.status, 200);
      assert.equal(await storedLogo(ctx.fixtures.companyA), propio, 'guardar la ficha respeta el logotipo');
      assert.ok(onDisk(propio));
    });
  });

  // =====================================================================
  describe('Permisos y validación', () => {
    it('sin sesión, o con un rol sin companies.update, no se puede escribir', async () => {
      assert.equal((await upload(undefined)).status, 401);
      assert.equal((await upload(token('operator'))).status, 403);
      assert.equal((await upload(token('customer'))).status, 403);
      assert.equal((await del('/company/logo', token('operator'))).status, 403);
      assert.equal((await del('/company/logo', token('customer'))).status, 403);
    });

    it('rechaza lo que no es una imagen admitida, aunque mienta la extensión', async () => {
      const pdf = await upload(token('companyAdmin'), PDF, 'logo.pdf', 'application/pdf');
      assert.equal(pdf.status, 400);

      const disfrazado = await upload(token('companyAdmin'), PDF, 'logo.png', 'image/png');
      assert.equal(disfrazado.status, 400, 'los bytes mágicos delatan al PDF renombrado');

      assert.equal(await storedLogo(ctx.fixtures.companyA), null);
      assert.equal(fs.existsSync(path.resolve(publicRoot(), 'companies')), false, 'nada llegó al disco');
    });

    it('rechaza una imagen por encima del máximo', async () => {
      const grande = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
      const res = await upload(token('companyAdmin'), grande);
      assert.equal(res.status, 400);
      assert.equal(await storedLogo(ctx.fixtures.companyA), null);
    });

    it('pide el archivo cuando no se envía ninguno', async () => {
      const res = await fetch(`${baseUrl}/company/logo`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token('companyAdmin')}` },
        body: new FormData(),
      });
      assert.equal(res.status, 400);
    });
  });

  // =====================================================================
  describe('El canal público solo sirve lo que le corresponde', () => {
    it('una referencia con otra forma no se sirve', async () => {
      for (const bad of [
        'public/companies/0/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
        'public/companies/1/../../documents/1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
        'documents/1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf',
        'public/companies/1/corto.png',
      ]) {
        const res = await fetch(`${baseUrl}/public/media/${bad}`);
        assert.ok(res.status === 404 || res.status === 400, `${bad} → ${res.status}`);
      }
    });

    it('el logotipo viaja en el listado público de empresas', async () => {
      const reference = (await upload(token('companyAdmin'))).body.data.logo_url as string;
      await execute('UPDATE companies SET status = ? WHERE id = ?', ['ACTIVE', ctx.fixtures.companyA]);

      const res = await get('/public/companies');
      assert.equal(res.status, 200);
      const company = (res.body.data as Array<{ id: number; logo_url: string | null }>).find((row) => row.id === ctx.fixtures.companyA);
      assert.equal(company?.logo_url, reference);
    });
  });
});
