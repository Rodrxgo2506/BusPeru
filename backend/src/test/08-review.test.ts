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
    await post(`/bookings/${reserva.body.data.id}/pay`, { method: 'CASH' }, ctx.sessions.customer.token);
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
});
