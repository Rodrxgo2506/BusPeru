// BusPerú · F18-08 · comprobación local (sin AWS) del modelo IAM/KMS/CloudTrail de producción.
//   node check-iam-prod.mjs      → código 1 si alguna regla se rompe
import { readFileSync, readdirSync } from 'node:fs';
import { politicasProd } from './build-iam-prod.mjs';

const problemas = [];
const fallo = (m) => problemas.push(m);
const lista = (v) => [].concat(v ?? []);
const acc = (d) => d.Statement.flatMap((s) => lista(s.Action).map((a) => ({ a, s })));
const allows = (d) => acc(d).filter((x) => x.s.Effect === 'Allow');
const denies = (d) => d.Statement.filter((s) => s.Effect === 'Deny');
const deniega = (d, accion) => denies(d).some((s) => lista(s.Action).some((a) => new RegExp(`^${a.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(accion)));
const permite = (d, re) => allows(d).some(({ a }) => re.test(a));
const P = politicasProd;

// 1 · tamaño, Sid, sin comodines peligrosos en Allow
for (const [n, d] of Object.entries(P)) {
  const c = JSON.stringify(d).length;
  if (!/trust|key-policy|bucket-policy/.test(n) && c > 6144) fallo(`${n}: ${c} caracteres (máximo 6144)`);
  for (const s of d.Statement) {
    if (!s.Sid) fallo(`${n}: declaración sin Sid`);
    if (s.Effect !== 'Allow') continue;
    for (const a of lista(s.Action)) {
      if (a === '*' || /^[a-z0-9-]+:\*$/.test(a)) fallo(`${n}/${s.Sid}: Allow comodín ${a}`);
      if (a === 'iam:PassRole' && (!s.Condition?.StringEquals?.['iam:PassedToService'] || lista(s.Resource).some((r) => /\*$/.test(r) && !/busperu-prod-DlmRole-\*$/.test(r)))) fallo(`${n}/${s.Sid}: PassRole sin acotar`);
    }
    if (s.NotAction) fallo(`${n}/${s.Sid}: Allow con NotAction`);
  }
}
// 2 · confianzas humanas con MFA; servicio con SourceAccount
for (const n of ['operator-trust', 'recovery-trust', 'breakglass-trust']) {
  const s = P[n].Statement[0];
  if (s.Condition?.Bool?.['aws:MultiFactorAuthPresent'] !== 'true' || !s.Condition?.NumericLessThan?.['aws:MultiFactorAuthAge'] || !/:user\//.test(s.Principal?.AWS)) fallo(`${n}: sin MFA o principal no es un usuario`);
}
if (P['exec-trust'].Statement[0].Principal?.Service !== 'cloudformation.amazonaws.com' || !P['exec-trust'].Statement[0].Condition?.StringEquals?.['aws:SourceAccount']) fallo('exec-trust: solo CloudFormation de esta cuenta');
if (P['app-trust'].Statement[0].Principal?.Service !== 'ec2.amazonaws.com') fallo('app-trust: solo EC2');

// 3 · barreras de C (ejecución y operador)
const REQUERIDAS = ['rds:DeleteDBInstance', 'rds:DeleteDBSnapshot', 'rds:ModifyDBSnapshotAttribute', 'rds:DeleteDBInstanceAutomatedBackup', 'iam:CreatePolicyVersion',
  'iam:SetDefaultPolicyVersion', 'iam:UpdateAssumeRolePolicy', 'iam:CreateUser', 'iam:CreateAccessKey', 'secretsmanager:DeleteSecret', 'ssm:DeleteParameter',
  'kms:ScheduleKeyDeletion', 'kms:DisableKey', 'kms:PutKeyPolicy', 'cloudtrail:DeleteTrail', 'cloudtrail:StopLogging', 'secretsmanager:GetSecretValue'];
for (const n of ['exec-barriers', 'operator-barriers']) for (const a of REQUERIDAS) if (!deniega(P[n], a)) fallo(`${n}: falta Deny ${a}`);
for (const n of ['exec-barriers', 'operator-barriers']) {
  const s = P[n].Statement.find((x) => x.Sid === 'IntocableLaIdentidadDeDespliegue');
  if (!s || !lista(s.Resource).some((r) => /role\/busperu\/\*$/.test(r)) || (s.NotAction && s.NotAction !== 'iam:PassRole')) fallo(`${n}: no protege role/busperu/*`);
  const pub = P[n].Statement.find((x) => x.Sid === 'RestauracionesSiemprePrivadas');
  if (pub?.Condition?.Bool?.['rds:PubliclyAccessible'] !== 'true') fallo(`${n}: falta el Deny de restauración pública`);
  const base = P[n].Statement.find((x) => x.Sid === 'NoBorrarLaBaseOriginal');
  if (!base || lista(base.Resource)[0]?.endsWith(':db:busperu-prod-db') !== true) fallo(`${n}: la barrera de la base no apunta a busperu-prod-db`);
}
// 4 · operador: toda mutación de la pila exige RoleArn; sin escritura directa ni descifrado
for (const { a, s } of allows(P['operator-policy'])) {
  if (/^cloudformation:(Create(ChangeSet|Stack)|UpdateStack|DeleteStack|ContinueUpdateRollback|RollbackStack)$/.test(a) && !s.Condition?.StringEquals?.['cloudformation:RoleArn']) fallo(`operator: ${a} sin cloudformation:RoleArn`);
  if (/^(rds:(Modify|Reboot|Delete|Restore|CreateDBInstance)|ec2:(Run|Terminate|Delete|Create|Modify|Authorize|Revoke)|elasticloadbalancing:(Create|Delete|Modify)|iam:(Create|Put|Attach|Update|Delete))/.test(a)) fallo(`operator: escritura directa ${a}`);
  if (/^kms:Decrypt/.test(a)) fallo('operator: kms:Decrypt');
}
{ const s = P['operator-barriers'].Statement.find((x) => x.Sid === 'SoloPasaElRolDeEjecucion');
  if (!s || s.Action !== 'iam:PassRole' || !/role\/busperu\/BusPeruProdCloudFormationExecution$/.test(s.NotResource ?? '')) fallo('operator: PassRole no limitado al rol de ejecución'); }
if (!deniega(P['operator-barriers'], 'kms:Decrypt') || !deniega(P['operator-barriers'], 'rds:ModifyDBInstance') || !deniega(P['operator-barriers'], 'rds:RebootDBInstance')) fallo('operator: faltan Deny de descifrado o de Modify/Reboot');
// 5 · recuperación
for (const a of ['rds:DeleteDBInstance', 'rds:ModifyDBInstance', 'rds:RebootDBInstance', 'iam:PutRolePolicy', 'cloudformation:UpdateStack', 'ssm:GetParameter',
  'secretsmanager:GetSecretValue', 'ec2:TerminateInstances', 's3:DeleteObject', 'kms:Decrypt']) if (!deniega(P['recovery-policy'], a)) fallo(`recovery: falta Deny ${a}`);
const rest = P['recovery-policy'].Statement.find((s) => s.Sid === 'RestaurarSoloEnPrivadoYEnInstanciaNueva');
if (rest?.Condition?.Bool?.['rds:PubliclyAccessible'] !== 'false') fallo('recovery: la restauración no exige PubliclyAccessible=false');
if (permite(P['recovery-policy'], /^(iam|cloudformation|ssm|secretsmanager|s3):/)) fallo('recovery: permisos fuera de recuperar');
// 6 · runtime
if (permite(P['app-policy'], /^(iam|cloudformation|rds|secretsmanager|cloudtrail):/) || permite(P['app-policy'], /^ssm:(Put|Delete|SendCommand)/)) fallo('app: permisos de control');
for (const a of ['iam:CreateRole', 'cloudformation:UpdateStack', 'ssm:PutParameter', 'rds:ModifyDBInstance']) if (!deniega(P['app-policy'], a)) fallo(`app: falta Deny ${a}`);
const ssmApp = P['app-policy'].Statement.find((s) => s.Sid === 'SoloLosParametrosDeLaApp');
if (!ssmApp || lista(ssmApp.Resource).some((r) => !/parameter\/busperu\/prod\/(app(\/\*)?|ops\/MIGRATOR_DB_PASSWORD)$/.test(r))) fallo('app: lee parámetros fuera de /busperu/prod/app (salvo la del migrador)');
// 7 · KMS: sin «raíz → kms:*», nadie humano descifra salvo la emergencia, la app solo vía SSM y solo app/
for (const n of ['kms-secrets-key-policy', 'kms-data-key-policy', 'kms-rds-key-policy']) {
  for (const s of P[n].Statement) {
    const pr = lista(s.Principal?.AWS);
    if (s.Principal === '*' || pr.includes('*') || pr.some((x) => /:root$/.test(x))) fallo(`${n}/${s.Sid}: principal raíz o *`);
    if (s.Sid === 'AdministrarSinUsar' && lista(s.Action).some((a) => /^kms:(Decrypt|Encrypt|ReEncrypt|GenerateDataKey)/.test(a))) fallo(`${n}: el administrador puede usar la clave`);
    if (lista(s.Action).includes('kms:Decrypt') && !s.Condition?.StringEquals?.['kms:ViaService']) fallo(`${n}/${s.Sid}: Decrypt sin kms:ViaService`);
  }
}
for (const n of ['kms-data-key-policy']) {
  const d = P[n].Statement.filter((s) => lista(s.Action).includes('kms:Decrypt')).flatMap((s) => lista(s.Principal.AWS).map((x) => x.split('/').pop()));
  if (d.sort().join() !== 'BusPeruProdBreakGlass,busperu-prod-app-role') fallo(`${n}: descifran ${d}`);
  const a = P[n].Statement.find((s) => s.Sid === 'AppDescifraSoloLaClaveDeDatos');
  if (!/parameter\/busperu\/prod\/app\/INTEGRATIONS_ENCRYPTION_KEY\*$/.test(a?.Condition?.StringLike?.['kms:EncryptionContext:PARAMETER_ARN'] ?? '')) fallo(`${n}: la app descifra algo más que la clave de datos`);
}
// F18-08 · la lectura de Access Analyzer: exactamente su rol vinculado y exactamente 4 acciones de lectura, sin condiciones.
for (const n of ['kms-secrets-key-policy', 'kms-data-key-policy', 'kms-rds-key-policy']) {
  const a = P[n].Statement.filter((s) => lista(s.Principal?.AWS).some((x) => /AWSServiceRoleForAccessAnalyzer$/.test(x)));
  const ok = a.length === 1 && lista(a[0].Principal.AWS).length === 1
    && /:role\/aws-service-role\/access-analyzer\.amazonaws\.com\/AWSServiceRoleForAccessAnalyzer$/.test(a[0].Principal.AWS)
    && lista(a[0].Action).sort().join() === 'kms:DescribeKey,kms:GetKeyPolicy,kms:ListGrants,kms:ListKeyPolicies' && a[0].Effect === 'Allow' && !a[0].Condition;
  if (!ok) fallo(`${n}: la lectura de Access Analyzer no es exactamente la autorizada`);
  if (P[n].Statement.some((s) => s.Sid !== 'AccessAnalyzerSoloLee' && lista(s.Principal?.AWS).some((x) => /AccessAnalyzer/.test(x)))) fallo(`${n}: Access Analyzer aparece en otra declaración`);
}
const descifran = P['kms-secrets-key-policy'].Statement.filter((s) => lista(s.Action).includes('kms:Decrypt')).flatMap((s) => lista(s.Principal.AWS).map((x) => x.split('/').pop()));
if (descifran.sort().join() !== 'BusPeruProdBreakGlass,busperu-prod-app-role') fallo(`kms secretos: descifran ${descifran}`);
const appKms = P['kms-secrets-key-policy'].Statement.find((s) => s.Sid === 'AppDescifraSoloSusParametros');
if (!appKms || lista(appKms.Condition?.StringLike?.['kms:EncryptionContext:PARAMETER_ARN']).some((r) => !/parameter\/busperu\/prod\/(app\/\*|ops\/MIGRATOR_DB_PASSWORD)$/.test(r))) fallo('kms secretos: la app descifra fuera de app/ (salvo la del migrador)');
// 8 · CloudTrail: TLS, nadie borra, solo este trail escribe
const bp = P['cloudtrail-bucket-policy'];
if (!bp.Statement.some((s) => s.Effect === 'Deny' && s.Condition?.Bool?.['aws:SecureTransport'] === 'false')) fallo('cloudtrail bucket: sin exigir TLS');
if (!bp.Statement.some((s) => s.Effect === 'Deny' && lista(s.Action).includes('s3:DeleteObject'))) fallo('cloudtrail bucket: se puede borrar');
if (bp.Statement.filter((s) => s.Effect === 'Allow').some((s) => !s.Condition?.StringEquals?.['aws:SourceArn'])) fallo('cloudtrail bucket: escritura sin aws:SourceArn');
const cfg = JSON.parse(readFileSync(new URL('./policies/cloudtrail-config.json', import.meta.url), 'utf8'));
if (!cfg.IsMultiRegionTrail || !cfg.EnableLogFileValidation || !cfg.IncludeGlobalServiceEvents) fallo('cloudtrail: multirregión, eventos globales y validación de integridad obligatorios');
// 9 · en el repositorio, sin cuenta real
for (const f of readdirSync(new URL('./policies/', import.meta.url))) if (/\d{12}/.test(readFileSync(new URL(`./policies/${f}`, import.meta.url), 'utf8'))) fallo(`policies/${f}: número de cuenta real`);

console.log(`Producción: ${Object.keys(P).length} documentos · ${Object.values(P).reduce((n, d) => n + d.Statement.length, 0)} declaraciones`);
if (problemas.length) { console.error(`✖ ${problemas.length} problema(s):\n - ${problemas.join('\n - ')}`); process.exit(1); }
console.log('✔ Modelo de producción conforme (C, B, runtime, emergencia, KMS, CloudTrail).');
