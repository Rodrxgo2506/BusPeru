// BusPerú · F18-08 · pila `busperu-security-baseline` (cuenta, sa-east-1). Solo genera la plantilla: no llama a AWS.
//
// Contiene lo AUTORIZADO por el propietario para la línea base de seguridad de producción, y nada más:
//   · 3 CMK (secretos, clave de datos de la app, RDS) con alias, rotación anual, borrado con 30 días y Retain;
//   · roles de producción C (ejecución + operador), B (recuperación), emergencia y runtime, con sus políticas
//     gestionadas y el límite de permisos de la carga (documentos de infra/aws/iam/prod/, ya comprobados);
//   · CloudTrail multirregión → S3 privado (validación de integridad, SSE, versionado, ciclo de vida) y
//     → CloudWatch Logs (90 días) con filtros de métrica y alarmas de seguridad → SNS;
//   · temas SNS de producción (seguridad y alarmas), sin suscripciones;
//   · IAM Access Analyzer de la cuenta (acceso externo).
// NO contiene infraestructura de aplicación (VPC, EC2, ALB, RDS, CloudFront, DNS).
//
//   node build-baseline.mjs            → busperu-security-baseline.json
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exec, operador, recuperacion, emergencia, app, kms, trail } from '../iam/prod/build-iam-prod.mjs';
import { boundary } from '../iam/build-iam.mjs';

const P = 'busperu-prod';
const RETENCION_LOGS = 90;          // decisión del propietario (F18-08)
const RETENCION_TRAIL_S3 = 400;     // auditoría en S3 más allá de los registros operativos

/** Cambia el marcador de cuenta por ${AWS::AccountId} dentro de Fn::Sub (escapando las variables de IAM). */
const sub = (v) => {
  if (typeof v === 'string') return v.includes('{{ACCOUNT_ID}}') ? { 'Fn::Sub': v.replaceAll('${', '${!').replaceAll('{{ACCOUNT_ID}}', '${AWS::AccountId}') } : v;
  if (Array.isArray(v)) return v.map(sub);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
  return v;
};
const aProd = (d) => JSON.parse(JSON.stringify(d).replaceAll('/busperu/staging', '/busperu/prod').replaceAll('busperu-staging', P).replaceAll('BusPeruStaging', 'BusPeruProd')
  .replace(/("(?:aws:(?:Resource|Request)Tag\/)?Environment":)"staging"/g, '$1"prod"'));
const etiquetas = [{ Key: 'Project', Value: 'busperu' }, { Key: 'Environment', Value: 'prod' }, { Key: 'Stack', Value: 'security-baseline' }];
const R = {};
const politica = (id, nombre, doc, desc) => { R[id] = { Type: 'AWS::IAM::ManagedPolicy', Properties: { ManagedPolicyName: nombre, Path: '/busperu/', Description: desc, PolicyDocument: sub(doc) } }; return { Ref: id }; };
const rol = (id, nombre, trust, politicas, extra = {}) => {
  R[id] = { Type: 'AWS::IAM::Role', Properties: { RoleName: nombre, Path: extra.path ?? '/busperu/', AssumeRolePolicyDocument: sub(trust), ManagedPolicyArns: politicas, MaxSessionDuration: extra.sesion ?? 3600, Tags: etiquetas, ...(extra.limite ? { PermissionsBoundary: extra.limite } : {}) } };
};

