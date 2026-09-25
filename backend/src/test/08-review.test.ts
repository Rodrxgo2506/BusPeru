import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { del, get, post, put } from './helpers/api';
import { freeSeats, at } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

describe('Reseñas: moderación y aislamiento', () => {
  let ctx: SuiteContext;
  let reviewA: number;
  let reviewB: number;

  /** Reserva pagada del cliente sobre el viaje indicado. */
  async function reservaPagada(tripId: number) {
    const seats = await freeSeats(tripId);
    const reserva = await post('/bookings', {
      trip_id: tripId, seat_ids: [at(seats, 0).id], passenger_email: 'cliente@test.pe',
    }, ctx.sessions.customer.token);
    await post(`/bookings/${reserva.body.data.id}/pay`, { method: 'CASH' }, ctx.sessions.admin.token);
    return reserva.body.data;
  }

  before(async () => {
    ctx = await prepareSuite();

    const bookingA = await reservaPagada(ctx.fixtures.tripA);
    const creadaA = await post('/reviews', { booking_id: bookingA.id, rating: 5, title: 'Muy bien', comment: 'Viaje puntual' }, ctx.sessions.customer.token);
    reviewA = creadaA.body.data.id;

    const bookingB = await reservaPagada(ctx.fixtures.tripB);
    const creadaB = await post('/reviews', { booking_id: bookingB.id, rating: 2, title: 'Regular', comment: 'Reseña de la empresa B' }, ctx.sessions.customer.token);
    reviewB = creadaB.body.data.id;
  });
  after(teardownSuite);

  it('el servidor deriva la empresa y el viaje de la reserva', async () => {
    const review = await get(`/reviews/${reviewA}`, ctx.sessions.admin.token);
    assert.equal(review.body.data.company_id, ctx.fixtures.companyA);
    assert.equal(Number(review.body.data.trip_id), ctx.fixtures.tripA);
  });

  it('ignora el company_id y trip_id que envíe el cliente', async () => {
    const booking = await reservaPagada(ctx.fixtures.tripA);
    const res = await post('/reviews', {
      booking_id: booking.id,
      company_id: ctx.fixtures.companyB, // intento de atribuirla a otra empresa
      trip_id: 999999,
      rating: 1,
      title: 'Suplantación',
    }, ctx.sessions.customer.token);

    assert.equal(res.status, 201);
    assert.equal(res.body.data.company_id, ctx.fixtures.companyA, 'la empresa debe venir de la reserva');
    assert.equal(Number(res.body.data.trip_id), ctx.fixtures.tripA);
    await del(`/reviews/${res.body.data.id}`, ctx.sessions.admin.token);
  });

  it('nace en estado PENDING y no aparece en el sitio público', async () => {
    const review = await get(`/reviews/${reviewA}`, ctx.sessions.admin.token);
    assert.equal(review.body.data.status, 'PENDING');
    const publicas = await get('/public/reviews');
    assert.equal(publicas.body.data.some((r: { id: number }) => r.id === reviewA), false);
  });

  it('solo se puede reseñar una reserva propia y confirmada', async () => {
    const ajena = await post('/bookings', {
      trip_id: ctx.fixtures.tripA, seat_ids: [at(await freeSeats(ctx.fixtures.tripA), 0).id], passenger_email: 'admin@test.pe',
    }, ctx.sessions.admin.token);
    await post(`/bookings/${ajena.body.data.id}/pay`, { method: 'CASH' }, ctx.sessions.admin.token);

    const intento = await post('/reviews', { booking_id: ajena.body.data.id, rating: 1 }, ctx.sessions.customer.token);
    assert.equal(intento.status, 403);

    const pendiente = await post('/bookings', {
      trip_id: ctx.fixtures.tripA, seat_ids: [at(await freeSeats(ctx.fixtures.tripA), 0).id], passenger_email: 'cliente@test.pe',
    }, ctx.sessions.customer.token);
    const sinViajar = await post('/reviews', { booking_id: pendiente.body.data.id, rating: 5 }, ctx.sessions.customer.token);
    assert.equal(sinViajar.status, 400, 'una reserva PENDING no es reseñable');
  });

  it('no permite dos reseñas sobre la misma reserva', async () => {
    const booking = await reservaPagada(ctx.fixtures.tripA);
    assert.equal((await post('/reviews', { booking_id: booking.id, rating: 5 }, ctx.sessions.customer.token)).status, 201);
    assert.equal((await post('/reviews', { booking_id: booking.id, rating: 3 }, ctx.sessions.customer.token)).status, 409);
  });

  it('COMPANY_ADMIN modera y responde las reseñas de SU empresa', async () => {
    const token = ctx.sessions.companyAdmin.token;

    const publicar = await put(`/reviews/${reviewA}`, { status: 'PUBLISHED' }, token);
    assert.equal(publicar.status, 200);
    assert.equal(publicar.body.data.status, 'PUBLISHED');

    const publicas = await get('/public/reviews');
    assert.ok(publicas.body.data.some((r: { id: number }) => r.id === reviewA), 'publicada debe verse en el sitio público');

    const ocultar = await put(`/reviews/${reviewA}`, { status: 'HIDDEN' }, token);
    assert.equal(ocultar.body.data.status, 'HIDDEN');
    const trasOcultar = await get('/public/reviews');
    assert.equal(trasOcultar.body.data.some((r: { id: number }) => r.id === reviewA), false);
    await put(`/reviews/${reviewA}`, { status: 'PUBLISHED' }, token);

    const respuesta = await post(`/reviews/${reviewA}/responses`, { response: 'Gracias por viajar con nosotros' }, token);
    assert.equal(respuesta.status, 201);

    const detalle = await get(`/reviews/${reviewA}`, token);
    assert.equal(detalle.body.data.responses.length, 1);
  });

  it('COMPANY_ADMIN no accede ni modifica reseñas de otra empresa', async () => {
    const token = ctx.sessions.companyAdmin.token;

    assert.equal((await get(`/reviews/${reviewB}`, token)).status, 404);
    assert.equal((await put(`/reviews/${reviewB}`, { status: 'PUBLISHED' }, token)).status, 403);
    assert.equal((await post(`/reviews/${reviewB}/responses`, { response: 'intruso' }, token)).status, 403);
    assert.equal((await del(`/reviews/${reviewB}`, token)).status, 403);

    const intacta = await get(`/reviews/${reviewB}`, ctx.sessions.admin.token);
    assert.equal(intacta.body.data.status, 'PENDING');
    assert.equal(intacta.body.data.comment, 'Reseña de la empresa B');
    assert.equal(intacta.body.data.responses.length, 0);
  });

  it('el listado de la empresa solo contiene sus propias reseñas', async () => {
    const res = await get('/reviews?limit=100', ctx.sessions.companyAdmin.token);
    assert.ok(res.body.data.every((r: { company_id: number }) => r.company_id === ctx.fixtures.companyA));
    assert.equal(res.body.data.some((r: { id: number }) => r.id === reviewB), false);

    const forzado = await get(`/reviews?company_id=${ctx.fixtures.companyB}&limit=100`, ctx.sessions.companyAdmin.token);
    assert.deepEqual(forzado.body.data, []);
  });

  it('OPERATOR puede leer pero no moderar ni responder', async () => {
    const token = ctx.sessions.operator.token;
    assert.equal((await get('/reviews?limit=10', token)).status, 200);
    assert.equal((await put(`/reviews/${reviewA}`, { status: 'HIDDEN' }, token)).status, 403);
    assert.equal((await post(`/reviews/${reviewA}/responses`, { response: 'no' }, token)).status, 403);
  });

  it('el cliente edita su reseña pero no la de otros ni su moderación', async () => {
    const token = ctx.sessions.customer.token;

    const propia = await put(`/reviews/${reviewA}`, { comment: 'Comentario actualizado' }, token);
    assert.equal(propia.status, 200);
    assert.equal(propia.body.data.comment, 'Comentario actualizado');

    assert.equal((await put(`/reviews/${reviewA}`, { status: 'PUBLISHED' }, token)).status, 403, 'no puede moderar');

    // Reseña de otro usuario
    const ajena = await post('/bookings', {
      trip_id: ctx.fixtures.tripA, seat_ids: [at(await freeSeats(ctx.fixtures.tripA), 0).id], passenger_email: 'admin@test.pe',
    }, ctx.sessions.admin.token);
    await post(`/bookings/${ajena.body.data.id}/pay`, { method: 'CASH' }, ctx.sessions.admin.token);
    const deOtro = await post('/reviews', { booking_id: ajena.body.data.id, rating: 4, comment: 'del admin' }, ctx.sessions.admin.token);

    assert.equal((await put(`/reviews/${deOtro.body.data.id}`, { comment: 'secuestrada' }, token)).status, 403);
    const verificacion = await get(`/reviews/${deOtro.body.data.id}`, ctx.sessions.admin.token);
    assert.equal(verificacion.body.data.comment, 'del admin');
  });

  /**
   * BP-06 · regresión de la auditoría del 06/09/2026.
   *
   * Una empresa moderaba con las cuatro columnas abiertas, así que convertía una reseña de
   * 1 estrella en una de 5 firmada con el nombre del pasajero. Moderar es decidir si se
   * publica, no reescribir lo que dijo el cliente.
   */
  describe('BP-06 · la empresa modera, no reescribe', () => {
    let critica: number;

    before(async () => {
      const booking = await reservaPagada(ctx.fixtures.tripA);
      const creada = await post(
        '/reviews',
        { booking_id: booking.id, rating: 1, title: 'Pesimo', comment: 'Muy mal servicio' },
        ctx.sessions.customer.token,
      );
      critica = creada.body.data.id;
    });

    /** Estado real de la reseña, leído con una sesión que sí puede verla entera. */
    async function estadoReal() {
      return (await get(`/reviews/${critica}`, ctx.sessions.admin.token)).body.data;
    }

    it('un COMPANY_ADMIN no puede subir la calificación', async () => {
      const res = await put(`/reviews/${critica}`, { rating: 5 }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 403);
      assert.equal(Number((await estadoReal()).rating), 1);
    });

    it('ni cambiar el título', async () => {
      const res = await put(`/reviews/${critica}`, { title: 'Excelente' }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 403);
      assert.equal((await estadoReal()).title, 'Pesimo');
    });

    it('ni el comentario', async () => {
      const res = await put(`/reviews/${critica}`, { comment: 'Todo perfecto' }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 403);
      assert.equal((await estadoReal()).comment, 'Muy mal servicio');
    });

    it('el ataque completo de la auditoría queda rechazado sin escribir nada', async () => {
      const res = await put(
        `/reviews/${critica}`,
        { rating: 5, title: 'Excelente', comment: 'Todo perfecto', status: 'PUBLISHED' },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(res.status, 403);

      const actual = await estadoReal();
      assert.equal(Number(actual.rating), 1, 'la calificación es del pasajero');
      assert.equal(actual.title, 'Pesimo');
      assert.equal(actual.comment, 'Muy mal servicio');
      assert.notEqual(actual.status, 'PUBLISHED', 'el estado tampoco se escribe si la petición se rechaza');
    });

    it('pero sí puede moderar: cambiar solo el estado sigue funcionando', async () => {
      const res = await put(`/reviews/${critica}`, { status: 'PUBLISHED' }, ctx.sessions.companyAdmin.token);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'PUBLISHED');

      const actual = await estadoReal();
      assert.equal(Number(actual.rating), 1, 'moderar no toca el contenido');
      assert.equal(actual.title, 'Pesimo');
      assert.equal(actual.comment, 'Muy mal servicio');
    });

    it('reenviar el contenido sin cambiarlo no es reescribir y se admite', async () => {
      const res = await put(
        `/reviews/${critica}`,
        { rating: 1, title: 'Pesimo', comment: 'Muy mal servicio', status: 'HIDDEN' },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(res.status, 200, 'un formulario que devuelva la fila completa no debe romperse');
      assert.equal(res.body.data.status, 'HIDDEN');
    });

    it('la reseña pública sigue mostrando lo que escribió el pasajero', async () => {
      await put(`/reviews/${critica}`, { status: 'PUBLISHED' }, ctx.sessions.companyAdmin.token);

      const publicas = await get('/public/reviews');
      const publicada = (publicas.body.data as Array<Record<string, unknown>>).find((row) => Number(row.id) === critica);
      assert.ok(publicada, 'la reseña moderada debe aparecer en el listado público');
      assert.equal(Number(publicada!.rating), 1);
      assert.equal(publicada!.title, 'Pesimo');
      assert.equal(publicada!.comment, 'Muy mal servicio');
    });

    it('el autor conserva la edición de su propia reseña', async () => {
      const res = await put(
        `/reviews/${critica}`,
        { comment: 'Muy mal servicio, aunque el conductor fue amable' },
        ctx.sessions.customer.token,
      );
      assert.equal(res.status, 200);
      assert.equal((await estadoReal()).comment, 'Muy mal servicio, aunque el conductor fue amable');
    });

    it('un COMPANY_ADMIN de otra empresa no llega ni a moderarla', async () => {
      const res = await put(`/reviews/${critica}`, { status: 'REJECTED' }, ctx.sessions.companyAdminB.token);
      assert.equal(res.status, 403);
    });

    it('el ADMIN conserva su capacidad administrativa completa', async () => {
      const res = await put(
        `/reviews/${critica}`,
        { rating: 3, title: 'Corregida por soporte', status: 'HIDDEN' },
        ctx.sessions.admin.token,
      );
      assert.equal(res.status, 200);
      assert.equal(Number(res.body.data.rating), 3);
      assert.equal(res.body.data.title, 'Corregida por soporte');
    });
  });
});
