import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { get, post, put } from './helpers/api';
import { execute, query, queryOne } from '../config/database';
import { at, freeSeats } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * BP-24 · validación de `assigned_to` en soporte.
 *
 * El campo se escribía tal cual llegaba —`optionalId`, un entero positivo y nada más—, y
 * eso no era solo un dato sin comprobar: `visibilityScope` incluye `st.assigned_to = ?`, de
 * modo que **asignar concede lectura**. La empresa A asignaba su ticket al administrador de
 * la empresa B y este pasaba a ver el nombre de la empresa A, el correo del pasajero y su
 * `booking_code`.
 *
 * La regla no es nueva: no existe ningún permiso `support.*` en el esquema, así que soporte
 * se rige por identidad. Solo puede ser responsable de un ticket quien ya podría verlo.
 */
describe('BP-24 · asignación de tickets de soporte', () => {
  let ctx: SuiteContext;
  const MENSAJE = 'El usuario indicado no puede atender este ticket';

  before(async () => {
    ctx = await prepareSuite();
  });
  after(teardownSuite);

  beforeEach(async () => {
    await execute('DELETE FROM support_messages');
    await execute('DELETE FROM support_tickets');
    // Cada caso abre su ticket sobre una reserva nueva; sin esto el bus se queda sin
    // asientos libres a mitad del archivo.
    await execute('DELETE FROM booking_seats');
    await execute('DELETE FROM financial_transactions');
    await execute('DELETE FROM payments');
    await execute('DELETE FROM bookings');
    await execute('UPDATE trips SET available_seats = (SELECT capacity FROM buses WHERE id = trips.bus_id)');
    await execute("UPDATE users SET status = 'ACTIVE'");
  });

  /* ------------------------------------------------------------------ utilidades */

  /** Ticket de la empresa A: lo abre el cliente sobre una reserva de un viaje de A. */
  async function ticketDeEmpresaA(): Promise<number> {
    const reserva = await post(
      '/bookings',
      {
        trip_id: ctx.fixtures.tripA,
        seat_ids: [at(await freeSeats(ctx.fixtures.tripA), 0).id],
        passenger_email: 'cliente@test.pe',
      },
      ctx.sessions.customer.token,
    );
    assert.equal(reserva.status, 201);

    const ticket = await post(
      '/support/tickets',
      { booking_id: reserva.body.data.id, subject: 'Consulta sobre mi viaje', message: 'Hola' },
      ctx.sessions.customer.token,
    );
    assert.equal(ticket.status, 201, JSON.stringify(ticket.body));
    assert.equal(Number(ticket.body.data.company_id), ctx.fixtures.companyA);
    return ticket.body.data.id as number;
  }

  /** Ticket sin reserva de un cliente sin empresa: queda sin `company_id`. */
  async function ticketDePlataforma(): Promise<number> {
    const ticket = await post(
      '/support/tickets',
      { subject: 'No puedo entrar a mi cuenta', message: 'Ayuda' },
      ctx.sessions.customer.token,
    );
    assert.equal(ticket.status, 201, JSON.stringify(ticket.body));
    assert.equal(ticket.body.data.company_id, null, 'el escenario exige un ticket sin empresa');
    return ticket.body.data.id as number;
  }

  const asignar = (ticketId: number, assignedTo: unknown, token: string, extra: Record<string, unknown> = {}) =>
    put(`/support/tickets/${ticketId}`, { assigned_to: assignedTo, ...extra }, token);

  const asignado = async (ticketId: number) =>
    (await queryOne<{ assigned_to: number | null }>('SELECT assigned_to FROM support_tickets WHERE id = ?', [ticketId]))
      ?.assigned_to ?? null;

  /* ══════════════════════════════ asignaciones válidas ═══════════════════════ */

  describe('Quién sí puede hacerse cargo', () => {
    it('1 · un OPERATOR de la misma empresa es un responsable válido', async () => {
      const ticket = await ticketDeEmpresaA();

      const res = await asignar(ticket, ctx.fixtures.users.operator, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(Number(await asignado(ticket)), ctx.fixtures.users.operator);
    });

    it('2 · un COMPANY_ADMIN puede asignárselo a sí mismo', async () => {
      const ticket = await ticketDeEmpresaA();

      const res = await asignar(ticket, ctx.fixtures.users.companyAdmin, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 200);
      assert.equal(Number(await asignado(ticket)), ctx.fixtures.users.companyAdmin);
    });

    it('3 · escalar al ADMIN de plataforma sigue siendo legítimo', async () => {
      const ticket = await ticketDeEmpresaA();

      // El ADMIN ve todos los tickets: asignárselo no le concede nada que no tuviera.
      const res = await asignar(ticket, ctx.fixtures.users.admin, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 200);
      assert.equal(Number(await asignado(ticket)), ctx.fixtures.users.admin);
    });

    it('4 · el ADMIN puede asignar dentro de la empresa dueña del ticket', async () => {
      const ticket = await ticketDeEmpresaA();

      const res = await asignar(ticket, ctx.fixtures.users.operator, ctx.sessions.admin.token);

      assert.equal(res.status, 200);
      assert.equal(Number(await asignado(ticket)), ctx.fixtures.users.operator);
    });

    it('5 · `assigned_to: null` devuelve el ticket a la bandeja común', async () => {
      const ticket = await ticketDeEmpresaA();
      await asignar(ticket, ctx.fixtures.users.operator, ctx.sessions.companyAdmin.token);

      const res = await asignar(ticket, null, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 200, 'desasignar es una operación válida y no cambia de semántica');
      assert.equal(await asignado(ticket), null);
    });

    it('6 · cambiar solo el estado sigue funcionando, sin tocar la asignación', async () => {
      const ticket = await ticketDeEmpresaA();
      await asignar(ticket, ctx.fixtures.users.operator, ctx.sessions.companyAdmin.token);

      const res = await put(`/support/tickets/${ticket}`, { status: 'IN_PROGRESS' }, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 200);
      assert.equal(Number(await asignado(ticket)), ctx.fixtures.users.operator, 'el responsable no se pierde');
    });
  });

  /* ══════════════════════════════ asignaciones rechazadas ═══════════════════ */

  describe('Quién no puede hacerse cargo', () => {
    it('7 · un usuario que no existe se rechaza', async () => {
      const ticket = await ticketDeEmpresaA();

      const res = await asignar(ticket, 999999, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 400);
      assert.equal(res.body.message, MENSAJE);
      assert.equal(await asignado(ticket), null);
    });

    it('8 · un usuario de OTRA empresa se rechaza', async () => {
      const ticket = await ticketDeEmpresaA();

      const res = await asignar(ticket, ctx.fixtures.users.companyAdminB, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 400);
      assert.equal(await asignado(ticket), null, 'asignar no puede ser una puerta trasera entre empresas');
    });

    it('9 · un CUSTOMER se rechaza: abre tickets, no los atiende', async () => {
      const ticket = await ticketDeEmpresaA();

      const res = await asignar(ticket, ctx.fixtures.users.customer, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 400);
      assert.equal(await asignado(ticket), null);
    });

    it('10 · una cuenta que no está activa se rechaza', async () => {
      const ticket = await ticketDeEmpresaA();
      await execute("UPDATE users SET status = 'INACTIVE' WHERE id = ?", [ctx.fixtures.users.operator]);

      const res = await asignar(ticket, ctx.fixtures.users.operator, ctx.sessions.companyAdmin.token);

      assert.equal(res.status, 400, 'quien no puede iniciar sesión tampoco puede ser responsable');
      assert.equal(await asignado(ticket), null);
    });

    it('11 · el ADMIN tampoco puede cruzar empresas al asignar', async () => {
      const ticket = await ticketDeEmpresaA();

      // El ADMIN puede tocar cualquier ticket, pero el responsable sigue teniendo que
      // pertenecer a la empresa del ticket. La regla es del recurso, no de quien la ejecuta.
      const res = await asignar(ticket, ctx.fixtures.users.companyAdminB, ctx.sessions.admin.token);

      assert.equal(res.status, 400);
      assert.equal(await asignado(ticket), null);
    });

    it('12 · un rechazo no modifica nada más del ticket', async () => {
      const ticket = await ticketDeEmpresaA();

      const res = await asignar(ticket, ctx.fixtures.users.companyAdminB, ctx.sessions.companyAdmin.token, {
        status: 'CLOSED',
        priority: 'URGENT',
      });

      assert.equal(res.status, 400);
      const fila = await queryOne<{ status: string; priority: string; assigned_to: number | null }>(
        'SELECT status, priority, assigned_to FROM support_tickets WHERE id = ?',
        [ticket],
      );
      assert.equal(fila?.status, 'OPEN', 'la validación corre antes de tocar la fila');
      assert.equal(fila?.priority, 'MEDIUM');
      assert.equal(fila?.assigned_to, null);
    });
  });

  /* ══════════════════════════════ tickets sin empresa ═══════════════════════ */

  describe('Ticket de plataforma, sin empresa', () => {
    it('13 · solo el ADMIN puede quedar como responsable', async () => {
      const ticket = await ticketDePlataforma();

      const res = await asignar(ticket, ctx.fixtures.users.admin, ctx.sessions.admin.token);

      assert.equal(res.status, 200);
      assert.equal(Number(await asignado(ticket)), ctx.fixtures.users.admin);
    });

    it('14 · un rol de empresa se rechaza: no hay empresa a la que pertenecer', async () => {
      const ticket = await ticketDePlataforma();

      const res = await asignar(ticket, ctx.fixtures.users.companyAdmin, ctx.sessions.admin.token);

      assert.equal(res.status, 400);
      assert.equal(await asignado(ticket), null);
    });
  });

  /* ══════════════════════════════ aislamiento y fugas ═══════════════════════ */

  describe('Aislamiento entre empresas', () => {
    it('15 · el ticket de una empresa no es modificable por otra', async () => {
      const ticket = await ticketDeEmpresaA();

      const res = await asignar(ticket, ctx.fixtures.users.companyAdminB, ctx.sessions.companyAdminB.token);

      assert.equal(res.status, 404, 'un recurso ajeno responde 404, no 403');
      assert.equal(res.body.message, 'Ticket no encontrado');
    });

    it('16 · la empresa B no llega a ver el ticket de A por la vía de la asignación', async () => {
      const ticket = await ticketDeEmpresaA();
      await asignar(ticket, ctx.fixtures.users.companyAdminB, ctx.sessions.companyAdmin.token);

      const lista = await get('/support/tickets', ctx.sessions.companyAdminB.token);
      const detalle = await get(`/support/tickets/${ticket}`, ctx.sessions.companyAdminB.token);

      assert.deepEqual(lista.body.data, [], 'antes de BP-24 aquí aparecía el ticket de la empresa A');
      assert.equal(detalle.status, 404);
    });

    it('17 · el error no revela nada del usuario ni de la empresa ajena', async () => {
      const ticket = await ticketDeEmpresaA();

      const res = await asignar(ticket, ctx.fixtures.users.companyAdminB, ctx.sessions.companyAdmin.token);

      const texto = JSON.stringify(res.body);
      assert.ok(!texto.includes('empresa-b@test.pe'), 'sin correo ajeno');
      assert.ok(!texto.includes('Beto'), 'sin nombre ajeno');
      assert.ok(!texto.includes('Empresa B'), 'sin empresa ajena');
      assert.ok(!texto.includes('COMPANY_ADMIN'), 'sin el rol del usuario ajeno');
    });

    it('18 · el mensaje es idéntico exista o no el usuario: no se puede enumerar', async () => {
      const ticket = await ticketDeEmpresaA();

      const inexistente = await asignar(ticket, 999999, ctx.sessions.companyAdmin.token);
      const ajeno = await asignar(ticket, ctx.fixtures.users.companyAdminB, ctx.sessions.companyAdmin.token);
      const cliente = await asignar(ticket, ctx.fixtures.users.customer, ctx.sessions.companyAdmin.token);

      assert.equal(inexistente.status, ajeno.status);
      assert.equal(ajeno.status, cliente.status);
      assert.equal(inexistente.body.message, ajeno.body.message);
      assert.equal(ajeno.body.message, cliente.body.message);
    });
  });

  /* ══════════════════════════════ el cuerpo no manda ════════════════════════ */

  describe('La empresa del ticket sale del recurso, no del cuerpo', () => {
    it('19 · enviar `company_id` de otra empresa no habilita la asignación', async () => {
      const ticket = await ticketDeEmpresaA();

      const res = await asignar(ticket, ctx.fixtures.users.companyAdminB, ctx.sessions.companyAdmin.token, {
        company_id: ctx.fixtures.companyB,
      });

      assert.equal(res.status, 400);
      const fila = await queryOne<{ company_id: number }>('SELECT company_id FROM support_tickets WHERE id = ?', [ticket]);
      assert.equal(Number(fila?.company_id), ctx.fixtures.companyA, 'la empresa del ticket no se toca desde el cuerpo');
    });

    it('20 · `company_id` en el cuerpo tampoco cambia la empresa en una asignación válida', async () => {
      const ticket = await ticketDeEmpresaA();

      const res = await asignar(ticket, ctx.fixtures.users.operator, ctx.sessions.companyAdmin.token, {
        company_id: ctx.fixtures.companyB,
      });

      assert.equal(res.status, 200);
      const fila = await queryOne<{ company_id: number }>('SELECT company_id FROM support_tickets WHERE id = ?', [ticket]);
      assert.equal(Number(fila?.company_id), ctx.fixtures.companyA);
    });
  });

  /* ══════════════════════════════ actores y concurrencia ════════════════════ */

  describe('Quién puede ejecutar la asignación', () => {
    it('21 · un CUSTOMER no puede actualizar el ticket, ni el suyo', async () => {
      const ticket = await ticketDeEmpresaA();

      const res = await asignar(ticket, ctx.fixtures.users.operator, ctx.sessions.customer.token);

      assert.equal(res.status, 403, 'la regla existente no cambia');
      assert.equal(await asignado(ticket), null);
    });

    it('22 · dos asignaciones válidas simultáneas dejan el ticket en un estado coherente', async () => {
      const ticket = await ticketDeEmpresaA();

      // La semántica actual es «gana la última escritura»; BP-24 no la cambia. Lo que se
      // comprueba es que el resultado sea uno de los dos responsables válidos y no un
      // estado imposible.
      const [uno, dos] = await Promise.all([
        asignar(ticket, ctx.fixtures.users.operator, ctx.sessions.companyAdmin.token),
        asignar(ticket, ctx.fixtures.users.companyAdmin, ctx.sessions.admin.token),
      ]);

      assert.deepEqual([uno.status, dos.status], [200, 200]);
      const final = Number(await asignado(ticket));
      assert.ok(
        [ctx.fixtures.users.operator, ctx.fixtures.users.companyAdmin].includes(final),
        `responsable inesperado: ${final}`,
      );

      const filas = await query('SELECT id FROM support_tickets WHERE id = ?', [ticket]);
      assert.equal(filas.length, 1);
    });
  });
});