// ------------------------------------------------------------------ IAM
const limite = politica('LimiteDeLaCarga', 'BusPeruProdWorkloadBoundary', aProd(boundary), 'Límite obligatorio de los roles de la carga de producción');
rol('RolDeEjecucion', 'BusPeruProdCloudFormationExecution', exec.trust, [
  politica('EjecucionBarreras', 'BusPeruProdExecutionBarriers', exec.barreras, 'C · barreras explícitas'),
  politica('EjecucionNucleo', 'BusPeruProdExecutionCore', exec.core, 'C · IAM de la carga, secreto maestro, KMS de RDS vía RDS'),
  politica('EjecucionComputo', 'BusPeruProdExecutionCompute', exec.compute, 'C · EC2 y ELB de la pila'),
  politica('EjecucionDatos', 'BusPeruProdExecutionData', exec.data, 'C · RDS, S3, logs, alarmas, SNS y DLM de la pila'),
]);
rol('RolDelOperador', 'BusPeruProdOperator', operador.trust, [
  politica('OperadorBarreras', 'BusPeruProdOperatorBarriers', operador.barreras, 'C · barreras del operador humano'),
  politica('OperadorPolitica', 'BusPeruProdOperatorPolicy', operador.policy, 'C · change sets con RoleArn, lecturas, Run Command'),
], { sesion: 7200 });
rol('RolDeRecuperacion', 'BusPeruProdRecovery', recuperacion.trust, [politica('RecuperacionPolitica', 'BusPeruProdRecoveryPolicy', recuperacion.policy, 'B · restaurar en privado')]);
rol('RolDeEmergencia', 'BusPeruProdBreakGlass', emergencia.trust, [politica('EmergenciaPolitica', 'BusPeruProdBreakGlassPolicy', emergencia.policy, 'Emergencia · descifrar un parámetro vía SSM')]);
rol('RolDeLaApp', `${P}-app-role`, app.trust, [politica('AppPolitica', 'BusPeruProdAppPolicy', app.policy, 'Runtime · parámetros de app/, registros, métricas')], { path: '/', limite });

// ------------------------------------------------------------------ KMS
const roles = ['RolDeEjecucion', 'RolDelOperador', 'RolDeRecuperacion', 'RolDeEmergencia', 'RolDeLaApp'];
const clave = (id, alias, politicaDoc, desc) => {
  R[id] = { Type: 'AWS::KMS::Key', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', DependsOn: roles,
    Properties: { Description: desc, EnableKeyRotation: true, PendingWindowInDays: 30, KeySpec: 'SYMMETRIC_DEFAULT', KeyUsage: 'ENCRYPT_DECRYPT', KeyPolicy: sub(politicaDoc), Tags: etiquetas } };
  R[`${id}Alias`] = { Type: 'AWS::KMS::Alias', Properties: { AliasName: alias, TargetKeyId: { Ref: id } } };
};
clave('ClaveSecretos', `alias/${P}-secrets`, kms.secretos, 'BusPeru prod: SecureString de /busperu/prod/ (salvo la clave de datos)');
clave('ClaveDatos', `alias/${P}-data`, kms.datos, 'BusPeru prod: solo /busperu/prod/app/INTEGRATIONS_ENCRYPTION_KEY*');
clave('ClaveRds', `alias/${P}-rds`, kms.rds, 'BusPeru prod: almacenamiento, snapshots y backups de RDS');

// ------------------------------------------------------------------ SNS
R.TemaSeguridad = { Type: 'AWS::SNS::Topic', Properties: { TopicName: `${P}-security`, DisplayName: 'BusPeru prod seguridad', Tags: etiquetas } };
R.TemaAlarmas = { Type: 'AWS::SNS::Topic', Properties: { TopicName: `${P}-alarms`, DisplayName: 'BusPeru prod alarmas', Tags: etiquetas } };

// ------------------------------------------------------------------ CloudTrail
const bucketTrail = `${P}-cloudtrail-{{ACCOUNT_ID}}`;
R.BucketAuditoria = { Type: 'AWS::S3::Bucket', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: {
  BucketName: sub(bucketTrail),
  PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
  BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }, BucketKeyEnabled: true }] },
  VersioningConfiguration: { Status: 'Enabled' },
  OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
  LifecycleConfiguration: { Rules: [{ Id: 'RetencionDeAuditoria', Status: 'Enabled', ExpirationInDays: RETENCION_TRAIL_S3, NoncurrentVersionExpiration: { NoncurrentDays: 30 },
    Transitions: [{ StorageClass: 'STANDARD_IA', TransitionInDays: 90 }] }] },
  Tags: etiquetas } };
