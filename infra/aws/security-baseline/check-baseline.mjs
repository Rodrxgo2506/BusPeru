// BusPerú · F18-08 · comprobación local de la plantilla busperu-security-baseline (sin AWS).
// Garantiza que solo contiene lo autorizado (sin infraestructura de aplicación) y las propiedades de seguridad.
import { readFileSync } from 'node:fs';
import { ALERTAS } from './build-baseline.mjs';

const t = JSON.parse(readFileSync(new URL('./busperu-security-baseline.json', import.meta.url), 'utf8'));
const problemas = [];
const fallo = (m) => problemas.push(m);
const R = Object.entries(t.Resources);
const PERMITIDOS = new Set(['AWS::IAM::ManagedPolicy', 'AWS::IAM::Role', 'AWS::KMS::Key', 'AWS::KMS::Alias', 'AWS::SNS::Topic', 'AWS::S3::Bucket', 'AWS::S3::BucketPolicy',
  'AWS::Logs::LogGroup', 'AWS::CloudTrail::Trail', 'AWS::Logs::MetricFilter', 'AWS::CloudWatch::Alarm', 'AWS::AccessAnalyzer::Analyzer']);
for (const [id, r] of R) if (!PERMITIDOS.has(r.Type)) fallo(`${id}: tipo no autorizado en la línea base (${r.Type})`);
const de = (tipo) => R.filter(([, r]) => r.Type === tipo);
// KMS: 3 claves, conservadas, rotación, 30 días
const claves = de('AWS::KMS::Key');
if (claves.length !== 3) fallo(`se esperaban 3 CMK y hay ${claves.length}`);
for (const [id, r] of claves) {
  if (r.DeletionPolicy !== 'Retain' || r.UpdateReplacePolicy !== 'Retain') fallo(`${id}: sin Retain`);
  if (r.Properties.EnableKeyRotation !== true || r.Properties.PendingWindowInDays !== 30) fallo(`${id}: sin rotación o espera < 30 días`);
  // En una política de clave `Resource: "*"` es la propia clave; lo que no puede haber es un principal raíz o «*».
  for (const s of r.Properties.KeyPolicy.Statement) {
    const pr = JSON.stringify(s.Principal ?? '');
    if (s.Principal === '*' || /"AWS":"\*"|:root/.test(pr)) fallo(`${id}/${s.Sid}: principal raíz o *`);
  }
}
// CloudTrail
const [[, tr]] = de('AWS::CloudTrail::Trail');
const tp = tr.Properties;
if (!tp.IsMultiRegionTrail || !tp.IncludeGlobalServiceEvents || !tp.EnableLogFileValidation || !tp.IsLogging || tp.EventSelectors?.[0]?.ReadWriteType !== 'All') fallo('trail: multirregión, globales, validación, registrando y lectura+escritura');
const [[, b]] = de('AWS::S3::Bucket');
const pab = b.Properties.PublicAccessBlockConfiguration;
if (!pab || !Object.values(pab).every(Boolean)) fallo('bucket de auditoría sin bloqueo público completo');
if (b.DeletionPolicy !== 'Retain' || b.Properties.VersioningConfiguration?.Status !== 'Enabled' || !b.Properties.BucketEncryption) fallo('bucket de auditoría: Retain, versionado y cifrado');
const [[, lg]] = de('AWS::Logs::LogGroup');
if (lg.Properties.RetentionInDays !== 90) fallo('registros de auditoría: retención distinta de 90 días');
// Alertas
if (de('AWS::Logs::MetricFilter').length !== ALERTAS.length || de('AWS::CloudWatch::Alarm').length !== ALERTAS.length) fallo('filtros o alarmas no coinciden con las alertas documentadas');
for (const [id, r] of de('AWS::CloudWatch::Alarm')) if (JSON.stringify(r.Properties.AlarmActions) !== '[{"Ref":"TemaSeguridad"}]') fallo(`${id}: no avisa al tema de seguridad`);
for (const n of ['root-usage', 'iam-policy-changes', 'role-trust-changes', 'kms-policy-changes', 'secrets-manager-changes', 'ssm-parameter-deletion', 'rds-deletion', 'rds-public-exposure', 'security-group-changes', 'cloudtrail-disabled'])
  if (!ALERTAS.some((a) => a[1] === n)) fallo(`falta la alerta ${n}`);
// SNS sin suscripciones (las autoriza el propietario aparte)
for (const [id, r] of de('AWS::SNS::Topic')) if (r.Properties.Subscription) fallo(`${id}: suscripción no autorizada`);
// Roles: rutas y confianzas
for (const [id, r] of de('AWS::IAM::Role')) {
  const confianza = JSON.stringify(r.Properties.AssumeRolePolicyDocument);
  if (/"AWS":"\*"|:root/.test(confianza)) fallo(`${id}: confianza abierta`);
  if (/"AWS"/.test(confianza) && !/aws:MultiFactorAuthPresent/.test(confianza)) fallo(`${id}: confianza humana sin MFA`);
}
if (JSON.stringify(t).match(/\d{12}/)) fallo('la plantilla contiene un número de cuenta');
if (JSON.stringify(t).length > 460800) fallo('plantilla mayor que el límite de CloudFormation por URL');
console.log(`Línea base: ${R.length} recursos · ${claves.length} CMK · ${ALERTAS.length} alertas`);
if (problemas.length) { console.error(`✖ ${problemas.length} problema(s):\n - ${problemas.join('\n - ')}`); process.exit(1); }
console.log('✔ Solo recursos autorizados; KMS conservado y rotado; trail completo; alertas y SNS correctos.');
