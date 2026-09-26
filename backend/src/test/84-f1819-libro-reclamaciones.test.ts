import './helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { get, patch, post } from './helpers/api';
import { at, freeSeats } from './helpers/fixtures';
import { queryOne } from '../config/database';
import { emailTransport, type MemoryTransport } from '../services/email.service';
import { addBusinessDays, limaDate } from '../services/complaint-book.service';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * F18-19 · Libro de Reclamaciones virtual (DS 011-2011-PCM y DS 101-2022-PCM).
 *
 * Comprueba lo que exige la norma y lo que exige la seguridad: numeración correlativa, campos mínimos
 * obligatorios, copia al correo, plazo de 15 días hábiles, respuesta escrita única con historial, consulta
 * sin enumerar hojas ajenas y aislamiento entre empresas (una empresa solo ve SUS hojas y sin datos de
 * contacto del consumidor).
 */

const hoja = (extra: Record<string, unknown> = {}) => ({
  kind: 'RECLAMO',
  consumer_name: 'María Quispe',
  consumer_document_type: 'DNI',
  consumer_document_number: '45678912',
  consumer_address: 'Jr. Los Pinos 123, Huánuco',
  consumer_phone: '999 123 456',
  consumer_email: 'maria@correo.pe',
  item_type: 'SERVICIO',
  item_description: 'Pasaje Lima - Huánuco',
  claimed_amount: 45,
  detail: 'El bus salió dos horas tarde sin aviso previo.',
  request: 'Devolución del importe del pasaje.',
  accepted: true,
  ...extra,
});

