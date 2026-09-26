import type { Request } from 'express';
import type { PoolConnection } from 'mysql2/promise';
import { execute, query, queryOne, withTransaction } from '../config/database';
import { requireAuth } from '../middleware/auth.middleware';
import { ApiError } from '../utils/ApiError';
import { recordAudit } from './audit.service';
import { resolveCompanyId } from './company-document.service';
import { sendEmail } from './email.service';
import { readPublicSettings } from './settings.service';

/**
 * F18-19 · Libro de Reclamaciones virtual.
 *
 * BASE LEGAL VERIFICADA (docs/production/F18-19-LEGAL-SOURCES.md):
 *   · DS 011-2011-PCM, art. 3.3/3.4 (reclamo y queja), art. 4 (libro virtual: copia imprimible y copia al
 *     correo), art. 5 y Anexo 1 (contenido mínimo; la conformidad reemplaza la firma), art. 12 (conservar 2 años).
 *   · DS 101-2022-PCM: responder en un plazo no mayor a 15 días hábiles (arts. 6 y 6-B).
 *
 * La hoja pertenece al Libro de BusPerú. Si se relaciona con una empresa de transporte, esa empresa la VE y
 * puede dejar su descargo; la respuesta formal y el estado los gestiona el ADMIN. Nada se borra.
 *
 * DATOS DEL PROVEEDOR: `legal.*` en `system_settings`. Mientras falten, la hoja los marca como PENDIENTES.
 */

type Row = Record<string, unknown>;
const TIME_ZONE = 'America/Lima';
export const RESPONSE_BUSINESS_DAYS = 15;

/** Fecha civil de Lima (AAAA-MM-DD). La numeración y el plazo se cuentan en hora peruana. */
export function limaDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/**
 * Plazo de respuesta: N días hábiles contados desde el día siguiente al registro, sin sábados ni domingos.
 * Los feriados nacionales NO se descuentan todavía (no hay calendario de feriados en el sistema): la fecha
 * es por tanto la más exigente posible, nunca una posterior a la legal. Ver informe (pendiente).
 */
export function addBusinessDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  let added = 0;
  while (added < days) {
    date.setUTCDate(date.getUTCDate() + 1);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) added += 1;
  }
  return date.toISOString().slice(0, 10);
}

export interface LegalInfo {
  business_name: string | null;
  ruc: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
}

export async function legalInfo(): Promise<LegalInfo> {
  const settings = await readPublicSettings();
  const read = (key: string) => {
    const value = settings[`legal.${key}`];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  };
  return { business_name: read('business_name'), ruc: read('ruc'), address: read('address'), email: read('email'), phone: read('phone') };
}

async function nextCode(connection: PoolConnection, year: number): Promise<{ code: string; sequence: number }> {
  await connection.query('INSERT IGNORE INTO complaint_book_counters (year, last_sequence) VALUES (?, 0)', [year]);
  const [rows] = await connection.query('SELECT last_sequence FROM complaint_book_counters WHERE year = ? FOR UPDATE', [year]);
  const sequence = Number((rows as Array<{ last_sequence: number }>)[0]?.last_sequence ?? 0) + 1;
  await connection.query('UPDATE complaint_book_counters SET last_sequence = ? WHERE year = ?', [sequence, year]);
  return { code: `LR-${year}-${String(sequence).padStart(6, '0')}`, sequence };
}

async function event(connection: PoolConnection | null, entryId: number, data: { event: string; from?: string | null; to?: string | null; note?: string | null; actorId?: number | null; actorRole?: string | null }): Promise<void> {
  const sql = `INSERT INTO complaint_book_events (entry_id, event, from_status, to_status, note, actor_user_id, actor_role) VALUES (?, ?, ?, ?, ?, ?, ?)`;
  const params = [entryId, data.event, data.from ?? null, data.to ?? null, data.note ?? null, data.actorId ?? null, data.actorRole ?? null];
  if (connection) await connection.query(sql, params);
  else await execute(sql, params);
}

const KIND_LABEL: Record<string, string> = { RECLAMO: 'Reclamo', QUEJA: 'Queja' };
const pending = (value: string | null, label: string) => value ?? `[PENDIENTE: ${label}]`;