R.PoliticaBucketAuditoria = { Type: 'AWS::S3::BucketPolicy', Properties: { Bucket: { Ref: 'BucketAuditoria' }, PolicyDocument: sub(trail.bucketPolicy) } };
R.RegistrosAuditoria = { Type: 'AWS::Logs::LogGroup', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: { LogGroupName: '/busperu/security/cloudtrail', RetentionInDays: RETENCION_LOGS, Tags: etiquetas } };
R.RolTrailALogs = { Type: 'AWS::IAM::Role', Properties: { RoleName: 'BusPeruProdCloudTrailToLogs', Path: '/busperu/', Tags: etiquetas,
  AssumeRolePolicyDocument: sub({ Version: '2012-10-17', Statement: [{ Sid: 'SoloCloudTrailDeEstaCuenta', Effect: 'Allow', Principal: { Service: 'cloudtrail.amazonaws.com' }, Action: 'sts:AssumeRole',
    Condition: { StringEquals: { 'aws:SourceAccount': '{{ACCOUNT_ID}}' } } }] }),
  Policies: [{ PolicyName: 'EscribirSoloEnSuGrupo', PolicyDocument: { Version: '2012-10-17', Statement: [{ Sid: 'EscribirSoloEnSuGrupo', Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
    Resource: { 'Fn::Sub': '${RegistrosAuditoria.Arn}' } }] } }] } };
R.Trail = { Type: 'AWS::CloudTrail::Trail', DependsOn: ['PoliticaBucketAuditoria'], Properties: {
  TrailName: trail.config.Name, S3BucketName: { Ref: 'BucketAuditoria' }, IsLogging: true, IsMultiRegionTrail: true, IncludeGlobalServiceEvents: true, EnableLogFileValidation: true,
  EventSelectors: [{ ReadWriteType: 'All', IncludeManagementEvents: true }],
  CloudWatchLogsLogGroupArn: { 'Fn::GetAtt': ['RegistrosAuditoria', 'Arn'] }, CloudWatchLogsRoleArn: { 'Fn::GetAtt': ['RolTrailALogs', 'Arn'] }, Tags: etiquetas } };

// ------------------------------------------------------------------ alertas de seguridad (filtros de métrica + alarmas)
export const ALERTAS = [
  ['UsoDeLaRaiz', 'root-usage', '{ $.userIdentity.type = "Root" && $.userIdentity.invokedBy NOT EXISTS && $.eventType != "AwsServiceEvent" }'],
  ['CambiosDePoliticasIam', 'iam-policy-changes', '{ ($.eventSource = "iam.amazonaws.com") && (($.eventName = "DeleteGroupPolicy") || ($.eventName = "DeleteRolePolicy") || ($.eventName = "DeleteUserPolicy") || ($.eventName = "PutGroupPolicy") || ($.eventName = "PutRolePolicy") || ($.eventName = "PutUserPolicy") || ($.eventName = "CreatePolicy") || ($.eventName = "DeletePolicy") || ($.eventName = "CreatePolicyVersion") || ($.eventName = "DeletePolicyVersion") || ($.eventName = "SetDefaultPolicyVersion") || ($.eventName = "AttachRolePolicy") || ($.eventName = "DetachRolePolicy") || ($.eventName = "AttachUserPolicy") || ($.eventName = "DetachUserPolicy") || ($.eventName = "AttachGroupPolicy") || ($.eventName = "DetachGroupPolicy") || ($.eventName = "PutRolePermissionsBoundary") || ($.eventName = "DeleteRolePermissionsBoundary")) }'],
  ['CambiosDeConfianza', 'role-trust-changes', '{ ($.eventSource = "iam.amazonaws.com") && ($.eventName = "UpdateAssumeRolePolicy") }'],
  ['CambiosDeKms', 'kms-policy-changes', '{ ($.eventSource = "kms.amazonaws.com") && (($.eventName = "PutKeyPolicy") || ($.eventName = "ScheduleKeyDeletion") || ($.eventName = "DisableKey") || ($.eventName = "DisableKeyRotation")) }'],
  ['CambiosDeSecretos', 'secrets-manager-changes', '{ ($.eventSource = "secretsmanager.amazonaws.com") && (($.eventName = "DeleteSecret") || ($.eventName = "PutSecretValue") || ($.eventName = "UpdateSecret") || ($.eventName = "PutResourcePolicy")) }'],
  ['BorradoDeParametros', 'ssm-parameter-deletion', '{ ($.eventSource = "ssm.amazonaws.com") && (($.eventName = "DeleteParameter") || ($.eventName = "DeleteParameters")) }'],
  ['BorradoDeRds', 'rds-deletion', '{ ($.eventSource = "rds.amazonaws.com") && (($.eventName = "DeleteDBInstance") || ($.eventName = "DeleteDBSnapshot") || ($.eventName = "DeleteDBCluster") || ($.eventName = "DeleteDBInstanceAutomatedBackup")) }'],
  ['ExposicionDeRds', 'rds-public-exposure', '{ ($.eventSource = "rds.amazonaws.com") && (($.eventName = "ModifyDBSnapshotAttribute") || ($.requestParameters.publiclyAccessible IS TRUE) || ($.requestParameters.deletionProtection IS FALSE) || ($.requestParameters.backupRetentionPeriod = 0)) }'],
  ['CambiosDeGruposDeSeguridad', 'security-group-changes', '{ ($.eventName = "AuthorizeSecurityGroupIngress") || ($.eventName = "AuthorizeSecurityGroupEgress") || ($.eventName = "RevokeSecurityGroupIngress") || ($.eventName = "RevokeSecurityGroupEgress") || ($.eventName = "CreateSecurityGroup") || ($.eventName = "DeleteSecurityGroup") || ($.eventName = "ModifySecurityGroupRules") }'],
  ['AuditoriaDesactivada', 'cloudtrail-disabled', '{ ($.eventSource = "cloudtrail.amazonaws.com") && (($.eventName = "StopLogging") || ($.eventName = "DeleteTrail") || ($.eventName = "UpdateTrail") || ($.eventName = "PutEventSelectors")) }'],
  ['UsoDeEmergencia', 'break-glass-usage', '{ ($.eventName = "AssumeRole") && ($.requestParameters.roleArn = "*BusPeruProdBreakGlass") }'],
];
for (const [id, nombre, patron] of ALERTAS) {
  R[`Filtro${id}`] = { Type: 'AWS::Logs::MetricFilter', Properties: { LogGroupName: { Ref: 'RegistrosAuditoria' }, FilterPattern: patron,
    MetricTransformations: [{ MetricNamespace: 'BusPeru/Security', MetricName: nombre, MetricValue: '1', DefaultValue: 0 }] } };
  R[`Alarma${id}`] = { Type: 'AWS::CloudWatch::Alarm', Properties: { AlarmName: `${P}-security-${nombre}`, AlarmDescription: `Seguridad: ${nombre} (CloudTrail)`,
    Namespace: 'BusPeru/Security', MetricName: nombre, Statistic: 'Sum', Period: 300, EvaluationPeriods: 1, Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    TreatMissingData: 'notBreaching', AlarmActions: [{ Ref: 'TemaSeguridad' }], OKActions: [{ Ref: 'TemaSeguridad' }] } };
}

