import { Router } from 'express';
import { apiKeyRouter } from './apikey.routes';
import { auditRouter } from './audit.routes';
import bankAccountRoutes from './bank-account.routes';
import companyDocumentRoutes from './company-document.routes';
import companyLogoRoutes from './company-logo.routes';
import driverRoutes from './driver.routes';
import authRoutes from './auth.routes';
import oauthRoutes from './oauth.routes';
import { companyIntegrationRouter, platformIntegrationRouter } from './company-integration.routes';
import { culqiConfigRouter, culqiWebhookRouter } from './culqi.routes';
import bookingRoutes from './booking.routes';
import dashboardRoutes from './dashboard.routes';
import {
  attractionExtrasRouter,
  brandingAdminRouter,
  destinationExtrasRouter,
  festivityExtrasRouter,
} from './destination-content.routes';
import { settlementRouter, transactionRouter } from './finance.routes';
import integrationRoutes from './integration.routes';
import notificationRoutes from './notification.routes';
import { paymentRouter, refundRouter } from './payment.routes';
import publicRoutes from './public.routes';
import reportRoutes from './report.routes';
import { resourceRouters } from './resources';
import reviewRoutes from './review.routes';
import { permissionRouter, roleRouter } from './role.routes';
import supportRoutes from './support.routes';
import tripRoutes from './trip.routes';
import {
  busLayoutsOfBusRouter,
  busLayoutsRouter,
  layoutDecksRouter,
  layoutElementsRouter,
  layoutSeatsRouter,
} from './bus-layout.routes';
import userRoutes from './user.routes';

const router = Router();

// El webhook va ANTES que cualquier otra ruta y no lleva `authenticate`: lo llama Culqi,
// que no tiene sesion de BusPeru. Su autenticidad se establece de otro modo (ver el archivo).
router.use('/culqi/webhook', culqiWebhookRouter);
router.use('/culqi', culqiConfigRouter);
router.use('/auth/oauth', oauthRoutes);
router.use('/auth', authRoutes);
router.use('/company/bank-accounts', bankAccountRoutes);
router.use('/company/documents', companyDocumentRoutes);
router.use('/company/logo', companyLogoRoutes);
router.use('/company/drivers', driverRoutes);
router.use('/company/integrations', companyIntegrationRouter);
router.use('/admin/integrations', platformIntegrationRouter);
// API de integracion para sistemas externos: se autentica con X-API-Key, no con JWT.
router.use('/integration/v1', integrationRoutes);
router.use('/public', publicRoutes);
router.use('/users', userRoutes);
router.use('/roles', roleRouter);
router.use('/permissions', permissionRouter);
router.use('/trips', tripRoutes);
// Versiones de distribución del bus. `/buses` va antes del CRUD genérico para que
// `/buses/:id/layouts` no lo capture la ruta de recurso `/buses/:id`; lo que no case con
// `/:id/layouts` sigue su camino hacia el recurso de siempre.
router.use('/buses', busLayoutsOfBusRouter);
router.use('/layouts', busLayoutsRouter);
router.use('/decks', layoutDecksRouter);
router.use('/elements', layoutElementsRouter);
// `/layout-seats` y no `/seats`: el recurso genérico sigue sirviendo la lectura de
// asientos, y dos routers en la misma ruta dejarían el orden decidiendo quién atiende.
router.use('/layout-seats', layoutSeatsRouter);
router.use('/bookings', bookingRoutes);
router.use('/payments', paymentRouter);
router.use('/refunds', refundRouter);
router.use('/reviews', reviewRoutes);
router.use('/notifications', notificationRoutes);
router.use('/support', supportRoutes);
router.use('/financial-transactions', transactionRouter);
router.use('/settlements', settlementRouter);
router.use('/audit-logs', auditRouter);
router.use('/api-keys', apiKeyRouter);
router.use('/reports', reportRoutes);
router.use('/dashboard', dashboardRoutes);
// FASE 17 · imágenes, orden e identidad visual. Van antes del CRUD genérico de las mismas
// tablas: lo que no case aquí (`/:id/image`, `/reorder`) sigue hacia el recurso de siempre.
router.use('/destinations', destinationExtrasRouter);
router.use('/destination-attractions', attractionExtrasRouter);
router.use('/destination-festivities', festivityExtrasRouter);
router.use('/admin/branding', brandingAdminRouter);

for (const { path, router: resourceRouter } of resourceRouters) {
  router.use(path, resourceRouter);
}

export default router;