/** Texto de la hoja (copia al correo e impresión). Solo datos del propio consumidor y del proveedor. */
export function sheetText(entry: Row, provider: LegalInfo): string {
  const lines = [
    `HOJA DE RECLAMACIÓN VIRTUAL N.º ${entry.code}`,
    `Fecha: ${String(entry.created_at)}`,
    '',
    'PROVEEDOR',
    `Razón social: ${pending(provider.business_name, 'razón social')}`,
    `RUC: ${pending(provider.ruc, 'RUC')}`,
    `Domicilio: ${pending(provider.address, 'domicilio')}`,
    '',
    '1. IDENTIFICACIÓN DEL CONSUMIDOR RECLAMANTE',
    `Nombre: ${entry.consumer_name}`,
    `Documento: ${entry.consumer_document_type} ${entry.consumer_document_number}`,
    `Domicilio: ${entry.consumer_address}`,
    `Teléfono: ${entry.consumer_phone}`,
    `Correo: ${entry.consumer_email}`,
    ...(entry.is_minor
      ? ['Menor de edad. Padre, madre o representante:', `  ${entry.guardian_name} · ${entry.guardian_address} · ${entry.guardian_phone} · ${entry.guardian_email}`]
      : []),
    '',
    '2. IDENTIFICACIÓN DEL BIEN CONTRATADO',
    `${entry.item_type === 'PRODUCTO' ? 'Producto' : 'Servicio'}: ${entry.item_description}`,
    `Monto reclamado: ${entry.claimed_amount === null || entry.claimed_amount === undefined ? '—' : `S/ ${Number(entry.claimed_amount).toFixed(2)}`}`,
    ...(entry.booking_code ? [`Código de reserva indicado: ${entry.booking_code}`] : []),
    '',
    `3. DETALLE DE LA RECLAMACIÓN Y PEDIDO DEL CONSUMIDOR — ${KIND_LABEL[String(entry.kind)] ?? entry.kind}`,
    `Detalle: ${entry.detail}`,
    `Pedido: ${entry.request}`,
    '',
    `Conformidad del consumidor registrada el ${String(entry.accepted_at)} (reemplaza la firma, DS 011-2011-PCM art. 5).`,
    `Fecha límite de respuesta: ${String(entry.due_date).slice(0, 10)} (${RESPONSE_BUSINESS_DAYS} días hábiles).`,
    '',
    'RECLAMO: disconformidad relacionada a los productos o servicios. QUEJA: disconformidad no relacionada a los',
    'productos o servicios, o malestar o descontento respecto a la atención al público (DS 011-2011-PCM, art. 3).',
    'La formulación del reclamo no impide acudir a otras vías de solución de controversias ni es requisito previo',
    'para interponer una denuncia ante el INDECOPI (DS 011-2011-PCM, art. 13).',
  ];
  return lines.join('\n');
}

/** Solo una reserva DEL PROPIO usuario autenticado enlaza la hoja con la empresa; si no, queda el texto. */
async function resolveBooking(req: Request, bookingCode: string | null | undefined): Promise<{ bookingId: number | null; companyId: number | null }> {
  if (!bookingCode || !req.user) return { bookingId: null, companyId: null };
  const booking = await queryOne<{ id: number; company_id: number }>(
    `SELECT bk.id, r.company_id FROM bookings bk JOIN trips t ON t.id = bk.trip_id JOIN routes r ON r.id = t.route_id
     WHERE bk.booking_code = ? AND bk.user_id = ? LIMIT 1`,
    [bookingCode, req.user.id],
  );
  return booking ? { bookingId: Number(booking.id), companyId: Number(booking.company_id) } : { bookingId: null, companyId: null };
}