// ------------------------------------------------------------------ Access Analyzer
R.Analizador = { Type: 'AWS::AccessAnalyzer::Analyzer', Properties: { AnalyzerName: 'busperu-account-external-access', Type: 'ACCOUNT', Tags: etiquetas } };

export const plantilla = {
  AWSTemplateFormatVersion: '2010-09-09',
  Description: 'BusPeru - linea base de seguridad de produccion (F18-08): KMS, roles C/B/emergencia/runtime, CloudTrail, alertas, SNS, Access Analyzer. Sin infraestructura de aplicacion.',
  Resources: R,
  Outputs: {
    ClaveSecretosArn: { Value: { 'Fn::GetAtt': ['ClaveSecretos', 'Arn'] } }, ClaveDatosArn: { Value: { 'Fn::GetAtt': ['ClaveDatos', 'Arn'] } }, ClaveRdsArn: { Value: { 'Fn::GetAtt': ['ClaveRds', 'Arn'] } },
    TemaSeguridadArn: { Value: { Ref: 'TemaSeguridad' } }, TemaAlarmasArn: { Value: { Ref: 'TemaAlarmas' } }, TrailArn: { Value: { 'Fn::GetAtt': ['Trail', 'Arn'] } },
  },
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const texto = JSON.stringify(plantilla);
  writeFileSync(new URL('./busperu-security-baseline.json', import.meta.url), `${texto}\n`);
  const tipos = {};
  for (const r of Object.values(R)) tipos[r.Type] = (tipos[r.Type] ?? 0) + 1;
  console.log(`busperu-security-baseline.json · ${texto.length} bytes · ${Object.keys(R).length} recursos`);
  for (const [t, n] of Object.entries(tipos)) console.log(`  ${String(n).padStart(2)} × ${t}`);
}
