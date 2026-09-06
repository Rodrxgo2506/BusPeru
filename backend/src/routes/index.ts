import { Router } from 'express';
import { apiKeyRouter } from './apikey.routes';
import { auditRouter } from './audit.routes';
import bankAccountRoutes from './bank-account.routes';
import companyDocumentRoutes from './company-document.routes';
import driverRoutes from './driver.routes';
import authRoutes from './auth.routes';
import oauthRoutes from './oauth.routes';
import { companyIntegrationRouter, platformIntegrationRouter } from './company-integration.routes';
import bookingRoutes from './booking.routes';
import dashboardRoutes from './dashboard.routes';
import { settlementRouter, transactionRouter } from './finance.routes';
import notificationRoutes from './notification.routes';
import { paymentRouter, refundRouter } from './payment.routes';
import publicRoutes from './public.routes';
import reportRoutes from './report.routes';
import { resourceRouters } from './resources';
import reviewRoutes from './review.routes';
import { permissionRouter, roleRouter } from './role.routes';
import supportRoutes from './support.routes';
import tripRoutes from './trip.routes';
import userRoutes from './user.routes';

const router = Router();

router.use('/auth/oauth', oauthRoutes);
router.use('/auth', authRoutes);
router.use('/company/bank-accounts', bankAccountRoutes);
router.use('/company/documents', companyDocumentRoutes);
router.use('/company/drivers', driverRoutes);
router.use('/company/integrations', companyIntegrationRouter);
router.use('/admin/integrations', platformIntegrationRouter);
router.use('/public', publicRoutes);
router.use('/users', userRoutes);
router.use('/roles', roleRouter);
router.use('/permissions', permissionRouter);
router.use('/trips', tripRoutes);
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

for (const { path, router: resourceRouter } of resourceRouters) {
  router.use(path, resourceRouter);
}

export default router;