export async function createComplaint(req: Request, body: Row): Promise<Row> {
  const today = limaDate();
  const year = Number(today.slice(0, 4));
  const dueDate = addBusinessDays(today, RESPONSE_BUSINESS_DAYS);
  const booking = await resolveBooking(req, body.booking_code as string | null | undefined);

  let companyId = booking.companyId;
  if (!companyId && body.company_id) {
    const company = await queryOne<{ id: number }>("SELECT id FROM companies WHERE id = ? AND status = 'ACTIVE'", [body.company_id]);
    if (!company) throw ApiError.badRequest('La empresa indicada no existe o no está activa');
    companyId = Number(company.id);
  }

  const { entryId, code } = await withTransaction(async (connection) => {
    const numbered = await nextCode(connection, year);
    const [result] = await connection.query(
      `INSERT INTO complaint_book_entries
        (code, year, sequence, kind, consumer_name, consumer_document_type, consumer_document_number, consumer_address, consumer_phone,
         consumer_email, is_minor, guardian_name, guardian_address, guardian_phone, guardian_email, item_type, item_description,
         claimed_amount, booking_code, booking_id, company_id, detail, request, accepted_at, user_id, ip_address, due_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?)`,
      [numbered.code, year, numbered.sequence, body.kind, body.consumer_name, body.consumer_document_type, body.consumer_document_number,
        body.consumer_address, body.consumer_phone, body.consumer_email, body.is_minor ? 1 : 0,
        body.is_minor ? body.guardian_name : null, body.is_minor ? body.guardian_address : null,
        body.is_minor ? body.guardian_phone : null, body.is_minor ? body.guardian_email : null,
        body.item_type, body.item_description, body.claimed_amount ?? null, body.booking_code ?? null, booking.bookingId, companyId,
        body.detail, body.request, req.user?.id ?? null, (req.ip ?? '').slice(0, 45) || null, dueDate],
    );
    const id = (result as { insertId: number }).insertId;
    await event(connection, id, { event: 'CREATED', to: 'RECEIVED', actorId: req.user?.id ?? null, actorRole: req.user?.role ?? 'PUBLICO' });
    return { entryId: id, code: numbered.code };
  });

  const entry = (await queryOne<Row>('SELECT * FROM complaint_book_entries WHERE id = ?', [entryId]))!;
  const provider = await legalInfo();
  const text = sheetText(entry, provider);
  // Copia al correo (art. 4). Un fallo del correo no anula la hoja: queda registrada y el consumidor puede imprimirla.
  const emailed = await sendEmail({ to: String(entry.consumer_email), subject: `Hoja de reclamación ${code} · BusPerú`, text });
  if (emailed) {
    await execute('UPDATE complaint_book_entries SET copy_emailed_at = NOW() WHERE id = ?', [entryId]);
    await event(null, entryId, { event: 'COPY_EMAILED', note: 'Copia de la hoja enviada al correo del consumidor' });
  }
  return { code, created_at: entry.created_at, due_date: entry.due_date, kind: entry.kind, copy_emailed: emailed, sheet: text, provider };
}

/** Consulta pública: código + documento. Cualquier discrepancia responde lo mismo que un código inexistente. */
export async function lookupComplaint(code: string, documentNumber: string): Promise<Row> {
  const entry = await queryOne<Row>(
    `SELECT code, kind, status, created_at, due_date, response, response_at, response_channel
     FROM complaint_book_entries WHERE code = ? AND consumer_document_number = ?`,
    [code, documentNumber],
  );
  if (!entry) throw ApiError.notFound('No encontramos una hoja con ese código y documento');
  return entry;
}

// =============================================================================== gestión (ADMIN)
export async function listComplaints(filters: Record<string, string>, search: string | null, page: number, limit: number): Promise<{ rows: Row[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries({ status: 'e.status', kind: 'e.kind', company_id: 'e.company_id' })) {
    if (filters[key] !== undefined) {
      conditions.push(`${column} = ?`);
      params.push(filters[key]);
    }
  }
  if (filters.overdue === 'true') conditions.push("e.status IN ('RECEIVED','IN_REVIEW') AND e.due_date < CURDATE()");
  if (filters.from) {
    conditions.push('e.created_at >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push('e.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(filters.to);
  }
  if (search) {
    conditions.push('(e.code LIKE ? OR e.consumer_name LIKE ? OR e.consumer_document_number LIKE ? OR e.booking_code LIKE ?)');
    params.push(...Array(4).fill(`%${search}%`));
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = await queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM complaint_book_entries e ${where}`, params);
  const rows = await query<Row>(
    `SELECT e.id, e.code, e.kind, e.status, e.consumer_name, e.item_description, e.booking_code, e.company_id, co.name AS company_name,
            e.created_at, e.due_date, e.response_at, (e.status IN ('RECEIVED','IN_REVIEW') AND e.due_date < CURDATE()) AS overdue
     FROM complaint_book_entries e LEFT JOIN companies co ON co.id = e.company_id
     ${where} ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit],
  );
  return { rows: rows.map((row) => ({ ...row, overdue: Boolean(row.overdue) })), total: Number(total?.total ?? 0) };
}

