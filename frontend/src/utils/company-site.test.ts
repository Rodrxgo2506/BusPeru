import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  bestOrigin,
  breadcrumbJsonLd,
  clip,
  COMPANY_SITE_SECTIONS,
  companyPageMeta,
  companySiteNav,
  companySitePath,
  companyTripsUrl,
  contactMailto,
  contactWhatsapp,
  heroImagePath,
  HOME_LIMITS,
  homeHighlights,
  isSafeEmail,
  tripDate,
  validateContact,
  wrapIndex,
  type ContactDraft,
} from './company-site.ts';

describe('F18-20 · navegación del sitio de empresa', () => {
  it('8 secciones en orden, cada una con su ruta; la galería NO es una ruta', () => {
    assert.deepEqual(COMPANY_SITE_SECTIONS.map((s) => s.label), ['Inicio', 'Nosotros', 'Servicios', 'Agencias', 'Destinos', 'Flota', 'Opiniones', 'Contacto']);
    const nav = companySiteNav('busperu-demo');
    assert.deepEqual(nav.map((n) => n.to), [
      '/empresas/busperu-demo',
      '/empresas/busperu-demo/nosotros',
      '/empresas/busperu-demo/servicios',
      '/empresas/busperu-demo/agencias',
      '/empresas/busperu-demo/destinos',
      '/empresas/busperu-demo/flota',
      '/empresas/busperu-demo/opiniones',
      '/empresas/busperu-demo/contacto',
    ]);
    assert.equal(nav.some((n) => /galer/i.test(n.to) || /galer/i.test(n.label)), false);
  });

  it('Inicio es la ruta base y el único enlace con coincidencia exacta (estado activo correcto)', () => {
    assert.equal(companySitePath('x'), '/empresas/x');
    assert.deepEqual(companySiteNav('x').filter((n) => n.end).map((n) => n.id), ['inicio']);
  });

  it('codifica el slug', () => {
    assert.equal(companySitePath('a b', 'contacto'), '/empresas/a%20b/contacto');
  });
});

describe('F18-20 · SEO por ruta', () => {
  const input = { name: 'BusPerú Demo', tagline: 'Lema de la empresa', description: null, aboutBody: 'Texto de nosotros' };

  it('títulos: «Empresa | BusPerú» en Inicio y «Sección | Empresa» en subpáginas', () => {
    assert.equal(companyPageMeta('inicio', input).title, 'BusPerú Demo | BusPerú');
    assert.equal(companyPageMeta('nosotros', input).title, 'Nosotros | BusPerú Demo');
    assert.equal(companyPageMeta('contacto', input).title, 'Contacto | BusPerú Demo');
  });

  it('cada ruta tiene una descripción propia, no vacía y de ≤ 160 caracteres', () => {
    const all = COMPANY_SITE_SECTIONS.map((s) => companyPageMeta(s.id, input).description);
    assert.equal(new Set(all).size, all.length);
    for (const d of all) assert.ok(d.length > 0 && d.length <= 160, d);
    assert.equal(companyPageMeta('inicio', input).description, 'Lema de la empresa');
    assert.equal(companyPageMeta('nosotros', input).description, 'Texto de nosotros');
  });

  it('recorta textos largos por palabra con «…»', () => {
    const out = clip('palabra '.repeat(60));
    assert.ok(out.length <= 160 && out.endsWith('…'));
  });

  it('BreadcrumbList con el origen real', () => {
    const ld = breadcrumbJsonLd('https://staging.example/', 'busperu-demo', 'BusPerú Demo', 'flota') as { itemListElement: Array<{ item: string; name: string; position: number }> };
    assert.deepEqual(ld.itemListElement.map((i) => i.item), [
      'https://staging.example/empresas',
      'https://staging.example/empresas/busperu-demo',
      'https://staging.example/empresas/busperu-demo/flota',
    ]);
    assert.deepEqual(ld.itemListElement.map((i) => i.position), [1, 2, 3]);
  });
});

