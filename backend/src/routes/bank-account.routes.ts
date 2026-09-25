import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { recordAudit } from '../services/audit.service';
import * as bankAccounts from '../services/bank-account.service';
import { maskAccountNumber, maskedOf } from '../services/bank-account.service';
import { asyncHandler, sendSuccess } from '../utils/http';
import { parseId } from '../utils/query';
import { createBankAccountSchema, updateBankAccountSchema } from '../validators/bank-account.validators';

/**
 * Datos bancarios de la empresa (mockup 36).
 *
 * Permisos: se reutilizan los que ya existen, sin crear ninguno nuevo.
 *   · Leer   → `companies.view`   (ADMIN, COMPANY_ADMIN, OPERATOR)
 *   · Escribir → `companies.update` (ADMIN, COMPANY_ADMIN). OPERATOR no la tiene.
 *
 * El permiso no basta: el servicio exige además pertenecer a una empresa, de modo que un
 * CUSTOMER —que también tiene `companies.view` para el listado público— queda fuera.
 *
 * La ruta no contiene SQL: delega en el servicio, que a su vez usa el repositorio.
 */
const router = Router();
router.use(authenticate);

/** La auditoría guarda quién, qué empresa y qué cuenta, nunca el número completo. */
function auditDetail(account: { bank_name?: string; account_number?: string | null }): string {
  const masked = maskAccountNumber(account.account_number ?? null) ?? 'sin número';
  return `${account.bank_name ?? 'banco'} · ${masked}`;
}

router.get(
  '/',
  requirePermission('companies.view'),
  asyncHandler(async (req, res) => {
    sendSuccess(res, await bankAccounts.list(req, req.query.company_id));
  }),
);

router.get(
  '/history',
  requirePermission('companies.view'),
  asyncHandler(async (req, res) => {
    sendSuccess(res, await bankAccounts.history(req, req.query.company_id));
  }),
);

router.post(
  '/',
  requirePermission('companies.update'),
  validate(createBankAccountSchema),
  asyncHandler(async (req, res) => {
    const { account, companyId } = await bankAccounts.create(req, req.body as Record<string, unknown>);

    await recordAudit(req, {
      action: 'CREATE',
      entityType: 'company_bank_accounts',
      entityId: account.id,
      description: `Registró una cuenta bancaria (empresa ${companyId}): ${auditDetail({ bank_name: account.bank_name, account_number: account.account_number_masked })}`,
    });

    sendSuccess(res, account, 201);
  }),
);

router.put(
  '/:id',
  requirePermission('companies.update'),
  validate(updateBankAccountSchema),
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const { account, previous, companyId } = await bankAccounts.update(req, id, req.body as Record<string, unknown>);

    await recordAudit(req, {
      action: 'UPDATE',
      entityType: 'company_bank_accounts',
      entityId: id,
      description: `Actualizó la cuenta bancaria (empresa ${companyId}): ${auditDetail({ bank_name: previous?.bank_name, account_number: previous ? maskedOf(previous, 'account_number') : null })}`,
      // `account_number` e `interbank_code` están en la lista de claves sensibles del
      // servicio de auditoría, así que no se guardan aunque se pasen aquí.
      oldValues: previous ? { bank_name: previous.bank_name, account_type: previous.account_type, currency: previous.currency, holder_name: previous.holder_name, is_primary: previous.is_primary } : null,
      newValues: { bank_name: account.bank_name, account_type: account.account_type, currency: account.currency, holder_name: account.holder_name, is_primary: account.is_primary },
    });

    sendSuccess(res, account);
  }),
);

router.delete(
  '/:id',
  requirePermission('companies.update'),
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const { previous, companyId } = await bankAccounts.remove(req, id);

    await recordAudit(req, {
      action: 'DELETE',
      entityType: 'company_bank_accounts',
      entityId: id,
      description: `Eliminó una cuenta bancaria (empresa ${companyId}): ${auditDetail({ bank_name: previous.bank_name, account_number: maskedOf(previous, 'account_number') })}`,
    });

    sendSuccess(res, { id });
  }),
);

export default router;