async function findEntry(id: number): Promise<Row> {
  const entry = await queryOne<Row>(
    `SELECT e.*, co.name AS company_name, bk.booking_code AS linked_booking_code
     FROM complaint_book_entries e LEFT JOIN companies co ON co.id = e.company_id LEFT JOIN bookings bk ON bk.id = e.booking_id
     WHERE e.id = ?`,
    [id],
  );
  if (!entry) throw ApiError.notFound('Hoja de reclamación no encontrada');
  return entry;
}

async function eventsOf(id: number, visibleToCompany = false): Promise<Row[]> {
  return query<Row>(
    `SELECT ev.id, ev.event, ev.from_status, ev.to_status, ev.note, ev.actor_role, ev.created_at, u.first_name, u.last_name
     FROM complaint_book_events ev LEFT JOIN users u ON u.id = ev.actor_user_id
     WHERE ev.entry_id = ?${visibleToCompany ? " AND ev.event <> 'INTERNAL_NOTE'" : ''}
     ORDER BY ev.created_at ASC, ev.id ASC`,
    [id],
  );
}

export async function complaintDetail(id: number): Promise<Row> {
  const entry = await findEntry(id);
  return { ...entry, overdue: ['RECEIVED', 'IN_REVIEW'].includes(String(entry.status)) && String(entry.due_date) < limaDate(), events: await eventsOf(id), sheet: sheetText(entry, await legalInfo()) };
}

const TRANSITIONS: Record<string, readonly string[]> = {
  RECEIVED: ['IN_REVIEW', 'ANSWERED'],
  IN_REVIEW: ['ANSWERED'],
  ANSWERED: ['CLOSED'],
  CLOSED: [],
};

/**
 * Cambio de estado y respuesta. La respuesta es ÚNICA (la comunicación escrita al consumidor): una vez
 * enviada no se reescribe; lo que haga falta después se deja como nota interna. Todo queda en el historial.
 */
