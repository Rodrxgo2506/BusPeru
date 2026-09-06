import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { execute, query, queryOne } from '../config/database';
import { env } from '../config/env';
import { del, get, put, testBaseUrl } from './helpers/api';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * Documentos de verificación de empresa (mockups 13 y 14).
 *
 * Los archivos se suben con `multipart/form-data`, así que estos tests construyen el
 * cuerpo con `FormData` en lugar de usar el helper JSON de la suite.
 */
describe('Documentos de verificación de empresa', () => {
  let ctx: SuiteContext;

  const RUTA = '/company/documents';

  /** Bytes mágicos reales de cada formato, para que el contenido case con la extensión. */
  const PDF = Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]), Buffer.alloc(64, 0x20)]);
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 0x00)]);
  const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x00)]);

  before(async () => {
    ctx = await prepareSuite();
  });
  after(async () => {
    await teardownSuite();
    // El almacén de la suite no debe sobrevivir a los tests.
    const root = path.resolve(process.cwd(), env.storage.dir, 'documents');
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await execute('DELETE FROM company_documents');
    await execute("DELETE FROM audit_logs WHERE entity_type = 'company_documents'");
    await execute('DELETE FROM notifications');

    const root = path.resolve(process.cwd(), env.storage.dir, 'documents');
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  /** Sube un archivo con multipart. Devuelve status y cuerpo, como el resto de helpers. */
  async function subir(
    token: string | undefined,
    options: { type?: string; filename?: string; content?: Buffer; mime?: string; notes?: string; extra?: Record<string, string> } = {},
  ): Promise<{ status: number; body: any }> {
    const form = new FormData();
    if (options.type !== undefined) form.append('type', options.type);
    if (options.notes !== undefined) form.append('notes', options.notes);
    for (const [key, value] of Object.entries(options.extra ?? {})) form.append(key, value);

    const content = options.content ?? PDF;
    form.append(
      'file',
      new Blob([new Uint8Array(content)], { type: options.mime ?? 'application/pdf' }),
      options.filename ?? 'ficha-ruc.pdf',
    );

    const res = await fetch(`${testBaseUrl()}${RUTA}`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    let body: any = {};
    try { body = await res.json(); } catch { body = {}; }
    return { status: res.status, body };
  }

  /** Documento válido de la empresa A ya subido. */
  async function documentoDeA(type = 'RUC') {
    const res = await subir(ctx.sessions.companyAdmin.token, { type });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  }

  describe('Carga y consulta', () => {
    it('sube un documento y queda PENDING', async () => {
      const res = await subir(ctx.sessions.companyAdmin.token, { type: 'RUC' });

      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.type, 'RUC');
      assert.equal(res.body.data.status, 'PENDING', 'siempre nace pendiente de revisión');
      assert.equal(Number(res.body.data.company_id), ctx.fixtures.companyA);
      assert.equal(res.body.data.reviewed_by, null);
      assert.equal(res.body.data.reviewed_at, null);
    });

    it('acepta los cinco tipos definidos', async () => {
      for (const type of ['RUC', 'LICENSE', 'INSURANCE', 'LEGAL_REP_ID', 'OTHER']) {
        assert.equal((await subir(ctx.sessions.companyAdmin.token, { type })).status, 201, type);
      }
      assert.equal((await query('SELECT id FROM company_documents')).length, 5);
    });

    it('acepta PDF, JPG y PNG', async () => {
      assert.equal((await subir(ctx.sessions.companyAdmin.token, { type: 'RUC', filename: 'a.pdf', content: PDF, mime: 'application/pdf' })).status, 201);
      assert.equal((await subir(ctx.sessions.companyAdmin.token, { type: 'LICENSE', filename: 'b.jpg', content: JPG, mime: 'image/jpeg' })).status, 201);
      assert.equal((await subir(ctx.sessions.companyAdmin.token, { type: 'INSURANCE', filename: 'c.png', content: PNG, mime: 'image/png' })).status, 201);
    });

    it('guarda el archivo en el almacén privado, no en la base', async () => {
      const doc = await documentoDeA();
      const fila = await queryOne<{ file_url: string }>('SELECT file_url FROM company_documents WHERE id = ?', [doc.id]);

      assert.match(fila!.file_url, /^documents\/\d+\/[0-9a-f]{32}\.pdf$/, 'referencia interna con nombre aleatorio');
      assert.doesNotMatch(fila!.file_url, /ficha-ruc/, 'el nombre del usuario no se usa como ruta');
      assert.ok(fs.existsSync(path.resolve(process.cwd(), env.storage.dir, fila!.file_url)), 'el archivo existe en disco');
    });

    it('lista los documentos de su empresa', async () => {
      await documentoDeA('RUC');
      await documentoDeA('LICENSE');

      const res = await get(RUTA, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 2);
    });

    it('sin documentos devuelve una lista vacía', async () => {
      assert.deepEqual((await get(RUTA, ctx.sessions.companyAdmin.token)).body.data, []);
    });

    it('consulta el detalle de un documento propio', async () => {
      const doc = await documentoDeA();
      const res = await get(`${RUTA}/${doc.id}`, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 200);
      assert.equal(Number(res.body.data.id), Number(doc.id));
    });

    it('descarga el archivo por el endpoint autorizado', async () => {
      const doc = await documentoDeA();
      const res = await fetch(`${testBaseUrl()}${RUTA}/${doc.id}/file`, {
        headers: { Authorization: `Bearer ${ctx.sessions.companyAdmin.token}` },
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/pdf');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.match(String(res.headers.get('content-disposition')), /attachment/, 'se descarga, no se interpreta');
    });

    it('reemplazar un documento del mismo tipo lo devuelve a PENDING', async () => {
      const primero = await documentoDeA('RUC');
      const fila = await queryOne<{ file_url: string }>('SELECT file_url FROM company_documents WHERE id = ?', [primero.id]);
      const rutaAntigua = path.resolve(process.cwd(), env.storage.dir, fila!.file_url);

      // Se verifica primero, para comprobar que el reemplazo lo devuelve a revisión.
      await put(`${RUTA}/${primero.id}/review`, { status: 'VERIFIED' }, ctx.sessions.admin.token);

      const segundo = await subir(ctx.sessions.companyAdmin.token, { type: 'RUC', filename: 'ruc-v2.pdf' });
      assert.equal(segundo.status, 200, 'reemplazo, no alta nueva');
      assert.equal(Number(segundo.body.data.id), Number(primero.id), 'es el mismo documento');
      assert.equal(segundo.body.data.status, 'PENDING');
      assert.equal(segundo.body.data.reviewed_by, null, 'se borra la revisión anterior');

      assert.equal((await query('SELECT id FROM company_documents')).length, 1, 'no se duplica la fila');
      assert.ok(!fs.existsSync(rutaAntigua), 'el archivo anterior se elimina del almacén');
    });

    it('elimina un documento pendiente y su archivo', async () => {
      const doc = await documentoDeA();
      const fila = await queryOne<{ file_url: string }>('SELECT file_url FROM company_documents WHERE id = ?', [doc.id]);
      const ruta = path.resolve(process.cwd(), env.storage.dir, fila!.file_url);

      assert.equal((await del(`${RUTA}/${doc.id}`, ctx.sessions.companyAdmin.token)).status, 200);
      assert.equal((await query('SELECT id FROM company_documents WHERE id = ?', [doc.id])).length, 0);
      assert.ok(!fs.existsSync(ruta), 'el archivo desaparece del disco');
    });

    it('no permite eliminar un documento ya verificado', async () => {
      const doc = await documentoDeA();
      await put(`${RUTA}/${doc.id}/review`, { status: 'VERIFIED' }, ctx.sessions.admin.token);

      const res = await del(`${RUTA}/${doc.id}`, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 400);
      assert.equal((await query('SELECT id FROM company_documents WHERE id = ?', [doc.id])).length, 1);
    });
  });

  describe('Revisión administrativa', () => {
    it('el ADMIN verifica un documento', async () => {
      const doc = await documentoDeA();
      const res = await put(`${RUTA}/${doc.id}/review`, { status: 'VERIFIED' }, ctx.sessions.admin.token);

      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'VERIFIED');
      assert.equal(Number(res.body.data.reviewed_by), ctx.sessions.admin.user.id);
      assert.ok(res.body.data.reviewed_at, 'queda la fecha de revisión');
    });

    it('el ADMIN rechaza indicando el motivo', async () => {
      const doc = await documentoDeA();
      const res = await put(
        `${RUTA}/${doc.id}/review`,
        { status: 'REJECTED', notes: 'La ficha RUC está vencida' },
        ctx.sessions.admin.token,
      );

      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'REJECTED');
      assert.equal(res.body.data.notes, 'La ficha RUC está vencida');
    });

    it('rechazar sin motivo se rechaza', async () => {
      const doc = await documentoDeA();
      assert.equal((await put(`${RUTA}/${doc.id}/review`, { status: 'REJECTED' }, ctx.sessions.admin.token)).status, 422);
      assert.equal((await put(`${RUTA}/${doc.id}/review`, { status: 'REJECTED', notes: '   ' }, ctx.sessions.admin.token)).status, 422);

      const fila = await queryOne<{ status: string }>('SELECT status FROM company_documents WHERE id = ?', [doc.id]);
      assert.equal(fila?.status, 'PENDING', 'sigue igual');
    });

    it('un COMPANY_ADMIN no puede aprobar sus propios documentos', async () => {
      const doc = await documentoDeA();
      const res = await put(`${RUTA}/${doc.id}/review`, { status: 'VERIFIED' }, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 403);
      const fila = await queryOne<{ status: string }>('SELECT status FROM company_documents WHERE id = ?', [doc.id]);
      assert.equal(fila?.status, 'PENDING');
    });

    it('un OPERATOR no puede revisar', async () => {
      const doc = await documentoDeA();
      assert.equal((await put(`${RUTA}/${doc.id}/review`, { status: 'VERIFIED' }, ctx.sessions.operator.token)).status, 403);
    });

    it('la revisión solo admite VERIFIED o REJECTED', async () => {
      const doc = await documentoDeA();
      for (const status of ['PENDING', 'APROBADO', '', 'DELETED']) {
        assert.equal((await put(`${RUTA}/${doc.id}/review`, { status }, ctx.sessions.admin.token)).status, 422, `status="${status}"`);
      }
    });

    it('la revisión no cambia el estado de la empresa', async () => {
      const antes = await queryOne<{ status: string }>('SELECT status FROM companies WHERE id = ?', [ctx.fixtures.companyA]);
      const doc = await documentoDeA();
      await put(`${RUTA}/${doc.id}/review`, { status: 'VERIFIED' }, ctx.sessions.admin.token);

      const despues = await queryOne<{ status: string }>('SELECT status FROM companies WHERE id = ?', [ctx.fixtures.companyA]);
      assert.equal(despues?.status, antes?.status, 'aprobar la empresa sigue siendo una acción aparte');
    });

    it('notifica al administrador de la empresa al verificar y al rechazar', async () => {
      const doc = await documentoDeA();
      await put(`${RUTA}/${doc.id}/review`, { status: 'REJECTED', notes: 'Ilegible' }, ctx.sessions.admin.token);

      let avisos = await query<{ user_id: number; title: string; message: string }>(
        "SELECT user_id, title, message FROM notifications WHERE JSON_UNQUOTE(JSON_EXTRACT(data,'$.event')) = 'company.document_rejected'",
      );
      assert.equal(avisos.length, 1);
      assert.equal(Number(avisos[0]!.user_id), ctx.sessions.companyAdmin.user.id);
      assert.match(avisos[0]!.message, /Ilegible/, 'el motivo llega a la empresa');

      await put(`${RUTA}/${doc.id}/review`, { status: 'VERIFIED' }, ctx.sessions.admin.token);
      avisos = await query(
        "SELECT user_id, title, message FROM notifications WHERE JSON_UNQUOTE(JSON_EXTRACT(data,'$.event')) = 'company.document_verified'",
      );
      assert.equal(avisos.length, 1);
    });
  });

  describe('Línea de tiempo de verificación', () => {
    it('sin documentos, la etapa de documentos está pendiente', async () => {
      const res = await get(`${RUTA}/verification-status`, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 200);
      assert.equal(res.body.data.stages.length, 4);
      assert.equal(res.body.data.stages[0].status, 'DONE', 'la información de la empresa ya está');
      assert.equal(res.body.data.stages[1].status, 'PENDING');
    });

    it('con documentos subidos, la etapa pasa a en curso', async () => {
      await documentoDeA();
      const res = await get(`${RUTA}/verification-status`, ctx.sessions.companyAdmin.token);
      assert.equal(res.body.data.stages[1].status, 'IN_PROGRESS');
    });

    it('con un documento rechazado, la etapa queda bloqueada', async () => {
      const doc = await documentoDeA();
      await put(`${RUTA}/${doc.id}/review`, { status: 'REJECTED', notes: 'Vencido' }, ctx.sessions.admin.token);

      const res = await get(`${RUTA}/verification-status`, ctx.sessions.companyAdmin.token);
      assert.equal(res.body.data.stages[1].status, 'BLOCKED');
      assert.equal(Number(res.body.data.documents.rejected), 1);
    });

    it('con todo verificado y la empresa aún sin aprobar, la revisión administrativa avanza', async () => {
      // La empresa de las fixtures ya está ACTIVE; se pone en PENDING para ver la etapa intermedia.
      await execute("UPDATE companies SET status = 'PENDING' WHERE id = ?", [ctx.fixtures.companyA]);
      try {
        const doc = await documentoDeA();
        await put(`${RUTA}/${doc.id}/review`, { status: 'VERIFIED' }, ctx.sessions.admin.token);

        const res = await get(`${RUTA}/verification-status`, ctx.sessions.companyAdmin.token);
        assert.equal(res.body.data.stages[1].status, 'DONE');
        assert.equal(res.body.data.stages[2].status, 'IN_PROGRESS', 'documentos listos, empresa aún sin aprobar');
        assert.equal(res.body.data.stages[3].status, 'PENDING');
      } finally {
        await execute("UPDATE companies SET status = 'ACTIVE' WHERE id = ?", [ctx.fixtures.companyA]);
      }
    });

    it('con la empresa aprobada, todas las etapas se completan', async () => {
      const doc = await documentoDeA();
      await put(`${RUTA}/${doc.id}/review`, { status: 'VERIFIED' }, ctx.sessions.admin.token);

      const res = await get(`${RUTA}/verification-status`, ctx.sessions.companyAdmin.token);
      assert.deepEqual(res.body.data.stages.map((s: { status: string }) => s.status), ['DONE', 'DONE', 'DONE', 'DONE']);
    });
  });

  describe('Aislamiento multiempresa', () => {
    /** Documento de la empresa B, creado directamente para preparar el escenario. */
    async function documentoDeB(): Promise<number> {
      const result = await execute(
        "INSERT INTO company_documents (company_id, type, file_url, status) VALUES (?, 'RUC', 'documents/999/ajeno.pdf', 'PENDING')",
        [ctx.fixtures.companyB],
      );
      return result.insertId;
    }

    it('cada empresa ve solo sus documentos', async () => {
      await documentoDeA();
      await documentoDeB();

      const a = await get(RUTA, ctx.sessions.companyAdmin.token);
      assert.equal(a.body.data.length, 1);
      assert.equal(Number(a.body.data[0].company_id), ctx.fixtures.companyA);

      const b = await get(RUTA, ctx.sessions.companyAdminB.token);
      assert.equal(b.body.data.length, 1);
      assert.equal(Number(b.body.data[0].company_id), ctx.fixtures.companyB);
    });

    it('no puede consultar el documento de otra empresa', async () => {
      const ajeno = await documentoDeB();
      assert.equal((await get(`${RUTA}/${ajeno}`, ctx.sessions.companyAdmin.token)).status, 404, '404 y no 403');
    });

    it('no puede descargar el archivo de otra empresa', async () => {
      const ajeno = await documentoDeB();
      const res = await fetch(`${testBaseUrl()}${RUTA}/${ajeno}/file`, {
        headers: { Authorization: `Bearer ${ctx.sessions.companyAdmin.token}` },
      });
      assert.equal(res.status, 404);
    });

    it('no puede eliminar el documento de otra empresa', async () => {
      const ajeno = await documentoDeB();
      assert.equal((await del(`${RUTA}/${ajeno}`, ctx.sessions.companyAdmin.token)).status, 404);
      assert.equal((await query('SELECT id FROM company_documents WHERE id = ?', [ajeno])).length, 1);
    });

    it('el company_id del cuerpo no cambia el tenant', async () => {
      const res = await subir(ctx.sessions.companyAdmin.token, {
        type: 'RUC',
        extra: { company_id: String(ctx.fixtures.companyB) },
      });

      assert.equal(res.status, 201);
      assert.equal(Number(res.body.data.company_id), ctx.fixtures.companyA);
      assert.equal((await query('SELECT id FROM company_documents WHERE company_id = ?', [ctx.fixtures.companyB])).length, 0);
    });

    it('el company_id de la query no amplía el alcance', async () => {
      await documentoDeB();
      const res = await get(`${RUTA}?company_id=${ctx.fixtures.companyB}`, ctx.sessions.companyAdmin.token);
      assert.deepEqual(res.body.data, []);
    });

    it('el ADMIN sí consulta los documentos de una empresa concreta', async () => {
      await documentoDeB();
      const res = await get(`${RUTA}?company_id=${ctx.fixtures.companyB}`, ctx.sessions.admin.token);

      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 1);
    });

    it('la respuesta no filtra documentos de otra empresa', async () => {
      await execute(
        "INSERT INTO company_documents (company_id, type, file_url, notes) VALUES (?, 'OTHER', 'documents/999/secreto.pdf', 'SECRETO DE B')",
        [ctx.fixtures.companyB],
      );
      const res = await get(RUTA, ctx.sessions.companyAdmin.token);
      assert.doesNotMatch(JSON.stringify(res.body), /SECRETO DE B/);
    });
  });

  describe('Permisos por rol', () => {
    it('un CUSTOMER no accede a los documentos', async () => {
      const doc = await documentoDeA();

      assert.equal((await get(RUTA, ctx.sessions.customer.token)).status, 403, 'no pertenece a ninguna empresa');
      assert.equal((await get(`${RUTA}/${doc.id}`, ctx.sessions.customer.token)).status, 403);
      assert.equal((await subir(ctx.sessions.customer.token, { type: 'RUC' })).status, 403);
      assert.equal((await del(`${RUTA}/${doc.id}`, ctx.sessions.customer.token)).status, 403);
    });

    it('un OPERATOR consulta pero no sube ni elimina', async () => {
      const doc = await documentoDeA();

      assert.equal((await get(RUTA, ctx.sessions.operator.token)).status, 200);
      assert.equal((await get(`${RUTA}/${doc.id}`, ctx.sessions.operator.token)).status, 200);
      assert.equal((await subir(ctx.sessions.operator.token, { type: 'LICENSE' })).status, 403, 'no tiene companies.update');
      assert.equal((await del(`${RUTA}/${doc.id}`, ctx.sessions.operator.token)).status, 403);
    });

    it('la bandeja de pendientes es solo del ADMIN', async () => {
      await documentoDeA();

      const admin = await get(`${RUTA}/pending-review`, ctx.sessions.admin.token);
      assert.equal(admin.status, 200);
      assert.equal(admin.body.data.length, 1);

      assert.equal((await get(`${RUTA}/pending-review`, ctx.sessions.companyAdmin.token)).status, 403, 'nadie revisa lo suyo');
      assert.equal((await get(`${RUTA}/pending-review`, ctx.sessions.operator.token)).status, 403);
    });

    it('sin token no se accede', async () => {
      assert.equal((await get(RUTA)).status, 401);
      assert.equal((await subir(undefined, { type: 'RUC' })).status, 401);
      assert.equal((await del(`${RUTA}/1`)).status, 401);
      assert.equal((await put(`${RUTA}/1/review`, { status: 'VERIFIED' })).status, 401);
    });
  });

  describe('Seguridad de los archivos', () => {
    it('rechaza un formato no admitido', async () => {
      for (const [filename, mime] of [['virus.exe', 'application/octet-stream'], ['macro.docx', 'application/msword'], ['script.svg', 'image/svg+xml']]) {
        const res = await subir(ctx.sessions.companyAdmin.token, { type: 'OTHER', filename, mime, content: PDF });
        assert.equal(res.status, 400, `${filename} -> ${res.status}`);
      }
      assert.equal((await query('SELECT id FROM company_documents')).length, 0);
    });

    it('rechaza la doble extensión', async () => {
      const res = await subir(ctx.sessions.companyAdmin.token, {
        type: 'OTHER', filename: 'documento.pdf.exe', mime: 'application/pdf', content: PDF,
      });
      assert.equal(res.status, 400, 'se lee la última extensión, no la primera');
    });

    it('rechaza un MIME que no coincide con la extensión', async () => {
      const res = await subir(ctx.sessions.companyAdmin.token, {
        type: 'OTHER', filename: 'documento.pdf', mime: 'image/png', content: PDF,
      });
      assert.equal(res.status, 400);
    });

    it('rechaza un archivo cuyo contenido no corresponde a su extensión', async () => {
      const res = await subir(ctx.sessions.companyAdmin.token, {
        type: 'OTHER', filename: 'falso.pdf', mime: 'application/pdf', content: Buffer.from('MZ\x90\x00 ejecutable disfrazado'),
      });
      assert.equal(res.status, 400, 'los bytes mágicos no mienten');
    });

    it('rechaza un archivo vacío', async () => {
      const res = await subir(ctx.sessions.companyAdmin.token, { type: 'OTHER', content: Buffer.alloc(0) });
      assert.equal(res.status, 400);
    });

    it('rechaza un archivo demasiado grande', async () => {
      const grande = Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46]), Buffer.alloc(6 * 1024 * 1024, 0x20)]);
      const res = await subir(ctx.sessions.companyAdmin.token, { type: 'OTHER', content: grande });
      assert.equal(res.status, 400);
      assert.equal((await query('SELECT id FROM company_documents')).length, 0);
    });

    it('neutraliza un nombre con path traversal', async () => {
      const res = await subir(ctx.sessions.companyAdmin.token, {
        type: 'OTHER', filename: '../../../../etc/passwd.pdf', mime: 'application/pdf', content: PDF,
      });

      assert.equal(res.status, 201, 'se acepta el archivo, pero no su nombre');
      const fila = await queryOne<{ file_url: string }>('SELECT file_url FROM company_documents WHERE id = ?', [res.body.data.id]);
      assert.doesNotMatch(fila!.file_url, /\.\./, 'la ruta no contiene saltos');
      assert.doesNotMatch(fila!.file_url, /passwd/, 'el nombre del usuario no se usa');
      assert.match(fila!.file_url, /^documents\/\d+\/[0-9a-f]{32}\.pdf$/);
    });

    it('un nombre con caracteres de control tampoco llega al disco', async () => {
      const res = await subir(ctx.sessions.companyAdmin.token, {
        type: 'OTHER', filename: 'a";rm -rf /;#.pdf', mime: 'application/pdf', content: PDF,
      });
      assert.equal(res.status, 201);
      const fila = await queryOne<{ file_url: string }>('SELECT file_url FROM company_documents WHERE id = ?', [res.body.data.id]);
      assert.match(fila!.file_url, /^documents\/\d+\/[0-9a-f]{32}\.pdf$/);
    });

    it('el archivo se guarda sin permisos de ejecución', async () => {
      const doc = await documentoDeA();
      const fila = await queryOne<{ file_url: string }>('SELECT file_url FROM company_documents WHERE id = ?', [doc.id]);
      const stats = fs.statSync(path.resolve(process.cwd(), env.storage.dir, fila!.file_url));
      assert.equal(stats.mode & 0o111, 0, 'ningún bit de ejecución');
    });

    it('la subida exige un archivo', async () => {
      const form = new FormData();
      form.append('type', 'RUC');
      const res = await fetch(`${testBaseUrl()}${RUTA}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.sessions.companyAdmin.token}` },
        body: form,
      });
      assert.equal(res.status, 400);
    });
  });

  describe('Validaciones y seguridad general', () => {
    it('rechaza un tipo de documento inexistente', async () => {
      for (const type of ['DNI', '', 'ruc', 'CONTRATO']) {
        assert.equal((await subir(ctx.sessions.companyAdmin.token, { type })).status, 422, `type="${type}"`);
      }
    });

    it('ignora los campos que no son escribibles (mass assignment)', async () => {
      const res = await subir(ctx.sessions.companyAdmin.token, {
        type: 'RUC',
        extra: {
          id: '9999',
          status: 'VERIFIED',
          reviewed_by: String(ctx.sessions.admin.user.id),
          reviewed_at: '2020-01-01 00:00:00',
          file_url: 'documents/999/inyectado.pdf',
          created_at: '2000-01-01 00:00:00',
        },
      });

      assert.equal(res.status, 201);
      assert.notEqual(Number(res.body.data.id), 9999);
      assert.equal(res.body.data.status, 'PENDING', 'una empresa no puede verificarse a sí misma');
      assert.equal(res.body.data.reviewed_by, null);
      assert.doesNotMatch(String(res.body.data.file_url ?? ''), /inyectado/, 'la ruta la decide el servidor');
      assert.ok(!String(res.body.data.created_at).startsWith('2000'));
    });

    it('un id inexistente o no numérico devuelve 404', async () => {
      assert.equal((await get(`${RUTA}/999999`, ctx.sessions.companyAdmin.token)).status, 404);
      assert.equal((await get(`${RUTA}/abc`, ctx.sessions.companyAdmin.token)).status, 404);
      assert.equal((await del(`${RUTA}/999999`, ctx.sessions.companyAdmin.token)).status, 404);
      assert.equal((await put(`${RUTA}/999999/review`, { status: 'VERIFIED' }, ctx.sessions.admin.token)).status, 404);
    });

    it('resiste inyección SQL en las notas y en el id', async () => {
      const res = await subir(ctx.sessions.companyAdmin.token, {
        type: 'OTHER', notes: "x'; DROP TABLE company_documents; --",
      });
      assert.equal(res.status, 201);
      assert.ok(Array.isArray(await query('SELECT id FROM company_documents')), 'la tabla sigue existiendo');

      assert.equal((await get(`${RUTA}/1 OR 1=1`, ctx.sessions.companyAdmin.token)).status, 404);
    });

    it('la respuesta no expone rutas del servidor ni la referencia interna del archivo', async () => {
      const doc = await documentoDeA();
      const detalle = (await get(`${RUTA}/${doc.id}`, ctx.sessions.companyAdmin.token)).body.data;
      const cuerpo = JSON.stringify(detalle);

      assert.equal(detalle.file_url, undefined, 'la ruta del almacén no se publica');
      assert.equal(detalle.has_file, true, 'en su lugar se indica que hay archivo');
      assert.doesNotMatch(cuerpo, /documents\//, 'ni siquiera la referencia relativa');
      assert.doesNotMatch(cuerpo, /[A-Z]:\\|\/home\/|\/var\//, 'nada de rutas del sistema');
      assert.doesNotMatch(cuerpo, /password|\$2[aby]\$/i);

      const listado = JSON.stringify((await get(RUTA, ctx.sessions.companyAdmin.token)).body);
      assert.doesNotMatch(listado, /documents\//, 'el listado tampoco la expone');
    });

    it('la clave foránea impide un documento sin empresa', async () => {
      await assert.rejects(
        () => execute("INSERT INTO company_documents (company_id, type, file_url) VALUES (999999, 'RUC', 'x.pdf')"),
        /foreign key|FOREIGN KEY|ER_NO_REFERENCED_ROW/i,
      );
    });

    it('al borrar la empresa se borran sus documentos en cascada', async () => {
      const empresa = await execute(
        "INSERT INTO companies (name, legal_name, tax_id, email, status) VALUES ('Temporal', 'Temporal SAC', '20555555555', 'tmp@test.pe', 'ACTIVE')",
      );
      await execute("INSERT INTO company_documents (company_id, type, file_url) VALUES (?, 'RUC', 'documents/x/y.pdf')", [empresa.insertId]);

      await execute('DELETE FROM companies WHERE id = ?', [empresa.insertId]);
      assert.equal((await query('SELECT id FROM company_documents WHERE company_id = ?', [empresa.insertId])).length, 0);
    });
  });

  describe('Auditoría', () => {
    it('registra la subida sin volcar la ruta del archivo', async () => {
      const doc = await documentoDeA();

      const entrada = await queryOne<{ action: string; description: string; new_values: string | null; user_id: number }>(
        "SELECT action, description, new_values, user_id FROM audit_logs WHERE entity_type = 'company_documents' ORDER BY id DESC LIMIT 1",
      );
      assert.ok(entrada);
      assert.equal(entrada!.action, 'CREATE');
      assert.equal(Number(entrada!.user_id), ctx.sessions.companyAdmin.user.id);
      assert.match(entrada!.description, /Ficha RUC/);
      assert.doesNotMatch(String(entrada!.new_values ?? ''), /documents\//, 'no se guarda la referencia interna');
      assert.ok(doc.id);
    });

    it('registra el reemplazo, el borrado, la verificación y el rechazo', async () => {
      const doc = await documentoDeA('RUC');
      await subir(ctx.sessions.companyAdmin.token, { type: 'RUC' });
      await put(`${RUTA}/${doc.id}/review`, { status: 'REJECTED', notes: 'Ilegible' }, ctx.sessions.admin.token);
      await put(`${RUTA}/${doc.id}/review`, { status: 'VERIFIED' }, ctx.sessions.admin.token);

      const otro = await documentoDeA('LICENSE');
      await del(`${RUTA}/${otro.id}`, ctx.sessions.companyAdmin.token);

      const acciones = await query<{ action: string }>(
        "SELECT action FROM audit_logs WHERE entity_type = 'company_documents' ORDER BY id ASC",
      );
      assert.deepEqual(acciones.map((a) => a.action), ['CREATE', 'UPDATE', 'REJECT', 'APPROVE', 'CREATE', 'DELETE']);
    });
  });

  describe('Flujo completo de verificación', () => {
    it('sube → PENDING → ADMIN rechaza → la empresa ve el motivo → corrige → PENDING', async () => {
      // 1. La empresa sube su ficha RUC.
      const subida = await subir(ctx.sessions.companyAdmin.token, { type: 'RUC' });
      assert.equal(subida.status, 201);
      assert.equal(subida.body.data.status, 'PENDING');

      // 2. El ADMIN la ve en la empresa correspondiente.
      const vistaAdmin = await get(`${RUTA}?company_id=${ctx.fixtures.companyA}`, ctx.sessions.admin.token);
      assert.equal(vistaAdmin.body.data.length, 1);

      // 3. La rechaza con motivo.
      const rechazo = await put(
        `${RUTA}/${subida.body.data.id}/review`,
        { status: 'REJECTED', notes: 'El documento está vencido' },
        ctx.sessions.admin.token,
      );
      assert.equal(rechazo.status, 200);

      // 4. La empresa ve el motivo y su línea de tiempo bloqueada.
      const vistaEmpresa = await get(`${RUTA}/${subida.body.data.id}`, ctx.sessions.companyAdmin.token);
      assert.equal(vistaEmpresa.body.data.status, 'REJECTED');
      assert.equal(vistaEmpresa.body.data.notes, 'El documento está vencido');
      assert.equal(Number(vistaEmpresa.body.data.reviewed_by), ctx.sessions.admin.user.id);

      const timeline = await get(`${RUTA}/verification-status`, ctx.sessions.companyAdmin.token);
      assert.equal(timeline.body.data.stages[1].status, 'BLOCKED');

      // 5. Sube una versión corregida: vuelve a PENDING.
      const corregido = await subir(ctx.sessions.companyAdmin.token, { type: 'RUC', filename: 'ruc-corregido.pdf' });
      assert.equal(corregido.status, 200);
      assert.equal(corregido.body.data.status, 'PENDING');
      assert.equal(corregido.body.data.notes, null, 'el motivo anterior se limpia');

      // 6. El ADMIN la verifica y la línea de tiempo avanza.
      await put(`${RUTA}/${corregido.body.data.id}/review`, { status: 'VERIFIED' }, ctx.sessions.admin.token);
      const final = await get(`${RUTA}/verification-status`, ctx.sessions.companyAdmin.token);
      assert.equal(final.body.data.stages[1].status, 'DONE');
      // La empresa de las fixtures ya estaba aprobada, así que la línea de tiempo queda completa.
      assert.equal(final.body.data.stages[2].status, 'DONE');
      assert.equal((await query('SELECT id FROM company_documents')).length, 1, 'siempre fue el mismo documento');
    });
  });
});
