import './helpers/testEnv';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { del, get, patch, post, put, testBaseUrl } from './helpers/api';
import { at, freeSeats } from './helpers/fixtures';
import { execute, queryOne } from '../config/database';
import { env } from '../config/env';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * F18-19 · perfil público de empresas.
 *
 * Lo esencial: (1) una empresa solo toca SU perfil, aunque envíe otro company_id; (2) nada llega al público
 * sin aprobación del ADMIN, y lo aprobado sigue visible mientras se revisa una edición; (3) solo texto
 * plano, URLs https y archivos que de verdad son imágenes; (4) destinos, flota y opiniones salen de las
 * entidades existentes y sin datos internos.
 */

/** PNG mínimo con cabecera IHDR real (ancho × alto). El almacén solo mira firma y cabecera. */
function png(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 2;
  return Buffer.concat([signature, ihdr, Buffer.alloc(64, 1)]);
}

const publicRoot = () => path.resolve(process.cwd(), env.storage.dir, 'public');

describe('F18-19 · perfil público de empresas', () => {
  let ctx: SuiteContext;
  const token = (role: keyof SuiteContext['sessions']) => ctx.sessions[role].token;

  async function upload(pathname: string, tokenValue: string, body: Buffer, filename = 'foto.png', type = 'image/png', fields: Record<string, string> = {}) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(body)], { type }), filename);
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    const res = await fetch(`${testBaseUrl()}${pathname}`, { method: 'POST', headers: { Authorization: `Bearer ${tokenValue}` }, body: form });
    let parsed: any = {};
    try {
      parsed = await res.json();
    } catch {
      parsed = {};
    }
    return { status: res.status, body: parsed };
  }

  const moderate = (companyId: number, body: Record<string, unknown>, who: keyof SuiteContext['sessions'] = 'admin') =>
    post(`/admin/company-profiles/${companyId}/moderation`, body, token(who));

  before(async () => {
    ctx = await prepareSuite();
    fs.rmSync(publicRoot(), { recursive: true, force: true });
  });
  after(async () => {
    fs.rmSync(publicRoot(), { recursive: true, force: true });
    await teardownSuite();
  });

  // ======================================================================= acceso y aislamiento
  describe('Acceso y aislamiento multiempresa', () => {
    it('el COMPANY_ADMIN abre su perfil: se crea en borrador con un slug derivado del nombre y sin publicar', async () => {
      const res = await get('/company/profile', token('companyAdmin'));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.company_id, ctx.fixtures.companyA);
      assert.equal(res.body.data.slug, 'empresa-a');
      assert.equal(res.body.data.review_status, 'DRAFT');
      assert.equal(res.body.data.is_published, false);
    });

    it('sin aprobación no existe página pública y el listado no enlaza el perfil', async () => {
      assert.equal((await get('/public/companies/empresa-a')).status, 404);
      const list = await get('/public/companies');
      const empresaA = list.body.data.find((c: { id: number }) => c.id === ctx.fixtures.companyA);
      assert.equal(empresaA.slug, null);
    });

    it('CUSTOMER no entra al panel del perfil (tiene companies.view, pero no el rol)', async () => {
      assert.equal((await get('/company/profile', token('customer'))).status, 403);
      assert.equal((await put('/company/profile', { tagline: 'x' }, token('customer'))).status, 403);
    });

    it('OPERATOR lee el perfil de su empresa pero no lo edita', async () => {
      assert.equal((await get('/company/profile', token('operator'))).status, 200);
      assert.equal((await put('/company/profile', { tagline: 'Intento del operador' }, token('operator'))).status, 403);
    });

    it('un COMPANY_ADMIN no puede escapar de su empresa con ?company_id= ni con company_id en el cuerpo', async () => {
      const conParametro = await put(`/company/profile?company_id=${ctx.fixtures.companyA}`, { tagline: 'Escrito por B' }, token('companyAdminB'));
      assert.equal(conParametro.status, 200);
      assert.equal(conParametro.body.data.company_id, ctx.fixtures.companyB, 'la empresa sale de la sesión, no del parámetro');
      const perfilA = await queryOne<{ tagline: string | null }>('SELECT tagline FROM company_profiles WHERE company_id = ?', [ctx.fixtures.companyA]);
      assert.notEqual(perfilA?.tagline, 'Escrito por B');

      const conCuerpo = await put('/company/profile', { tagline: 'x', company_id: ctx.fixtures.companyA }, token('companyAdminB'));
      assert.equal(conCuerpo.status, 422, 'company_id no es un campo del perfil');
    });

    it('solo el ADMIN modera', async () => {
      const res = await moderate(ctx.fixtures.companyA, { entity: 'profile', action: 'approve' }, 'companyAdmin');
      assert.equal(res.status, 403);
      assert.equal((await get('/admin/company-profiles', token('companyAdmin'))).status, 403);
    });
  });

  // ======================================================================= validación
  describe('Validación de contenido (texto plano, URLs, contacto)', () => {
    it('rechaza HTML (XSS almacenado) en cualquier texto', async () => {
      for (const body of [
        { tagline: '<script>alert(1)</script>' },
        { about_body: 'Hola <img src=x onerror=alert(1)>' },
        { values_list: ['Seguridad', '<b>Negrita</b>'] },
      ]) {
        const res = await put('/company/profile', body, token('companyAdmin'));
        assert.equal(res.status, 422, JSON.stringify(body));
      }
    });

    it('solo acepta https y redes sociales en su dominio oficial', async () => {
      assert.equal((await put('/company/profile', { website_url: 'http://empresa-a.pe' }, token('companyAdmin'))).status, 422);
      assert.equal((await put('/company/profile', { website_url: 'javascript:alert(1)' }, token('companyAdmin'))).status, 422);
      assert.equal((await put('/company/profile', { social_links: { facebook: 'https://evil.example/facebook' } }, token('companyAdmin'))).status, 422);
      assert.equal((await put('/company/profile', { social_links: { myspace: 'https://myspace.com/a' } }, token('companyAdmin'))).status, 422);
    });

    it('valida teléfonos y correos', async () => {
      assert.equal((await put('/company/profile', { contact_phone: '12' }, token('companyAdmin'))).status, 422);
      assert.equal((await put('/company/profile', { contact_email: 'no-es-correo' }, token('companyAdmin'))).status, 422);
    });

    it('guarda un perfil válido y lo deja en borrador, con auditoría', async () => {
      const res = await put('/company/profile', {
        tagline: 'Viaja seguro por el centro del Perú',
        about_title: 'Nuestra historia',
        about_body: 'Empresa de transporte interprovincial.',
        mission: 'Conectar ciudades con seguridad.',
        vision: 'Ser la empresa más puntual.',
        values_list: ['Seguridad', 'Puntualidad', 'seguridad'],
        contact_phone: '+51 999 888 777',
        contact_email: 'Contacto@Empresa-A.pe',
        website_url: 'https://empresa-a.pe',
        social_links: { facebook: 'https://www.facebook.com/empresa-a', instagram: '' },
      }, token('companyAdmin'));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.data.values_list, ['Seguridad', 'Puntualidad'], 'sin repetidos');
      assert.equal(res.body.data.contact_email, 'contacto@empresa-a.pe');
      assert.deepEqual(res.body.data.social_links, { facebook: 'https://www.facebook.com/empresa-a' });
      assert.equal(res.body.data.review_status, 'DRAFT');

      const auditoria = await queryOne<{ total: number }>(
        "SELECT COUNT(*) AS total FROM audit_logs WHERE entity_type = 'company_profile' AND entity_id = ? AND action = 'UPDATE'",
        [ctx.fixtures.companyA],
      );
      assert.ok(Number(auditoria?.total) >= 1);
    });
  });

  // ======================================================================= moderación
  describe('Moderación: nada se publica sin aprobación', () => {
    it('enviar → PENDING; el público sigue sin verlo', async () => {
      const res = await post('/company/profile/submit', {}, token('companyAdmin'));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.review_status, 'PENDING');
      assert.equal((await get('/public/companies/empresa-a')).status, 404);
    });

    it('rechazar exige motivo', async () => {
      assert.equal((await moderate(ctx.fixtures.companyA, { entity: 'profile', action: 'reject' })).status, 422);
    });

    it('el ADMIN aprueba → se publica la instantánea y el listado enlaza /empresas/<slug>', async () => {
      const res = await moderate(ctx.fixtures.companyA, { entity: 'profile', action: 'approve' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const pub = await get('/public/companies/empresa-a');
      assert.equal(pub.status, 200);
      assert.equal(pub.body.data.profile.tagline, 'Viaja seguro por el centro del Perú');
      assert.equal(pub.body.data.company.name, 'Empresa A');
      const list = await get('/public/companies');
      assert.equal(list.body.data.find((c: { id: number }) => c.id === ctx.fixtures.companyA).slug, 'empresa-a');
    });

    it('una edición posterior queda en borrador y el público SIGUE viendo lo aprobado', async () => {
      await put('/company/profile', { tagline: 'Texto nuevo sin revisar' }, token('companyAdmin'));
      const pub = await get('/public/companies/empresa-a');
      assert.equal(pub.body.data.profile.tagline, 'Viaja seguro por el centro del Perú');
      const preview = await get('/company/profile/preview', token('companyAdmin'));
      assert.equal(preview.body.data.profile.tagline, 'Texto nuevo sin revisar', 'la vista previa muestra la copia de trabajo');
      assert.equal(preview.body.data.preview, true);
    });

    it('rechazo con nota: la empresa la ve y lo publicado antes se mantiene', async () => {
      await post('/company/profile/submit', {}, token('companyAdmin'));
      const res = await moderate(ctx.fixtures.companyA, { entity: 'profile', action: 'reject', note: 'El eslogan no describe el servicio' });
      assert.equal(res.status, 200);
      const perfil = await get('/company/profile', token('companyAdmin'));
      assert.equal(perfil.body.data.review_status, 'REJECTED');
      assert.equal(perfil.body.data.moderation_note, 'El eslogan no describe el servicio');
      assert.equal((await get('/public/companies/empresa-a')).body.data.profile.tagline, 'Viaja seguro por el centro del Perú');
    });

    it('suspender oculta la página; levantar la suspensión la devuelve', async () => {
      assert.equal((await moderate(ctx.fixtures.companyA, { entity: 'profile', action: 'suspend' })).status, 422, 'exige motivo');
      assert.equal((await moderate(ctx.fixtures.companyA, { entity: 'profile', action: 'suspend', note: 'Revisión de datos' })).status, 200);
      assert.equal((await get('/public/companies/empresa-a')).status, 404);
      assert.equal((await moderate(ctx.fixtures.companyA, { entity: 'profile', action: 'unsuspend' })).status, 200);
      assert.equal((await get('/public/companies/empresa-a')).status, 200);
    });

    it('una empresa no ACTIVE no tiene página pública aunque el perfil esté aprobado', async () => {
      await execute("UPDATE companies SET status = 'SUSPENDED' WHERE id = ?", [ctx.fixtures.companyA]);
      try {
        assert.equal((await get('/public/companies/empresa-a')).status, 404);
      } finally {
        await execute("UPDATE companies SET status = 'ACTIVE' WHERE id = ?", [ctx.fixtures.companyA]);
      }
    });
  });

  // ======================================================================= slug
  describe('URL pública (slug)', () => {
    it('solo el ADMIN cambia el slug, y debe ser único', async () => {
      assert.equal((await put('/company/profile/slug', { slug: 'mi-empresa' }, token('companyAdmin'))).status, 403);
      await get('/company/profile', token('companyAdminB')); // crea el perfil de B (empresa-b)
      const choque = await put(`/company/profile/slug?company_id=${ctx.fixtures.companyA}`, { slug: 'empresa-b' }, token('admin'));
      assert.equal(choque.status, 409);
      assert.equal((await put(`/company/profile/slug?company_id=${ctx.fixtures.companyA}`, { slug: 'Mal Slug!' }, token('admin'))).status, 422);
      const ok = await put(`/company/profile/slug?company_id=${ctx.fixtures.companyA}`, { slug: 'transportes-a' }, token('admin'));
      assert.equal(ok.status, 200);
      assert.equal((await get('/public/companies/transportes-a')).status, 200);
      assert.equal((await get('/public/companies/empresa-a')).status, 404);
      await put(`/company/profile/slug?company_id=${ctx.fixtures.companyA}`, { slug: 'empresa-a' }, token('admin'));
    });
  });

  // ======================================================================= servicios
  describe('Servicios', () => {
    let serviceId = 0;

    it('crea un servicio con características dinámicas (sin repetidos)', async () => {
      const res = await post('/company/profile/services', {
        name: 'Bus Cama', description: 'Asientos que se reclinan 160°.', features: ['Asientos reclinables', 'USB', 'Baño', 'usb'],
      }, token('companyAdmin'));
      assert.equal(res.status, 201, JSON.stringify(res.body));
      serviceId = res.body.data.id;
      assert.deepEqual(res.body.data.features, ['Asientos reclinables', 'USB', 'Baño']);
      assert.equal(res.body.data.review_status, 'DRAFT');
    });

    it('otra empresa no puede ver, editar, enviar ni borrar el servicio (404)', async () => {
      assert.equal((await put(`/company/profile/services/${serviceId}`, { name: 'Robado' }, token('companyAdminB'))).status, 404);
      assert.equal((await post(`/company/profile/services/${serviceId}/submit`, {}, token('companyAdminB'))).status, 404);
      assert.equal((await del(`/company/profile/services/${serviceId}`, token('companyAdminB'))).status, 404);
      const listaB = await get('/company/profile/services', token('companyAdminB'));
      assert.equal(listaB.body.data.length, 0);
    });

    it('no se publica hasta aprobarse; aprobado aparece en el perfil público', async () => {
      assert.equal((await get('/public/companies/empresa-a')).body.data.services.length, 0);
      assert.equal((await post(`/company/profile/services/${serviceId}/submit`, {}, token('companyAdmin'))).status, 200);
      assert.equal((await moderate(ctx.fixtures.companyA, { entity: 'service', id: serviceId, action: 'approve' })).status, 200);
      const pub = await get('/public/companies/empresa-a');
      assert.equal(pub.body.data.services.length, 1);
      assert.equal(pub.body.data.services[0].name, 'Bus Cama');
      assert.equal(pub.body.data.services[0].review_status, undefined, 'el público no ve el estado interno');
    });

    it('desactivar lo oculta al instante; activar lo devuelve sin nueva revisión', async () => {
      await patch(`/company/profile/services/${serviceId}/active`, { is_active: false }, token('companyAdmin'));
      assert.equal((await get('/public/companies/empresa-a')).body.data.services.length, 0);
      await patch(`/company/profile/services/${serviceId}/active`, { is_active: true }, token('companyAdmin'));
      assert.equal((await get('/public/companies/empresa-a')).body.data.services.length, 1);
    });

    it('reordenar exige exactamente los ids propios', async () => {
      const segundo = await post('/company/profile/services', { name: 'Ejecutivo' }, token('companyAdmin'));
      const ajeno = await post('/company/profile/services', { name: 'De B' }, token('companyAdminB'));
      assert.equal((await put('/company/profile/services/reorder', { ids: [segundo.body.data.id, ajeno.body.data.id] }, token('companyAdmin'))).status, 400);
      const ok = await put('/company/profile/services/reorder', { ids: [segundo.body.data.id, serviceId] }, token('companyAdmin'));
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.body.data.map((s: { id: number }) => s.id), [segundo.body.data.id, serviceId]);
    });

    it('eliminar es baja lógica: desaparece del panel y del público, la fila se conserva', async () => {
      assert.equal((await del(`/company/profile/services/${serviceId}`, token('companyAdmin'))).status, 200);
      assert.equal((await get('/public/companies/empresa-a')).body.data.services.length, 0);
      const fila = await queryOne<{ deleted_at: string | null }>('SELECT deleted_at FROM company_services WHERE id = ?', [serviceId]);
      assert.ok(fila?.deleted_at);
    });
  });

  // ======================================================================= agencias
  describe('Agencias, horarios y mapa', () => {
    const base = { name: 'Agencia Lima Centro', city: 'Lima', address: 'Av. Ejemplo 123' };

    it('valida horarios: solapes, apertura después del cierre y horario especial ambiguo', async () => {
      const casos = [
        { weekly_hours: { 1: { ranges: [{ open: '08:00', close: '13:00' }, { open: '12:00', close: '18:00' }] } } },
        { weekly_hours: { 1: { ranges: [{ open: '22:00', close: '06:00' }] } } },
        { weekly_hours: { 8: { closed: true } } },
        { special_hours: [{ date: '2026-12-25', closed: true, ranges: [{ open: '08:00', close: '12:00' }] }] },
      ];
      for (const extra of casos) {
        const res = await post('/company/profile/agencies', { ...base, ...extra }, token('companyAdmin'));
        assert.equal(res.status, 422, JSON.stringify(extra));
      }
    });

    it('valida coordenadas: dentro del Perú y latitud con longitud', async () => {
      assert.equal((await post('/company/profile/agencies', { ...base, latitude: 40.4, longitude: -3.7 }, token('companyAdmin'))).status, 422);
      assert.equal((await post('/company/profile/agencies', { ...base, latitude: -12.05 }, token('companyAdmin'))).status, 422);
      assert.equal((await post('/company/profile/agencies', { ...base, services: ['VUELOS'] }, token('companyAdmin'))).status, 422);
    });

    it('crea una agencia completa: horario dividido, cerrado, especial y servicios propios', async () => {
      const res = await post('/company/profile/agencies', {
        ...base,
        department: 'Lima',
        location_id: ctx.fixtures.locations[0],
        reference: 'Frente al parque',
        phone: '01 555 1234',
        whatsapp: '+51 999 111 222',
        latitude: -12.0464,
        longitude: -77.0428,
        services: ['TICKET_SALES', 'BOARDING', 'PARCELS'],
        weekly_hours: { 1: { ranges: [{ open: '06:00', close: '13:00' }, { open: '14:00', close: '22:00' }] }, 7: { closed: true } },
        special_hours: [{ date: '2026-12-25', closed: true, note: 'Navidad' }],
      }, token('companyAdmin'));
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const id = res.body.data.id;
      assert.equal(res.body.data.weekly_hours['7'].closed, true);
      assert.equal(res.body.data.latitude, -12.0464);

      await post(`/company/profile/agencies/${id}/submit`, {}, token('companyAdmin'));
      await moderate(ctx.fixtures.companyA, { entity: 'agency', id, action: 'approve' });
      const pub = await get('/public/companies/empresa-a');
      // F18-19B (F-06): la vista pública no expone el id interno de la agencia ni su location_id.
      const agencia = pub.body.data.agencies.find((a: { name: string }) => a.name === base.name);
      assert.ok(agencia, 'la agencia aprobada aparece en el perfil público');
      assert.equal('id' in agencia, false, 'sin id interno');
      assert.equal('location_id' in agencia, false, 'sin location_id');
      assert.equal(agencia.city, 'Lima');
      assert.deepEqual(agencia.services, ['TICKET_SALES', 'BOARDING', 'PARCELS']);
      assert.equal(agencia.weekly_hours['1'].ranges.length, 2);
      assert.equal(agencia.longitude, -77.0428);
    });

    it('una ubicación inexistente se rechaza', async () => {
      assert.equal((await post('/company/profile/agencies', { ...base, location_id: 999999 }, token('companyAdmin'))).status, 400);
    });
  });

  // ======================================================================= galería e imágenes
  describe('Galería e imágenes: archivos peligrosos y dimensiones', () => {
    it('rechaza un archivo que no es imagen aunque se llame .png', async () => {
      const res = await upload('/company/profile/gallery', token('companyAdmin'), Buffer.from('<svg onload=alert(1)>'), 'x.png', 'image/png');
      assert.equal(res.status, 400);
    });

    it('rechaza SVG y MIME que no coincide con la extensión', async () => {
      assert.equal((await upload('/company/profile/gallery', token('companyAdmin'), Buffer.from('<svg/>'), 'x.svg', 'image/svg+xml')).status, 400);
      assert.equal((await upload('/company/profile/gallery', token('companyAdmin'), png(400, 300), 'x.png', 'image/jpeg')).status, 400);
    });

    it('rechaza imágenes demasiado pequeñas o enormes', async () => {
      assert.equal((await upload('/company/profile/gallery', token('companyAdmin'), png(10, 10))).status, 400);
      assert.equal((await upload('/company/profile/gallery', token('companyAdmin'), png(20000, 400))).status, 400);
    });

    it('acepta una imagen válida con metadatos, la guarda como referencia y la publica tras aprobarla', async () => {
      const res = await upload('/company/profile/gallery', token('companyAdmin'), png(800, 600), 'bus.png', 'image/png', { title: 'Nuestro bus', category: 'BUS' });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.match(res.body.data.image, new RegExp(`^public/companies/${ctx.fixtures.companyA}/[0-9a-f]{32}\\.png$`));
      assert.equal(res.body.data.width, 800);
      assert.equal(res.body.data.category, 'BUS');

      const html = await upload('/company/profile/gallery', token('companyAdmin'), png(800, 600), 'b.png', 'image/png', { title: '<script>x</script>' });
      assert.equal(html.status, 422, 'el título también es texto plano');

      assert.equal((await get('/public/companies/empresa-a/gallery')).body.data.length, 0);
      await post(`/company/profile/gallery/${res.body.data.id}/submit`, {}, token('companyAdmin'));
      await moderate(ctx.fixtures.companyA, { entity: 'gallery', id: res.body.data.id, action: 'approve' });
      const galeria = await get('/public/companies/empresa-a/gallery');
      assert.equal(galeria.body.data.length, 1);
      assert.equal(galeria.body.data[0].title, 'Nuestro bus');
      const servida = await fetch(`${testBaseUrl()}/public/media/${res.body.data.image}`);
      assert.equal(servida.status, 200);
    });

    it('portada del perfil: reemplazarla conserva la foto que sigue publicada', async () => {
      const primera = await upload('/company/profile/images/cover', token('companyAdmin'), png(1600, 600));
      assert.equal(primera.status, 200, JSON.stringify(primera.body));
      const ref1 = primera.body.data.cover_image;
      await post('/company/profile/submit', {}, token('companyAdmin'));
      await moderate(ctx.fixtures.companyA, { entity: 'profile', action: 'approve' });

      const segunda = await upload('/company/profile/images/cover', token('companyAdmin'), png(1600, 600));
      const ref2 = segunda.body.data.cover_image;
      assert.notEqual(ref1, ref2);
      assert.ok(fs.existsSync(path.resolve(process.cwd(), env.storage.dir, ref1)), 'la portada publicada no se borra mientras se revisa la nueva');
      assert.equal((await get('/public/companies/empresa-a')).body.data.profile.cover_image, ref1);

      await post('/company/profile/submit', {}, token('companyAdmin'));
      await moderate(ctx.fixtures.companyA, { entity: 'profile', action: 'approve' });
      assert.equal((await get('/public/companies/empresa-a')).body.data.profile.cover_image, ref2);
      assert.equal(fs.existsSync(path.resolve(process.cwd(), env.storage.dir, ref1)), false, 'al publicarse la nueva, la anterior se borra');
    });

    it('un slot de imagen desconocido responde 404', async () => {
      assert.equal((await upload('/company/profile/images/logo-falso', token('companyAdmin'), png(800, 600))).status, 404);
    });
  });

  // ======================================================================= datos reutilizados
  describe('Destinos, flota y opiniones reutilizan las entidades existentes', () => {
    before(async () => {
      // Una reseña publicada con respuesta de la empresa, sobre una reserva real del cliente.
      const seat = at(await freeSeats(ctx.fixtures.tripA), 0);
      const booking = await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [seat.id], passenger_email: 'cliente@test.pe' }, token('customer'));
      await post(`/bookings/${booking.body.data.id}/pay`, { method: 'CASH' }, token('admin'));
      const review = await execute(
        "INSERT INTO reviews (user_id, booking_id, trip_id, company_id, rating, title, comment, status) VALUES (?, ?, ?, ?, 4, 'Buen viaje', 'Puntual', 'PUBLISHED')",
        [ctx.fixtures.users.customer, booking.body.data.id, ctx.fixtures.tripA, ctx.fixtures.companyA],
      );
      await execute('INSERT INTO review_responses (review_id, user_id, response) VALUES (?, ?, ?)', [review.insertId, ctx.fixtures.users.companyAdmin, '¡Gracias por viajar con nosotros!']);
    });

    it('destinos: salen de las rutas activas, con viajes próximos y enlace al buscador', async () => {
      const pub = await get('/public/companies/empresa-a');
      const huanuco = pub.body.data.destinations.find((d: { city: string }) => d.city === 'Huánuco');
      assert.ok(huanuco, JSON.stringify(pub.body.data.destinations));
      assert.ok(huanuco.upcoming_trips >= 1);
      assert.equal(huanuco.origins[0].city, 'Lima');
      assert.equal(pub.body.data.destinations.some((d: { city: string }) => d.city === 'Huaraz'), false, 'Huaraz es una ruta de la empresa B');
    });

    it('flota: tipo, capacidad y comodidades, SIN placa, código ni marca', async () => {
      const pub = await get('/public/companies/empresa-a');
      assert.equal(pub.body.data.fleet.length, 1);
      assert.equal(pub.body.data.fleet[0].buses, 1);
      assert.deepEqual(pub.body.data.fleet[0].amenities, ['USB', 'WiFi']);
      const plano = JSON.stringify(pub.body.data);
      for (const sensible of ['AAA-111', 'A-001', 'plate_number', '"code"', 'Marca']) assert.equal(plano.includes(sensible), false, sensible);
    });

    it('opiniones: resumen y reseñas publicadas con la respuesta de la empresa, solo con el nombre de pila', async () => {
      const pub = await get('/public/companies/empresa-a');
      assert.equal(pub.body.data.reviews.total, 1);
      assert.equal(pub.body.data.reviews.rating, 4);
      const reviews = await get('/public/companies/empresa-a/reviews');
      assert.equal(reviews.status, 200);
      assert.equal(reviews.body.data[0].first_name, 'Clara');
      assert.equal(reviews.body.data[0].company_response, '¡Gracias por viajar con nosotros!');
      const plano = JSON.stringify(reviews.body.data);
      for (const sensible of ['cliente@test.pe', 'last_name', 'booking_code', 'Prueba']) assert.equal(plano.includes(sensible), false, sensible);
    });

    it('F18-19B · la vista pública no expone ids internos; la vista previa de la empresa sí los conserva', async () => {
      // Contenido propio, publicado, para no depender del orden de las demás pruebas.
      const tk = token('companyAdmin');
      const servicio = (await post('/company/profile/services', { name: 'Servicio F-06' }, tk)).body.data.id;
      const agencia = (await post('/company/profile/agencies', { name: 'Agencia F-06', city: 'Lima', address: 'Av. F-06 1', location_id: ctx.fixtures.locations[0] }, tk)).body.data.id;
      const foto = (await upload('/company/profile/gallery', tk, png(400, 300), 'f06.png', 'image/png', { title: 'Foto F-06' })).body.data.id;
      for (const [tipo, entidad, id] of [['services', 'service', servicio], ['agencies', 'agency', agencia], ['gallery', 'gallery', foto]] as const) {
        assert.equal((await post(`/company/profile/${tipo}/${id}/submit`, {}, tk)).status, 200);
        assert.equal((await moderate(ctx.fixtures.companyA, { entity: entidad, id, action: 'approve' })).status, 200);
      }
      const pub = (await get('/public/companies/empresa-a')).body.data;
      assert.ok(pub.services.some((s: { name: string }) => s.name === 'Servicio F-06') && pub.agencies.some((a: { name: string }) => a.name === 'Agencia F-06')
        && pub.gallery.items.some((g: { title: string }) => g.title === 'Foto F-06'), 'los elementos aprobados son públicos');
      for (const [grupo, filas] of [['servicios', pub.services], ['agencias', pub.agencies], ['galería', pub.gallery.items]] as const) {
        for (const fila of filas as Array<Record<string, unknown>>) {
          assert.equal('id' in fila, false, `${grupo}: id interno`);
          assert.equal('location_id' in fila, false, `${grupo}: location_id`);
        }
      }
      const galeria = (await get('/public/companies/empresa-a/gallery')).body.data as Array<Record<string, unknown>>;
      assert.ok(galeria.length && galeria.every((foto) => !('id' in foto) && typeof foto.image === 'string'), 'galería paginada sin ids, identificada por su imagen');
      const opiniones = (await get('/public/companies/empresa-a/reviews')).body.data as Array<Record<string, unknown>>;
      assert.ok(opiniones.length && opiniones.every((o) => !('id' in o)), 'opiniones sin id');
      // Único id público: el de la empresa, el que ya usa el buscador existente (/buscar?company_id=…).
      assert.equal(pub.company.id, ctx.fixtures.companyA);

      const vista = (await get('/company/profile/preview', token('companyAdmin'))).body.data;
      assert.ok(vista.services.every((s: { id?: number }) => Number.isInteger(s.id)), 'la vista previa conserva los ids para editar');
    });

    it('F18-19D · el listado trae la fecha de la próxima salida visible y el buscador la encuentra', async () => {
      const viaje = await queryOne<{ salida: string }>("SELECT DATE_FORMAT(departure_datetime, '%Y-%m-%d') AS salida FROM trips WHERE id = ?", [ctx.fixtures.tripB]);
      const empresaB = async () => ((await get('/public/companies')).body.data as Array<{ id: number; next_departure_date: string | null }>)
        .find((c) => c.id === ctx.fixtures.companyB);
      assert.equal((await empresaB())?.next_departure_date, viaje?.salida, 'la próxima salida de B es la de su único viaje');
      const busqueda = await get(`/public/trips?company_id=${ctx.fixtures.companyB}&date=${viaje?.salida}`);
      assert.ok((busqueda.body.data as Array<{ id: number }>).some((t) => t.id === ctx.fixtures.tripB), '«Ver viajes» con esa fecha muestra el viaje');

      // Un viaje cancelado no cuenta: sin salidas visibles no hay fecha (la tarjeta usa hoy, como antes).
      await execute("UPDATE trips SET status = 'CANCELLED' WHERE id = ?", [ctx.fixtures.tripB]);
      try {
        assert.equal((await empresaB())?.next_departure_date, null);
      } finally {
        await execute("UPDATE trips SET status = 'SCHEDULED' WHERE id = ?", [ctx.fixtures.tripB]);
      }
    });
  });

  // ======================================================================= supervisión ADMIN
  describe('Supervisión del ADMIN', () => {
    it('cola de moderación con pendientes y rechazados', async () => {
      await post('/company/profile/services', { name: 'Comercial' }, token('companyAdminB'))
        .then((r) => post(`/company/profile/services/${r.body.data.id}/submit`, {}, token('companyAdminB')));
      const cola = await get('/admin/company-profiles?status=PENDING', token('admin'));
      assert.equal(cola.status, 200);
      const empresaB = cola.body.data.find((c: { company_id: number }) => c.company_id === ctx.fixtures.companyB);
      assert.ok(empresaB && empresaB.pending_count >= 1, JSON.stringify(cola.body.data));
    });

    it('detalle con todas las pestañas y auditoría de la empresa', async () => {
      const detalle = await get(`/admin/company-profiles/${ctx.fixtures.companyA}`, token('admin'));
      assert.equal(detalle.status, 200);
      for (const key of ['profile', 'services', 'agencies', 'gallery', 'destinations', 'fleet', 'reviews']) assert.ok(key in detalle.body.data, key);
      const auditoria = await get(`/admin/company-profiles/${ctx.fixtures.companyA}/audit?limit=100`, token('admin'));
      assert.equal(auditoria.status, 200);
      const acciones = new Set(auditoria.body.data.map((a: { action: string }) => a.action));
      for (const accion of ['UPDATE', 'SUBMIT', 'APPROVE', 'REJECT', 'SUSPEND', 'CREATE', 'DELETE']) assert.ok(acciones.has(accion), accion);
    });

    it('el ADMIN puede corregir contenido crítico de una empresa y aprobarlo', async () => {
      const res = await put(`/company/profile?company_id=${ctx.fixtures.companyB}`, { tagline: 'Corregido por la plataforma' }, token('admin'));
      assert.equal(res.status, 200);
      assert.equal(res.body.data.company_id, ctx.fixtures.companyB);
      assert.equal((await moderate(ctx.fixtures.companyB, { entity: 'profile', action: 'approve' })).status, 200);
      assert.equal((await get('/public/companies/empresa-b')).body.data.profile.tagline, 'Corregido por la plataforma');
    });
  });
});