describe('F18-19 · Libro de Reclamaciones', () => {
  let ctx: SuiteContext;
  let buzon: MemoryTransport;
  const token = (role: keyof SuiteContext['sessions']) => ctx.sessions[role].token;
  const year = () => limaDate().slice(0, 4);

  before(async () => {
    ctx = await prepareSuite();
    buzon = emailTransport() as MemoryTransport;
  });
  beforeEach(() => buzon.clear());
  after(teardownSuite);

  describe('Registro de la hoja', () => {
    it('numera correlativamente por año, calcula el plazo y envía la copia al correo del consumidor', async () => {
      const primera = await post('/public/complaints', hoja());
      assert.equal(primera.status, 201, JSON.stringify(primera.body));
      assert.equal(primera.body.data.code, `LR-${year()}-000001`);
      assert.equal(primera.body.data.due_date, addBusinessDays(limaDate(), 15));
      assert.equal(primera.body.data.copy_emailed, true);
      assert.match(primera.body.data.sheet, /HOJA DE RECLAMACIÓN VIRTUAL/);
      assert.match(primera.body.data.sheet, /\[PENDIENTE: razón social\]/, 'los datos del proveedor que faltan se marcan, no se inventan');

      const correo = buzon.sent.find((m) => m.to === 'maria@correo.pe');
      assert.ok(correo);
      assert.match(correo!.subject, new RegExp(`LR-${year()}-000001`));
      assert.match(correo!.text, /Devolución del importe/);

      const segunda = await post('/public/complaints', hoja({ kind: 'QUEJA' }));
      assert.equal(segunda.body.data.code, `LR-${year()}-000002`);
    });

    it('el plazo cuenta 15 días hábiles desde el día siguiente, sin sábados ni domingos', () => {
      assert.equal(addBusinessDays('2026-09-25', 15), '2026-10-16'); // viernes → viernes de la 3.ª semana
      assert.equal(addBusinessDays('2026-09-26', 1), '2026-09-28'); // sábado → lunes
    });

    it('exige los campos mínimos del Anexo 1 y la conformidad (reemplaza la firma)', async () => {
      for (const campo of ['consumer_name', 'consumer_document_number', 'consumer_address', 'consumer_phone', 'consumer_email', 'item_description', 'detail', 'request']) {
        const body = hoja();
        delete (body as Record<string, unknown>)[campo];
        assert.equal((await post('/public/complaints', body)).status, 422, campo);
      }
      assert.equal((await post('/public/complaints', hoja({ accepted: false }))).status, 422);
      assert.equal((await post('/public/complaints', hoja({ kind: 'SUGERENCIA' }))).status, 422);
    });

    it('valida el documento según su tipo', async () => {
      assert.equal((await post('/public/complaints', hoja({ consumer_document_number: '1234' }))).status, 422);
      assert.equal((await post('/public/complaints', hoja({ consumer_document_type: 'RUC', consumer_document_number: '30123456789' }))).status, 422);
      assert.equal((await post('/public/complaints', hoja({ consumer_document_type: 'RUC', consumer_document_number: '20123456789' }))).status, 201);
    });

    it('un menor de edad exige los datos de su padre, madre o representante', async () => {
      assert.equal((await post('/public/complaints', hoja({ is_minor: true }))).status, 422);
      const ok = await post('/public/complaints', hoja({
        is_minor: true, guardian_name: 'Rosa Quispe', guardian_address: 'Jr. Los Pinos 123', guardian_phone: '999 000 111', guardian_email: 'rosa@correo.pe',
      }));
      assert.equal(ok.status, 201);
      assert.match(ok.body.data.sheet, /Rosa Quispe/);
    });

    it('rechaza HTML en el detalle y campos que no existen (p. ej. el estado)', async () => {
      assert.equal((await post('/public/complaints', hoja({ detail: 'Mal servicio <script>alert(1)</script>' }))).status, 422);
      assert.equal((await post('/public/complaints', hoja({ status: 'CLOSED' }))).status, 422);
    });

    it('una empresa inexistente o inactiva no se puede relacionar', async () => {
      assert.equal((await post('/public/complaints', hoja({ company_id: 999999 }))).status, 400);
    });
  });

  describe('Relación con la reserva y la empresa', () => {
    let bookingCode = '';

    before(async () => {
      const seat = at(await freeSeats(ctx.fixtures.tripA), 0);
      const booking = await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [seat.id], passenger_email: 'cliente@test.pe' }, token('customer'));
      bookingCode = booking.body.data.booking_code;
    });

    it('la reserva PROPIA del usuario autenticado enlaza la hoja con su empresa', async () => {
      const res = await post('/public/complaints', hoja({ booking_code: bookingCode }), token('customer'));
      assert.equal(res.status, 201);
      const fila = await queryOne<{ company_id: number; booking_id: number }>('SELECT company_id, booking_id FROM complaint_book_entries WHERE code = ?', [res.body.data.code]);
      assert.equal(fila?.company_id, ctx.fixtures.companyA);
      assert.ok(fila?.booking_id);
    });

    it('una reserva ajena (o sin sesión) solo queda como texto: no enlaza empresa ni reserva', async () => {
      const ajena = await post('/public/complaints', hoja({ booking_code: bookingCode }), token('companyAdminB'));
      const anonima = await post('/public/complaints', hoja({ booking_code: bookingCode }));
      for (const res of [ajena, anonima]) {
        const fila = await queryOne<{ company_id: number | null; booking_id: number | null; booking_code: string }>(
          'SELECT company_id, booking_id, booking_code FROM complaint_book_entries WHERE code = ?', [res.body.data.code],
        );
        assert.equal(fila?.company_id, null);
        assert.equal(fila?.booking_id, null);
        assert.equal(fila?.booking_code, bookingCode);
      }
    });
  });

  describe('Consulta pública', () => {
    it('con código y documento devuelve el estado; con otro documento, lo mismo que un código inexistente', async () => {
      const creada = await post('/public/complaints', hoja({ consumer_document_number: '11112222' }));
      const code = creada.body.data.code;
      const ok = await post('/public/complaints/lookup', { code, document_number: '11112222' });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.data.status, 'RECEIVED');
      assert.equal(ok.body.data.consumer_email, undefined, 'la consulta no devuelve datos personales');

      const otro = await post('/public/complaints/lookup', { code, document_number: '99998888' });
      const inexistente = await post('/public/complaints/lookup', { code: `LR-${year()}-999999`, document_number: '11112222' });
      assert.equal(otro.status, 404);
      assert.equal(inexistente.status, 404);
      assert.equal(otro.body.message, inexistente.body.message);
      assert.equal((await post('/public/complaints/lookup', { code: 'cualquiera', document_number: '11112222' })).status, 422);
    });

    it('los datos del proveedor se exponen como PENDIENTES (null) mientras no se configuren', async () => {
      const legal = await get('/public/legal');
      assert.equal(legal.status, 200);
      assert.deepEqual(legal.body.data, { business_name: null, ruc: null, address: null, email: null, phone: null });
    });
  });

  describe('Gestión y aislamiento', () => {
    let entryA = 0;
    let entryB = 0;

    before(async () => {
      const seatA = at(await freeSeats(ctx.fixtures.tripA), 0);
      const bookingA = await post('/bookings', { trip_id: ctx.fixtures.tripA, seat_ids: [seatA.id], passenger_email: 'cliente@test.pe' }, token('customer'));
      const a = await post('/public/complaints', hoja({ booking_code: bookingA.body.data.booking_code }), token('customer'));
      entryA = Number((await queryOne<{ id: number }>('SELECT id FROM complaint_book_entries WHERE code = ?', [a.body.data.code]))!.id);
      const b = await post('/public/complaints', hoja({ company_id: ctx.fixtures.companyB }));
      entryB = Number((await queryOne<{ id: number }>('SELECT id FROM complaint_book_entries WHERE code = ?', [b.body.data.code]))!.id);
    });

    it('solo el ADMIN gestiona el libro', async () => {
      assert.equal((await get('/admin/complaints', token('companyAdmin'))).status, 403);
      assert.equal((await get('/admin/complaints', token('customer'))).status, 403);
      assert.equal((await patch(`/admin/complaints/${entryA}`, { status: 'IN_REVIEW' }, token('companyAdmin'))).status, 403);
      const lista = await get('/admin/complaints?company_id=' + ctx.fixtures.companyA, token('admin'));
      assert.equal(lista.status, 200);
      assert.ok(lista.body.data.every((e: { company_id: number }) => e.company_id === ctx.fixtures.companyA));
    });

    it('la empresa ve SOLO sus hojas y sin documento, domicilio, teléfono ni correo del consumidor', async () => {
      const listaA = await get('/company/complaints', token('companyAdmin'));
      assert.equal(listaA.status, 200);
      assert.ok(listaA.body.data.some((e: { id: number }) => e.id === entryA));
      assert.equal(listaA.body.data.some((e: { id: number }) => e.id === entryB), false);
      const plano = JSON.stringify(listaA.body.data);
      for (const sensible of ['45678912', 'maria@correo.pe', 'Los Pinos', '999 123 456']) assert.equal(plano.includes(sensible), false, sensible);

      assert.equal((await get(`/company/complaints/${entryB}`, token('companyAdmin'))).status, 404);
      assert.equal((await get(`/company/complaints/${entryB}?company_id=${ctx.fixtures.companyB}`, token('companyAdmin'))).status, 404, 'el parámetro no cambia de empresa');
      assert.equal((await get('/company/complaints', token('operator'))).status, 403);
    });

    it('la empresa deja su descargo; no ve las notas internas de la plataforma', async () => {
      assert.equal((await post(`/company/complaints/${entryB}/notes`, { note: 'Intento en hoja ajena' }, token('companyAdmin'))).status, 404);
      const descargo = await post(`/company/complaints/${entryA}/notes`, { note: 'El retraso se debió a un bloqueo de vía.' }, token('companyAdmin'));
      assert.equal(descargo.status, 200);
      await post(`/admin/complaints/${entryA}/notes`, { note: 'Nota interna de la plataforma' }, token('admin'));

      const vista = await get(`/company/complaints/${entryA}`, token('companyAdmin'));
      const eventos = vista.body.data.events.map((e: { event: string }) => e.event);
      assert.ok(eventos.includes('COMPANY_NOTE'));
      assert.equal(eventos.includes('INTERNAL_NOTE'), false);
      const admin = await get(`/admin/complaints/${entryA}`, token('admin'));
      assert.ok(admin.body.data.events.some((e: { event: string }) => e.event === 'INTERNAL_NOTE'));
    });

    it('el ADMIN responde por correo: estado ANSWERED, respuesta única y registrada', async () => {
      assert.equal((await patch(`/admin/complaints/${entryA}`, { response: 'Sin canal' }, token('admin'))).status, 422);
      const res = await patch(`/admin/complaints/${entryA}`, { response: 'Procedemos con la devolución en 5 días hábiles.', response_channel: 'EMAIL' }, token('admin'));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, 'ANSWERED');
      assert.ok(res.body.data.response_at);
      assert.ok(res.body.data.response_emailed_at);
      assert.ok(buzon.sent.some((m) => m.to === 'maria@correo.pe' && /Respuesta/.test(m.subject)));
      assert.ok(res.body.data.events.some((e: { event: string }) => e.event === 'RESPONSE_SENT'));

      const otra = await patch(`/admin/complaints/${entryA}`, { response: 'Otra respuesta', response_channel: 'EMAIL' }, token('admin'));
      assert.equal(otra.status, 409, 'la respuesta escrita no se reescribe');
    });

    it('transiciones: ANSWERED → CLOSED; de CLOSED no se vuelve atrás', async () => {
      assert.equal((await patch(`/admin/complaints/${entryA}`, { status: 'CLOSED' }, token('admin'))).status, 200);
      assert.equal((await patch(`/admin/complaints/${entryA}`, { status: 'IN_REVIEW' }, token('admin'))).status, 409);
      assert.equal((await patch(`/admin/complaints/${entryB}`, { status: 'CLOSED' }, token('admin'))).status, 409, 'no se cierra sin responder');
    });

    it('filtros del ADMIN: estado, tipo y búsqueda por código', async () => {
      const cerradas = await get('/admin/complaints?status=CLOSED', token('admin'));
      assert.ok(cerradas.body.data.every((e: { status: string }) => e.status === 'CLOSED'));
      const quejas = await get('/admin/complaints?kind=QUEJA', token('admin'));
      assert.ok(quejas.body.data.length >= 1 && quejas.body.data.every((e: { kind: string }) => e.kind === 'QUEJA'));
      const porCodigo = await get(`/admin/complaints?search=LR-${year()}-000001`, token('admin'));
      assert.equal(porCodigo.body.data.length, 1);
    });

    it('no existe forma de borrar una hoja (conservación de 2 años)', async () => {
      const res = await fetch(`${(await import('./helpers/api')).testBaseUrl()}/admin/complaints/${entryA}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token('admin')}` },
      });
      assert.equal(res.status, 404);
    });
  });
});