describe('F18-20 · Inicio resumido', () => {
  it('limita destinos y servicios destacados e indica si hay más', () => {
    const h = homeHighlights([1, 2, 3, 4, 5], ['a', 'b']);
    assert.equal(h.destinations.length, HOME_LIMITS.destinations);
    assert.equal(h.moreDestinations, true);
    assert.deepEqual(h.services, ['a', 'b']);
    assert.equal(h.moreServices, false);
  });
});

describe('F18-20 · fechas del buscador', () => {
  const hoy = '2026-09-26';
  it('usa la próxima salida si es válida y no pasada; si no, hoy', () => {
    assert.equal(tripDate('2026-09-28', hoy), '2026-09-28');
    assert.equal(tripDate(null, hoy), hoy);
    assert.equal(tripDate('2026-09-01', hoy), hoy);
    assert.equal(tripDate('mañana', hoy), hoy);
    assert.equal(companyTripsUrl(16, '2026-09-27', hoy), '/buscar?company_id=16&date=2026-09-27');
  });
  it('elige el origen con la salida más próxima', () => {
    assert.equal(bestOrigin([{ city: 'Lima', next_departure_date: '2026-09-30' }, { city: 'Cusco', next_departure_date: '2026-09-27' }])?.city, 'Cusco');
    assert.equal(bestOrigin([{ city: 'Lima', next_departure_date: null }])?.city, 'Lima');
    assert.equal(bestOrigin([]), null);
  });
});

describe('F18-20 · formularios de contacto (sin backend: correo o WhatsApp del visitante)', () => {
  const ok: ContactDraft = { name: 'Ana', phone: '', email: 'ana@correo.pe', message: 'Quisiera saber los horarios.' };

  it('valida nombre, un medio de respuesta, formato y longitud', () => {
    assert.deepEqual(validateContact(ok), {});
    const e = validateContact({ name: ' ', phone: '12', email: 'no-es-correo', message: 'corto' });
    assert.ok(e.name && e.phone && e.email && e.message);
    assert.ok(validateContact({ ...ok, email: '', phone: '' }).email);
    assert.deepEqual(validateContact({ ...ok, email: '', phone: '+51 987 654 321' }), {});
  });

  it('mailto con asunto y cuerpo codificados, solo a un correo válido', () => {
    const url = contactMailto('contacto@empresa.pe', 'Empresa X', '¿Necesitas ayuda?', ok)!;
    assert.ok(url.startsWith('mailto:contacto@empresa.pe?subject='));
    assert.ok(decodeURIComponent(url).includes('Quisiera saber los horarios.'));
    assert.equal(url.includes(' '), false);
    assert.equal(contactMailto(null, 'X', 'S', ok), null);
    assert.equal(contactMailto('a@b.pe?bcc=otro@c.pe', 'X', 'S', ok), null, 'no se puede inyectar destinatarios');
    assert.equal(isSafeEmail('a@b.pe'), true);
  });

  it('WhatsApp con el mismo mensaje, solo si hay número', () => {
    assert.match(contactWhatsapp('987654321', ok) ?? '', /^https:\/\/wa\.me\/51987654321\?text=/);
    assert.equal(contactWhatsapp(null, ok), null);
  });
});

describe('F18-20 · imágenes y galería', () => {
  it('el banner solo usa imágenes de la empresa; sin imagen, degradado (null)', () => {
    assert.equal(heroImagePath('inicio', { cover_image: '/uploads/c.webp' }), '/uploads/c.webp');
    assert.equal(heroImagePath('nosotros', { cover_image: null, about_image: '/uploads/a.webp' }), '/uploads/a.webp');
    assert.equal(heroImagePath('servicios', { cover_image: null, about_image: '/uploads/a.webp' }), null);
  });
  it('el carrusel es circular', () => {
    assert.equal(wrapIndex(-1, 4), 3);
    assert.equal(wrapIndex(4, 4), 0);
    assert.equal(wrapIndex(0, 0), 0);
  });
});