export async function updateComplaint(req: Request, id: number, body: { status?: string; response?: string | null; response_channel?: string }): Promise<Row> {
  const actor = requireAuth(req);
  const entry = await findEntry(id);
  const from = String(entry.status);

  if (body.response) {
    if (entry.response) throw ApiError.conflict('La hoja ya tiene respuesta: registra lo adicional como nota interna');
    if (!TRANSITIONS[from]!.includes('ANSWERED')) throw ApiError.conflict('Esta hoja no admite respuesta en su estado actual');
    await withTransaction(async (connection) => {
      await connection.query(
        "UPDATE complaint_book_entries SET response = ?, response_channel = ?, response_at = NOW(), responded_by = ?, status = 'ANSWERED' WHERE id = ?",
        [body.response, body.response_channel, actor.id, id],
      );
      await event(connection, id, { event: 'RESPONSE_SENT', from, to: 'ANSWERED', note: `Respuesta registrada (canal: ${body.response_channel})`, actorId: actor.id, actorRole: actor.role });
    });
    if (body.response_channel === 'EMAIL') {
      const provider = await legalInfo();
      const text = [
        `Respuesta a su hoja de reclamación ${entry.code}`,
        '',
        String(body.response),
        '',
        `${pending(provider.business_name, 'razón social')} · RUC ${pending(provider.ruc, 'RUC')}`,
      ].join('\n');
      const sent = await sendEmail({ to: String(entry.consumer_email), subject: `Respuesta a su hoja de reclamación ${entry.code} · BusPerú`, text });
      if (sent) await execute('UPDATE complaint_book_entries SET response_emailed_at = NOW() WHERE id = ?', [id]);
      await event(null, id, { event: 'INTERNAL_NOTE', note: sent ? 'Respuesta enviada al correo del consumidor' : 'FALLÓ el envío del correo: enviar la respuesta por otro medio y dejar constancia', actorId: actor.id, actorRole: actor.role });
    }
    await recordAudit(req, { action: 'UPDATE', entityType: 'complaint_book_entries', entityId: id, description: `Respondió la hoja ${entry.code}`, oldValues: { status: from }, newValues: { status: 'ANSWERED', response_channel: body.response_channel } });
  }

  if (body.status) {
    const current = String((await findEntry(id)).status);
    if (current !== body.status) {
      if (!TRANSITIONS[current]!.includes(body.status)) throw ApiError.conflict(`No se puede pasar de ${current} a ${body.status}`);
      await execute('UPDATE complaint_book_entries SET status = ? WHERE id = ?', [body.status, id]);
      await event(null, id, { event: 'STATUS_CHANGED', from: current, to: body.status, actorId: actor.id, actorRole: actor.role });
      await recordAudit(req, { action: 'UPDATE', entityType: 'complaint_book_entries', entityId: id, description: `Hoja ${entry.code}: ${current} → ${body.status}`, oldValues: { status: current }, newValues: { status: body.status } });
    }
  }
  return complaintDetail(id);
}

export async function addInternalNote(req: Request, id: number, note: string): Promise<Row> {
  const actor = requireAuth(req);
  await findEntry(id);
  await event(null, id, { event: 'INTERNAL_NOTE', note, actorId: actor.id, actorRole: actor.role });
  return complaintDetail(id);
}

// =============================================================================== empresa relacionada
/** Lo que ve la empresa: la hoja SIN documento, domicilio, teléfono ni correo del consumidor. */
const COMPANY_FIELDS = `e.id, e.code, e.kind, e.status, e.consumer_name, e.item_type, e.item_description, e.claimed_amount, e.booking_code,
  e.detail, e.request, e.created_at, e.due_date, e.response, e.response_at`;

export async function companyComplaints(req: Request, page: number, limit: number): Promise<{ rows: Row[]; total: number }> {
  const companyId = resolveCompanyId(req, req.query.company_id);
  const total = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM complaint_book_entries WHERE company_id = ?', [companyId]);
  const rows = await query<Row>(
    `SELECT ${COMPANY_FIELDS} FROM complaint_book_entries e WHERE e.company_id = ? ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?`,
    [companyId, limit, (page - 1) * limit],
  );
  return { rows, total: Number(total?.total ?? 0) };
}

export async function companyComplaintDetail(req: Request, id: number): Promise<Row> {
  const companyId = resolveCompanyId(req, req.query.company_id);
  const entry = await queryOne<Row>(`SELECT ${COMPANY_FIELDS} FROM complaint_book_entries e WHERE e.id = ? AND e.company_id = ?`, [id, companyId]);
  // Una hoja de otra empresa (o sin empresa) responde igual que una inexistente.
  if (!entry) throw ApiError.notFound('Hoja de reclamación no encontrada');
  return { ...entry, events: await eventsOf(id, true) };
}

export async function addCompanyNote(req: Request, id: number, note: string): Promise<Row> {
  const actor = requireAuth(req);
  const companyId = resolveCompanyId(req, req.query.company_id);
  const entry = await queryOne<{ id: number; code: string }>('SELECT id, code FROM complaint_book_entries WHERE id = ? AND company_id = ?', [id, companyId]);
  if (!entry) throw ApiError.notFound('Hoja de reclamación no encontrada');
  await event(null, id, { event: 'COMPANY_NOTE', note, actorId: actor.id, actorRole: actor.role });
  await recordAudit(req, { action: 'CREATE', entityType: 'complaint_book_entries', entityId: id, description: `Descargo de la empresa en la hoja ${entry.code}` });
  return companyComplaintDetail(req, id);
}
