import './helpers/testEnv';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { CreateInvalidationCommandInput } from '@aws-sdk/client-cloudfront';
import { del, post, put, startTestServer, testBaseUrl } from './helpers/api';
import { execute, queryOne } from '../config/database';
import { env } from '../config/env';
import {
  invalidatePublicMedia,
  MEDIA_CDN_PATH_PREFIX,
  mediaCdn,
  mediaInvalidationPaths,
  mediaInvalidationReference,
} from '../services/media-cdn.service';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * Fase 3 · invalidación de `/api/public/media/*` en CloudFront al retirar imágenes públicas.
 *
 * La distribución de la API guarda las imágenes públicas en el borde con caché larga. Al borrar o
 * reemplazar una, el origen deja de servirla y además se pide a CloudFront que invalide SU ruta, y
 * solo la suya. Aquí el transporte a CloudFront se sustituye por un registrador: no se llama a AWS.
 */

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 5)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(64, 6)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(32, 1)]);
const HEX = 'a'.repeat(32);
const DISTRIBUCION = 'E2TESTMEDIA01';

const publicRoot = () => path.resolve(process.cwd(), env.storage.dir, 'public');
const onDisk = (reference: string) => fs.existsSync(path.resolve(process.cwd(), env.storage.dir, reference));

describe('Fase 3 · invalidación de /api/public/media/* al retirar imágenes públicas', () => {
  let ctx: SuiteContext;
  const envOriginal = env.cdn.mediaDistributionId;
  const sendOriginal = mediaCdn.send;
  let llamadas: Array<{ input: CreateInvalidationCommandInput; enDiscoAlPedir: boolean[] }> = [];
  let fallar = false;

  before(async () => {
    ctx = await prepareSuite();
    await startTestServer();
    fs.rmSync(publicRoot(), { recursive: true, force: true });
  });
  after(async () => {
    env.cdn.mediaDistributionId = envOriginal;
    mediaCdn.send = sendOriginal;
    fs.rmSync(publicRoot(), { recursive: true, force: true });
    await execute('UPDATE companies SET logo_url = NULL');
    await execute("UPDATE system_settings SET setting_value = NULL WHERE setting_key LIKE 'branding.%'");
    await teardownSuite();
  });

  beforeEach(async () => {
    llamadas = [];
    fallar = false;
    env.cdn.mediaDistributionId = DISTRIBUCION;
    // El registrador anota lo que se pediría a CloudFront y si cada archivo seguía en disco en ese momento.
    mediaCdn.send = async (input) => {
      const rutas = input.InvalidationBatch?.Paths?.Items ?? [];
      llamadas.push({ input, enDiscoAlPedir: rutas.map((ruta) => onDisk(ruta.slice(MEDIA_CDN_PATH_PREFIX.length))) });
      if (fallar) throw Object.assign(new Error('AccessDenied (simulado)'), { name: 'AccessDenied' });
      return 'I2TESTINVALIDATION';
    };
    await execute('UPDATE companies SET logo_url = NULL');
  });
  afterEach(() => {
    mediaCdn.send = sendOriginal;
  });

  const token = (role: keyof SuiteContext['sessions']) => ctx.sessions[role].token;
  const rutas = () => llamadas.flatMap((l) => l.input.InvalidationBatch?.Paths?.Items ?? []);

  async function subir(pathname: string, tk: string, content = PNG, name = 'x.png', mime = 'image/png', campos: Record<string, string> = {}) {
    const form = new FormData();
    for (const [k, v] of Object.entries(campos)) form.append(k, v);
    form.append('file', new Blob([new Uint8Array(content)], { type: mime }), name);
    const res = await fetch(`${testBaseUrl()}${pathname}`, { method: 'POST', headers: { Authorization: `Bearer ${tk}` }, body: form });
    let body: any = {};
    try { body = await res.json(); } catch { body = {}; }
    return { status: res.status, body };
  }

  // ===================================================================== unidades
  describe('rutas y petición', () => {
    it('solo referencias públicas válidas: sin comodines, sin duplicados, sin documentos ni rutas inyectadas', () => {
      const logo = `public/companies/7/${HEX}.png`;
      const destino = `public/destinations/3/${'b'.repeat(32)}.webp`;
      const resultado = mediaInvalidationPaths([
        logo, destino, logo,
        `documents/7/${HEX}.pdf`, '../../etc/passwd', '*', '/*', '/api/*', 'public/companies/7/*',
        `public/companies/7/${HEX}.png?x=1`, `public/companies/7/${HEX}.png/../../x`, `public/companies/7/${HEX}.svg`,
        'public/companies/7/abc.png', null, undefined, 42, '',
      ]);
      assert.deepEqual(resultado, [`${MEDIA_CDN_PATH_PREFIX}${logo}`, `${MEDIA_CDN_PATH_PREFIX}${destino}`].sort());
      for (const ruta of resultado) {
        assert.ok(!ruta.includes('*'), `sin comodines: ${ruta}`);
        assert.ok(ruta.startsWith(`${MEDIA_CDN_PATH_PREFIX}public/`), `solo el canal público: ${ruta}`);
      }
    });

    it('el prefijo coincide con el único comportamiento cacheable de la plantilla; el resto de /api/* sigue sin caché', () => {
      const plantilla = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), '../infra/aws/cloudformation/busperu-staging-web.json'), 'utf8'));
      const api = plantilla.Resources.ApiDistribution.Properties.DistributionConfig;
      assert.equal(api.CacheBehaviors.length, 1);
      assert.equal(api.CacheBehaviors[0].PathPattern, `${MEDIA_CDN_PATH_PREFIX}*`);
      assert.deepEqual(api.DefaultCacheBehavior.CachePolicyId, { Ref: 'ApiCachePolicy' });
      const sinCache = plantilla.Resources.ApiCachePolicy.Properties.CachePolicyConfig;
      assert.equal(sinCache.MaxTTL, 1);
      const clave = plantilla.Resources.ApiMediaCachePolicy.Properties.CachePolicyConfig.ParametersInCacheKeyAndForwardedToOrigin;
      assert.equal(clave.HeadersConfig.HeaderBehavior, 'none', 'Authorization no entra en la clave de caché');
      assert.equal(clave.CookiesConfig.CookieBehavior, 'none');
      assert.equal(clave.QueryStringsConfig.QueryStringBehavior, 'none');
    });

    it('sin distribución configurada (o con un valor que no es un id) no se llama a CloudFront', async () => {
      env.cdn.mediaDistributionId = '';
      assert.equal((await invalidatePublicMedia([`public/companies/7/${HEX}.png`])).status, 'NOT_CONFIGURED');
      env.cdn.mediaDistributionId = 'no-es-un-id; rm -rf /';
      assert.equal((await invalidatePublicMedia([`public/companies/7/${HEX}.png`])).status, 'NOT_CONFIGURED');
      assert.equal(llamadas.length, 0);
    });

    it('con distribución: UNA petición con las rutas exactas y una referencia idempotente', async () => {
      const refs = [`public/companies/7/${HEX}.png`, `public/destinations/3/${'c'.repeat(32)}.jpg`];
      const r = await invalidatePublicMedia(refs);
      assert.equal(r.status, 'REQUESTED');
      assert.equal(r.invalidationId, 'I2TESTINVALIDATION');
      assert.equal(llamadas.length, 1);
      const { DistributionId, InvalidationBatch } = llamadas[0]!.input;
      const esperadas = refs.map((x) => `${MEDIA_CDN_PATH_PREFIX}${x}`).sort();
      assert.equal(DistributionId, DISTRIBUCION);
      assert.deepEqual(InvalidationBatch?.Paths, { Quantity: 2, Items: esperadas });
      assert.equal(InvalidationBatch?.CallerReference, mediaInvalidationReference(esperadas));
      await invalidatePublicMedia([...refs].reverse());
      assert.equal(llamadas[1]!.input.InvalidationBatch?.CallerReference, InvalidationBatch?.CallerReference, 'un reintento no crea otra invalidación');
    });

    it('referencias no públicas no llegan a CloudFront', async () => {
      assert.equal((await invalidatePublicMedia([`documents/7/${HEX}.pdf`, '/*', null])).status, 'NOTHING_TO_INVALIDATE');
      assert.equal(llamadas.length, 0);
    });

    it('un error de CloudFront no se propaga: FAILED', async () => {
      fallar = true;
      const r = await invalidatePublicMedia([`public/companies/7/${HEX}.png`]);
      assert.equal(r.status, 'FAILED');
      assert.equal(llamadas.length, 1);
    });
  });

  // ===================================================================== logotipo
  describe('logotipo de empresa', () => {
    it('reemplazar invalida SOLO la referencia anterior, ya borrada del origen', async () => {
      const a = await subir('/company/logo', token('companyAdmin'));
      assert.equal(a.status, 200, JSON.stringify(a.body));
      assert.equal(llamadas.length, 0, 'el primer logotipo no retira nada');
      const refA: string = a.body.data.logo_url;

      const b = await subir('/company/logo', token('companyAdmin'), WEBP, 'logo.webp', 'image/webp');
      assert.equal(b.status, 200);
      const refB: string = b.body.data.logo_url;
      assert.deepEqual(rutas(), [`${MEDIA_CDN_PATH_PREFIX}${refA}`]);
      assert.deepEqual(llamadas[0]!.enDiscoAlPedir, [false], 'primero se borra el archivo, después se invalida');
      assert.ok(!rutas().some((r) => r.endsWith(refB)), 'la referencia nueva no se invalida: el borde nunca la vio');
      assert.equal((await fetch(`${testBaseUrl()}/public/media/${refA}`)).status, 404);
      assert.equal((await fetch(`${testBaseUrl()}/public/media/${refB}`)).status, 200);
    });

    it('quitar borra el archivo y después invalida su ruta', async () => {
      const a = await subir('/company/logo', token('companyAdmin'));
      const ref: string = a.body.data.logo_url;
      const res = await del('/company/logo', token('companyAdmin'));
      assert.equal(res.status, 200);
      assert.ok(!onDisk(ref));
      assert.deepEqual(rutas(), [`${MEDIA_CDN_PATH_PREFIX}${ref}`]);
      assert.deepEqual(llamadas[0]!.enDiscoAlPedir, [false]);
      assert.equal((await fetch(`${testBaseUrl()}/public/media/${ref}`)).status, 404);
    });

    it('si CloudFront falla, la retirada se completa igual (200, archivo borrado, columna vacía)', async () => {
      const a = await subir('/company/logo', token('companyAdmin'));
      const ref: string = a.body.data.logo_url;
      fallar = true;
      const res = await del('/company/logo', token('companyAdmin'));
      assert.equal(res.status, 200);
      assert.ok(!onDisk(ref));
      const fila = await queryOne<{ logo_url: string | null }>('SELECT logo_url FROM companies WHERE id = ?', [ctx.fixtures.companyA]);
      assert.equal(fila!.logo_url, null);
      assert.equal(llamadas.length, 1);
    });

    it('sin distribución configurada se retira igual y no se llama a CloudFront', async () => {
      const a = await subir('/company/logo', token('companyAdmin'));
      env.cdn.mediaDistributionId = '';
      assert.equal((await del('/company/logo', token('companyAdmin'))).status, 200);
      assert.ok(!onDisk(a.body.data.logo_url));
      assert.equal(llamadas.length, 0);
    });
  });

  // ===================================================================== destinos y marca
  describe('destinos y marca', () => {
    const admin = () => token('admin');

    it('imagen de destino: reemplazar y quitar invalidan la referencia retirada', async () => {
      const dest = (await post('/destinations', { name: `Fase3 ${Date.now()}`, status: 'ACTIVE' }, admin())).body.data;
      const uno = await subir(`/destinations/${dest.id}/image`, admin());
      const dos = await subir(`/destinations/${dest.id}/image`, admin(), WEBP, 'h.webp', 'image/webp');
      assert.deepEqual(rutas(), [`${MEDIA_CDN_PATH_PREFIX}${uno.body.data.hero_image}`]);
      assert.equal((await del(`/destinations/${dest.id}/image`, admin())).status, 200);
      assert.deepEqual(rutas(), [uno.body.data.hero_image, dos.body.data.hero_image].map((r: string) => `${MEDIA_CDN_PATH_PREFIX}${r}`));
      await execute('DELETE FROM destinations WHERE id = ?', [dest.id]);
    });

    it('borrar un destino invalida TODAS sus imágenes en una sola petición', async () => {
      const dest = (await post('/destinations', { name: `Fase3b ${Date.now()}`, status: 'ACTIVE' }, admin())).body.data;
      const atractivo = (await post('/destination-attractions', { destination_id: dest.id, name: 'Mirador' }, admin())).body.data;
      const hero = await subir(`/destinations/${dest.id}/image`, admin());
      const img = await subir(`/destination-attractions/${atractivo.id}/image`, admin());
      llamadas = [];
      await put(`/destinations/${dest.id}`, { status: 'INACTIVE' }, admin());
      assert.equal((await del(`/destinations/${dest.id}`, admin())).status, 200);
      assert.equal(llamadas.length, 1, 'agrupadas en una sola invalidación');
      assert.deepEqual(rutas(), [hero.body.data.hero_image, img.body.data.image].map((r: string) => `${MEDIA_CDN_PATH_PREFIX}${r}`).sort());
      assert.ok(llamadas[0]!.enDiscoAlPedir.every((x) => !x));
    });

    it('marca: reemplazar y quitar invalidan la referencia retirada', async () => {
      const uno = await subir('/admin/branding/logo', admin());
      const dos = await subir('/admin/branding/logo', admin(), WEBP, 'l.webp', 'image/webp');
      assert.equal((await del('/admin/branding/logo', admin())).status, 200);
      assert.deepEqual(rutas(), [uno.body.data.logo, dos.body.data.logo].map((r: string) => `${MEDIA_CDN_PATH_PREFIX}${r}`));
    });
  });

  // ===================================================================== privados
  describe('documentos privados', () => {
    it('borrar un documento de empresa no pide ninguna invalidación', async () => {
      const subido = await subir('/company/documents', token('companyAdmin'), PDF, 'ruc.pdf', 'application/pdf', { type: 'RUC' });
      assert.equal(subido.status, 201, JSON.stringify(subido.body));
      assert.equal((await del(`/company/documents/${subido.body.data.id}`, token('companyAdmin'))).status, 200);
      assert.equal(llamadas.length, 0);
    });
  });
});
