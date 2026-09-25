-- ---------------------------------------------------------------------------
-- 019 · Cifrado de los datos bancarios de las empresas (F18-07)
--
-- `company_bank_accounts.account_number` e `interbank_code` se guardaban en claro. Esta
-- migración prepara el esquema para guardarlos cifrados con el MISMO mecanismo que ya usan
-- las credenciales de integraciones (AES-256-GCM, nonce aleatorio por escritura, sobre
-- versionado y rotación con INTEGRATIONS_ENCRYPTION_KEY_PREVIOUS; encryption.service.ts).
-- No se introduce ningún sistema criptográfico nuevo.
--
--   · `*_encrypted`  el sobre cifrado (JSON de texto). Lo escribe SOLO la aplicación: SQL no
--                    puede cifrar porque la clave no vive en la base de datos.
--   · `*_last4`      los 4 últimos caracteres, lo único que necesita el enmascarado. Así un
--                    OPERATOR ve «XXXX XXXX 1234» sin que el servidor descifre nada.
--   · `account_number` pasa a admitir NULL: la aplicación deja de escribir texto en claro.
--
-- NO SE BORRA NADA. Las columnas en claro siguen existiendo y sus valores se conservan hasta
-- que `npm run bank:encrypt -- --cifrar` los haya cifrado y verificado, y solo se vacían con
-- `--purgar-texto-plano`, que exige que cada fila descifre exactamente a su valor original.
-- Eliminar las columnas en claro será una migración posterior, cuando esto esté confirmado
-- en todos los entornos. Idempotente: puede ejecutarse varias veces.
--
-- Ejecutar (NUNCA sobre `busperu` sin haber probado antes en `busperu_test`):
--   mysql -u <usuario> -p <base> < database/migrations/019-bank-accounts-encryption.sql
-- ---------------------------------------------------------------------------

ALTER TABLE `company_bank_accounts`
  ADD COLUMN IF NOT EXISTS `account_number_encrypted` text DEFAULT NULL AFTER `account_number`,
  ADD COLUMN IF NOT EXISTS `account_number_last4` char(4) DEFAULT NULL AFTER `account_number_encrypted`,
  ADD COLUMN IF NOT EXISTS `interbank_code_encrypted` text DEFAULT NULL AFTER `interbank_code`,
  ADD COLUMN IF NOT EXISTS `interbank_code_last4` char(4) DEFAULT NULL AFTER `interbank_code_encrypted`;

-- Relajar NOT NULL no pierde datos: solo permite que las filas nuevas no lleven texto en claro.
ALTER TABLE `company_bank_accounts` MODIFY `account_number` varchar(50) DEFAULT NULL;

-- Comprobación (sin valores: solo cuántas filas quedan por cifrar)
SELECT COUNT(*) AS cuentas,
       SUM(account_number IS NOT NULL AND account_number_encrypted IS NULL) AS pendientes_de_cifrar,
       SUM(account_number IS NOT NULL AND account_number_encrypted IS NOT NULL) AS cifradas_con_texto_plano_aun
FROM company_bank_accounts;
