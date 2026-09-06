import { Router, type Request } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { recordAudit } from '../services/audit.service';
import * as integrations from '../services/company-integration.service';
import { asyncHandler, sendSuccess } from '../utils/http';
import { saveIntegrationSchema } from '../validators/company-integration.validators';

/**
 * Integraciones por empresa (PENDIENTES.md §5, mockup 37).
 *
 * ALCANCE: solo configuración. Conectar guarda credenciales cifradas; **no** activa cobros,
 * webhooks ni ninguna llamada a un proveedor externo.
 *
 * Permisos reutilizados, ninguno nuevo:
 *   · Leer     → `companies.view`   (ADMIN, COMPANY_ADMIN, OPERATOR)
 *   · Escribir → `companies.update` (ADMIN, COMPANY_ADMIN)
 *   · Plataforma (`company_id = NULL`) → `companies.update` **y además rol ADMIN**
 *
 * El permiso no basta: el servicio exige pertenecer a una empresa, así que un CUSTOMER
 * —que también tiene `companies.view` para el listado público— queda fuera.
 *
 * Las rutas se direccionan por `:provider`, no por id numérico: es lo natural para un
 * catálogo fijo y elimina de raíz cualquier IDOR por identificador.
 */

/** Construye el router para un ámbito concreto: la empresa de la sesión, o la plataforma. */
function buildRouter(resolveScope: (req: Request) => integrations.Scope): Router {
  const router = Router();
  router.use(authenticate);

  router.get(
    '/',
    requirePermission('companies.view'),
    asyncHandler(async (req, res) => {
      sendSuccess(res, await integrations.list(resolveScope(req)));
    }),
  );

  router.get(
    '/:provider',
    requirePermission('companies.view'),
    asyncHandler(async (req, res) => {
      sendSuccess(res, await integrations.detail(resolveScope(req), String(req.params.provider)));
    }),
  );

  router.put(
    '/:provider',
    requirePermission('companies.update'),
    validate(saveIntegrationSchema),
    asyncHandler(async (req, res) => {
      const scope = resolveScope(req);
      const provider = String(req.params.provider);
      const { view, created } = await integrations.save(scope, provider, req.body.credentials);

      await recordAudit(req, {
        action: created ? 'CREATE' : 'UPDATE',
        entityType: 'company_integrations',
        description: `${created ? 'Configuró' : 'Actualizó'} la integración ${view.label} (${scopeLabel(scope)})`,
        // Se registran los NOMBRES de los campos tocados, jamás sus valores.
        newValues: { provider, status: view.status, configured_fields: view.configured_fields },
      });

      sendSuccess(res, view, created ? 201 : 200);
    }),
  );

  router.post(
    '/:provider/connect',
    requirePermission('companies.update'),
    asyncHandler(async (req, res) => {
      const scope = resolveScope(req);
      const view = await integrations.connect(scope, String(req.params.provider));

      await recordAudit(req, {
        action: 'CONNECT',
        entityType: 'company_integrations',
        description: `Conectó la integración ${view.label} (${scopeLabel(scope)})`,
        newValues: { provider: view.provider, status: view.status },
      });

      sendSuccess(res, view);
    }),
  );

  router.post(
    '/:provider/disconnect',
    requirePermission('companies.update'),
    asyncHandler(async (req, res) => {
      const scope = resolveScope(req);
      const view = await integrations.disconnect(scope, String(req.params.provider));

      await recordAudit(req, {
        action: 'DISCONNECT',
        entityType: 'company_integrations',
        description: `Desconectó la integración ${view.label} (${scopeLabel(scope)})`,
        newValues: { provider: view.provider, status: view.status },
      });

      sendSuccess(res, view);
    }),
  );

  router.delete(
    '/:provider',
    requirePermission('companies.update'),
    asyncHandler(async (req, res) => {
      const scope = resolveScope(req);
      const provider = String(req.params.provider);
      await integrations.remove(scope, provider);

      await recordAudit(req, {
        action: 'DELETE',
        entityType: 'company_integrations',
        description: `Eliminó la integración ${provider} (${scopeLabel(scope)})`,
      });

      sendSuccess(res, { provider });
    }),
  );

  return router;
}

function scopeLabel(scope: integrations.Scope): string {
  return scope.kind === 'PLATFORM' ? 'plataforma' : `empresa ${scope.companyId}`;
}

/** Integraciones de la empresa de la sesión. */
export const companyIntegrationRouter = buildRouter(integrations.resolveCompanyScope);

/** Integraciones de la plataforma (`company_id = NULL`). Solo ADMIN. */
export const platformIntegrationRouter = buildRouter(integrations.resolvePlatformScope);
