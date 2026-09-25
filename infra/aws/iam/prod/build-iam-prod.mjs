// BusPerú · F18-08 · modelo IAM/KMS/CloudTrail de PRODUCCIÓN como código. Solo genera JSON: no llama a AWS
// y no crea nada. Se deriva de las políticas de staging ya validadas (F18-03D → F18-07B) cambiando el prefijo,
// y separa las identidades (diseño C + B de HARDENING-F18-07A.md e IAM-MONITORING-F18-07B.md):
//
//   BusPeruProdCloudFormationExecution  (C) rol de servicio de CloudFormation: escribe la infraestructura
//   BusPeruProdOperator                 (C) humano con MFA: solo change sets con el rol de C, lecturas, Run Command
//   BusPeruProdRecovery                 (B) humano con MFA: restaurar en privado, nada más
//   BusPeruProdBreakGlass                   humano con MFA: único que puede descifrar un secreto fuera de la app
//   busperu-prod-app-role                   la EC2: lee /busperu/prod/app/ y descifra solo eso, vía SSM
//
//   node build-iam-prod.mjs [--account <id>] [--out <dir>]     (sin --account: marcador {{ACCOUNT_ID}})
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { politicas as staging } from '../build-iam.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const CUENTA = args.account ?? '{{ACCOUNT_ID}}';
const R = 'sa-east-1';
const P = 'busperu-prod';
const ADMIN = `arn:aws:iam::${CUENTA}:user/Rodrigo`;
const rol = (n) => `arn:aws:iam::${CUENTA}:role/busperu/${n}`;
const EXEC = rol('BusPeruProdCloudFormationExecution');
const OPERADOR = rol('BusPeruProdOperator');
const RECUPERACION = rol('BusPeruProdRecovery');
const EMERGENCIA = rol('BusPeruProdBreakGlass');
const APP = `arn:aws:iam::${CUENTA}:role/${P}-app-role`;
const ALIAS_SECRETOS = `alias/${P}-secrets`;
const ALIAS_RDS = `alias/${P}-rds`;
// F18-08 (decisión del propietario): la clave de datos de la app (cuentas bancarias e integraciones) va en su
// propia CMK, separada del resto de secretos.
const ALIAS_DATOS = `alias/${P}-data`;
const PARAM_DATOS = `arn:aws:ssm:${R}:${CUENTA}:parameter/busperu/prod/app/INTEGRATIONS_ENCRYPTION_KEY*`;
const TRAIL = `arn:aws:cloudtrail:${R}:${CUENTA}:trail/${P}-trail`;
const BUCKET_TRAIL = `${P}-cloudtrail-${CUENTA}`;
// Las migraciones corren en la instancia (Run Command): su rol lee SOLO este parámetro de ops/; la API no lo
// recibe porque render-env.sh solo lee app/.
const MIGRADOR = `arn:aws:ssm:${R}:${CUENTA}:parameter/busperu/prod/ops/MIGRATOR_DB_PASSWORD`;
const MFA = { Bool: { 'aws:MultiFactorAuthPresent': 'true' }, NumericLessThan: { 'aws:MultiFactorAuthAge': '3600' } };
const region = { StringEquals: { 'aws:RequestedRegion': R } };
const doc = (Statement) => ({ Version: '2012-10-17', Statement });

/** Mismo documento de staging con el prefijo de producción (recursos, rutas, etiquetas, nombres de rol). */
const aProd = (d) => JSON.parse(JSON.stringify(d)
  .replaceAll('/busperu/staging', '/busperu/prod')
  .replaceAll('busperu-staging', P)
  .replaceAll('BusPeruStaging', 'BusPeruProd')
  .replace(/("(?:aws:(?:Resource|Request)Tag\/)?Environment":)"staging"/g, '$1"prod"'));
const sids = (d, lista) => aProd(d).Statement.filter((s) => lista.includes(s.Sid));
const confianzaHumana = (sid) => doc([{ Sid: sid, Effect: 'Allow', Principal: { AWS: ADMIN }, Action: 'sts:AssumeRole', Condition: MFA }]);

// ------------------------------------------------------------------ barreras comunes (Deny explícito)
const BARRERAS_STAGING = ['SoloSaoPaulo', 'NadaSobreLaVpcPorDefecto', 'NiLaVpcPorDefectoEnSi', 'SinAdministrarPersonasNiCredenciales', 'IntocableLaIdentidadDeDespliegue',
  'NingunSecretoEnClaro', 'NoBorrarLaBaseOriginal', 'NoBorrarNiCompartirCopias', 'RestauracionesSiemprePrivadas', 'NoBorrarSecretosCriticos'];
const barrerasProd = [
  ...sids(staging.BusPeruStagingDeployerPolicy, BARRERAS_STAGING),
  { Sid: 'NoBorrarSecretosNiClaves', Effect: 'Deny', Resource: '*',
    Action: ['secretsmanager:DeleteSecret', 'kms:ScheduleKeyDeletion', 'kms:DisableKey', 'kms:PutKeyPolicy', 'kms:CreateGrant', 'kms:Decrypt', 'kms:ReEncryptFrom'],
    Condition: { 'ForAnyValue:StringEquals': { 'kms:ResourceAliases': [ALIAS_SECRETOS, ALIAS_DATOS] } } },
  { Sid: 'NoBorrarSecretsManager', Effect: 'Deny', Action: ['secretsmanager:DeleteSecret'], Resource: '*' },
  { Sid: 'NoTocarLaAuditoria', Effect: 'Deny', Resource: '*',
    Action: ['cloudtrail:StopLogging', 'cloudtrail:DeleteTrail', 'cloudtrail:UpdateTrail', 'cloudtrail:PutEventSelectors', 'cloudtrail:PutInsightSelectors',
      'events:DeleteRule', 'events:DisableRule', 'events:PutRule', 'events:RemoveTargets', 'events:PutTargets'] },
  { Sid: 'NoTocarElBucketDeAuditoria', Effect: 'Deny', Action: 's3:*', Resource: [`arn:aws:s3:::${BUCKET_TRAIL}`, `arn:aws:s3:::${BUCKET_TRAIL}/*`] },
  { Sid: 'NingunaClaveKmsSeBorra', Effect: 'Deny', Action: ['kms:ScheduleKeyDeletion', 'kms:DisableKey', 'kms:PutKeyPolicy'], Resource: '*' },
];
// La primera de arriba duplica deliberadamente la clave de secretos en una sola declaración legible; la última
// cubre todas las claves. `kms:CreateGrant` sobre la clave de secretos: nadie salvo SSM necesita concesiones.

// ------------------------------------------------------------------ C · rol de ejecución de CloudFormation
const IAM_DE_LA_CARGA = ['CrearRolesSoloConLimite', 'SoloLaPoliticaGestionadaDeDlm', 'GestionarRolesDeLaPila', 'PerfilDeInstanciaDeLaPila', 'ListarRolesYPerfiles',
  'PasarRolDeLaAppSoloAEc2', 'PasarRolDeDlmSoloADlm', 'RolesVinculadosDeElbYRds'];
export const exec = {
  trust: doc([{ Sid: 'SoloCloudFormationDeEstaCuenta', Effect: 'Allow', Principal: { Service: 'cloudformation.amazonaws.com' }, Action: 'sts:AssumeRole',
    Condition: { StringEquals: { 'aws:SourceAccount': CUENTA } } }]),
  // IAM limita cada política gestionada a 6 144 caracteres: las barreras van en su propia política.
  barreras: doc(barrerasProd),
  core: doc([
    ...sids(staging.BusPeruStagingDeployerPolicy, IAM_DE_LA_CARGA),
    ...sids(staging['BusPeruStagingDeployerPolicy-Operate'], ['SecretoMaestroQueCreaRds', 'AmiPublicaDeAmazonLinux']),
    { Sid: 'ClaveDeLaBaseSoloViaRds', Effect: 'Allow', Action: ['kms:DescribeKey', 'kms:CreateGrant', 'kms:GenerateDataKeyWithoutPlaintext', 'kms:Decrypt', 'kms:Encrypt', 'kms:ReEncrypt*'],
      Resource: `arn:aws:kms:${R}:${CUENTA}:key/*`,
      Condition: { StringEquals: { 'kms:ViaService': `rds.${R}.amazonaws.com` }, 'ForAnyValue:StringEquals': { 'kms:ResourceAliases': [ALIAS_RDS] } } },
  ]),
  compute: aProd(staging['BusPeruStagingDeployerPolicy-Compute']),
  data: aProd(staging['BusPeruStagingDeployerPolicy-Data']),
};

// ------------------------------------------------------------------ C · operador humano
const MUTAN_LA_PILA = ['cloudformation:CreateChangeSet', 'cloudformation:CreateStack', 'cloudformation:UpdateStack', 'cloudformation:DeleteStack',
  'cloudformation:ContinueUpdateRollback', 'cloudformation:RollbackStack'];
export const operador = {
  trust: confianzaHumana('SoloElAdministradorConMfa'),
  barreras: doc([
    ...barrerasProd.map((s) => (s.Sid === 'IntocableLaIdentidadDeDespliegue' ? { ...s, Action: undefined, NotAction: 'iam:PassRole' } : s)),
    { Sid: 'SoloPasaElRolDeEjecucion', Effect: 'Deny', Action: 'iam:PassRole', NotResource: EXEC },
    { Sid: 'SinEscrituraDirectaEnLaInfraestructura', Effect: 'Deny', Resource: '*',
      Action: ['rds:ModifyDBInstance', 'rds:RebootDBInstance', 'rds:DeleteDBInstance', 'rds:CreateDBInstance', 'rds:RestoreDBInstance*',
        'ec2:TerminateInstances', 'ec2:DeleteVolume', 'ec2:DetachVolume', 'ec2:ModifyInstanceAttribute', 'ec2:AuthorizeSecurityGroup*',
        'ec2:RevokeSecurityGroup*', 'ec2:CreateSecurityGroup', 'ec2:DeleteSecurityGroup', 'ec2:ModifySecurityGroupRules', 'elasticloadbalancing:Delete*',
        'elasticloadbalancing:Modify*', 'dlm:DeleteLifecyclePolicy', 'dlm:UpdateLifecyclePolicy', 'cloudwatch:DeleteAlarms', 'logs:DeleteLogGroup', 'kms:Decrypt'] },
  ]),
  policy: doc([
    { Sid: 'PilaSoloConElRolDeEjecucion', Effect: 'Allow', Action: MUTAN_LA_PILA, Resource: `arn:aws:cloudformation:${R}:${CUENTA}:stack/${P}/*`,
      Condition: { StringEquals: { 'cloudformation:RoleArn': EXEC } } },
    { Sid: 'EjecutarYLeerLaPila', Effect: 'Allow',
      Action: ['cloudformation:ExecuteChangeSet', 'cloudformation:DescribeChangeSet', 'cloudformation:DeleteChangeSet', 'cloudformation:ListChangeSets',
        'cloudformation:DescribeStacks', 'cloudformation:DescribeStackEvents', 'cloudformation:DescribeStackResource', 'cloudformation:DescribeStackResources',
        'cloudformation:ListStackResources', 'cloudformation:GetTemplate', 'cloudformation:DetectStackDrift', 'cloudformation:DescribeStackResourceDrifts'],
      Resource: [`arn:aws:cloudformation:${R}:${CUENTA}:stack/${P}/*`, `arn:aws:cloudformation:${R}:${CUENTA}:changeSet/*/*`] },
    ...sids(staging.BusPeruStagingDeployerPolicy, ['CloudFormationSinRecurso']),
    { Sid: 'PasarSoloElRolDeEjecucion', Effect: 'Allow', Action: 'iam:PassRole', Resource: EXEC,
      Condition: { StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } } },
    { Sid: 'LecturasDeOperacion', Effect: 'Allow', Resource: '*', Condition: region,
      Action: ['ec2:Describe*', 'elasticloadbalancing:Describe*', 'rds:Describe*', 'rds:ListTagsForResource', 'cloudwatch:DescribeAlarms', 'cloudwatch:GetMetricData',
        'cloudwatch:ListMetrics', 'dlm:GetLifecyclePolicies', 'sns:ListTopics', 'sns:ListSubscriptions', 'logs:DescribeLogGroups'] },
    { Sid: 'RegistrosDeLaApp', Effect: 'Allow', Action: ['logs:DescribeLogStreams', 'logs:GetLogEvents', 'logs:FilterLogEvents'],
      Resource: `arn:aws:logs:${R}:${CUENTA}:log-group:/busperu/prod/*` },
    { Sid: 'SnapshotAntesDeMigrar', Effect: 'Allow', Action: ['rds:CreateDBSnapshot', 'rds:AddTagsToResource'],
      Resource: [`arn:aws:rds:${R}:${CUENTA}:db:${P}-db`, `arn:aws:rds:${R}:${CUENTA}:snapshot:${P}-*`] },
    { Sid: 'SubirVersiones', Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject'], Resource: `arn:aws:s3:::${P}-artifacts-*/releases/*` },
    { Sid: 'ListarVersiones', Effect: 'Allow', Action: 's3:ListBucket', Resource: `arn:aws:s3:::${P}-artifacts-*` },
    ...sids(staging['BusPeruStagingDeployerPolicy-Operate'], ['ParametrosDeStaging', 'ListarParametros', 'SesionEnLaInstanciaDeLaPila', 'DocumentoDeSesion',
      'SusPropiasSesiones', 'EstadoDeSesiones', 'ComandosSoloEnLaInstanciaDeLaPila', 'SoloElDocumentoRunShellScript', 'ResultadosDeComandos'])
      .map((s) => (s.Sid === 'ParametrosDeStaging'
        ? { ...s, Sid: 'ParametrosDeProduccionSinBorrar', Action: s.Action.filter((a) => !/Delete/.test(a)) } : s)),
  ]),
};

// ------------------------------------------------------------------ B · recuperación
export const recuperacion = {
  trust: confianzaHumana('SoloElAdministradorConMfa'),
  policy: doc([
    { Sid: 'LeerParaRecuperar', Effect: 'Allow', Resource: '*', Condition: region,
      Action: ['rds:DescribeDBInstances', 'rds:DescribeDBSnapshots', 'rds:DescribeDBInstanceAutomatedBackups', 'rds:DescribeDBSubnetGroups',
        'rds:DescribeDBParameterGroups', 'rds:DescribeEvents', 'rds:ListTagsForResource', 'ec2:DescribeSecurityGroups', 'ec2:DescribeSubnets', 'ec2:DescribeVpcs'] },
    { Sid: 'RestaurarSoloEnPrivadoYEnInstanciaNueva', Effect: 'Allow',
      Action: ['rds:RestoreDBInstanceToPointInTime', 'rds:RestoreDBInstanceFromDBSnapshot'],
      Resource: [`arn:aws:rds:${R}:${CUENTA}:db:${P}-dr-*`, `arn:aws:rds:${R}:${CUENTA}:db:${P}-db`, `arn:aws:rds:${R}:${CUENTA}:snapshot:*`,
        `arn:aws:rds:${R}:${CUENTA}:auto-backup:*`, `arn:aws:rds:${R}:${CUENTA}:subgrp:${P}-*`, `arn:aws:rds:${R}:${CUENTA}:pg:${P}-*`,
        `arn:aws:rds:${R}:${CUENTA}:og:default:mariadb-10-11`],
      Condition: { Bool: { 'rds:PubliclyAccessible': 'false' } } },
    { Sid: 'EtiquetarLaRestaurada', Effect: 'Allow', Action: 'rds:AddTagsToResource', Resource: `arn:aws:rds:${R}:${CUENTA}:db:${P}-dr-*` },
    { Sid: 'ClaveDeLaBaseSoloViaRds', Effect: 'Allow', Action: ['kms:DescribeKey', 'kms:CreateGrant'], Resource: `arn:aws:kms:${R}:${CUENTA}:key/*`,
      Condition: { StringEquals: { 'kms:ViaService': `rds.${R}.amazonaws.com` }, Bool: { 'kms:GrantIsForAWSResource': 'true' },
        'ForAnyValue:StringEquals': { 'kms:ResourceAliases': [ALIAS_RDS] } } },
    { Sid: 'NadaDestructivoNiFueraDeRecuperar', Effect: 'Deny', Resource: '*',
      Action: ['rds:Delete*', 'rds:Modify*', 'rds:Reboot*', 'rds:StartExportTask', 'rds:CopyDBSnapshot', 'iam:*', 'sts:AssumeRole', 'cloudformation:*', 'ssm:*',
        'secretsmanager:*', 'ec2:Delete*', 'ec2:Terminate*', 'ec2:Modify*', 's3:*', 'kms:ScheduleKeyDeletion', 'kms:DisableKey', 'kms:PutKeyPolicy', 'kms:Decrypt',
        'cloudtrail:*'] },
    ...sids(staging.BusPeruStagingDeployerPolicy, ['RestauracionesSiemprePrivadas']),
  ]),
};

// ------------------------------------------------------------------ emergencia (break-glass)
export const emergencia = {
  trust: confianzaHumana('SoloElAdministradorConMfaYAlarma'),
  // Solo descifrar un parámetro de producción por SSM (p. ej. recuperar la clave de datos). Su uso dispara una alarma.
  policy: doc([
    { Sid: 'LeerUnSecretoEnEmergencia', Effect: 'Allow', Action: ['ssm:GetParameter', 'ssm:GetParameterHistory'], Resource: `arn:aws:ssm:${R}:${CUENTA}:parameter/busperu/prod/*` },
    { Sid: 'DescifrarSoloViaSsm', Effect: 'Allow', Action: 'kms:Decrypt', Resource: `arn:aws:kms:${R}:${CUENTA}:key/*`,
      Condition: { StringEquals: { 'kms:ViaService': `ssm.${R}.amazonaws.com` }, 'ForAnyValue:StringEquals': { 'kms:ResourceAliases': [ALIAS_SECRETOS, ALIAS_DATOS] } } },
    { Sid: 'NadaMas', Effect: 'Deny', NotAction: ['ssm:GetParameter', 'ssm:GetParameterHistory', 'kms:Decrypt', 'sts:GetCallerIdentity'], Resource: '*' },
  ]),
};

// ------------------------------------------------------------------ runtime (EC2)
export const app = {
  trust: doc([{ Sid: 'SoloEc2', Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }]),
  policy: doc([
    { Sid: 'SessionManager', Effect: 'Allow', Resource: '*',
      Action: ['ssm:UpdateInstanceInformation', 'ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel', 'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel'] },
    { Sid: 'SoloLosParametrosDeLaApp', Effect: 'Allow', Action: ['ssm:GetParametersByPath', 'ssm:GetParameter', 'ssm:GetParameters'],
      Resource: [`arn:aws:ssm:${R}:${CUENTA}:parameter/busperu/prod/app`, `arn:aws:ssm:${R}:${CUENTA}:parameter/busperu/prod/app/*`, MIGRADOR] },
    { Sid: 'DescifrarSoloLosDeLaApp', Effect: 'Allow', Action: 'kms:Decrypt', Resource: `arn:aws:kms:${R}:${CUENTA}:key/*`,
      Condition: { StringEquals: { 'kms:ViaService': `ssm.${R}.amazonaws.com` },
        StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': [`arn:aws:ssm:${R}:${CUENTA}:parameter/busperu/prod/app/*`, MIGRADOR] },
        'ForAnyValue:StringEquals': { 'kms:ResourceAliases': [ALIAS_SECRETOS, ALIAS_DATOS] } } },
    { Sid: 'Registros', Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'], Resource: `arn:aws:logs:${R}:${CUENTA}:log-group:/busperu/prod/*` },
    { Sid: 'Metricas', Effect: 'Allow', Action: 'cloudwatch:PutMetricData', Resource: '*', Condition: { StringEquals: { 'cloudwatch:namespace': ['CWAgent', 'BusPeru/App'] } } },
    { Sid: 'Versiones', Effect: 'Allow', Action: 's3:GetObject', Resource: `arn:aws:s3:::${P}-artifacts-*/releases/*` },
    { Sid: 'Almacenamiento', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: `arn:aws:s3:::${P}-storage-*/*` },
    { Sid: 'NadaDeControl', Effect: 'Deny', Resource: '*',
      Action: ['iam:*', 'sts:AssumeRole', 'cloudformation:*', 'ssm:PutParameter', 'ssm:DeleteParameter*', 'ssm:SendCommand', 'rds:*', 'ec2:Run*', 'ec2:Terminate*',
        'ec2:Delete*', 'kms:Encrypt', 'kms:CreateGrant', 'kms:ScheduleKeyDeletion', 'secretsmanager:*', 'cloudtrail:*'] },
  ]),
};

// ------------------------------------------------------------------ KMS
const admKms = { Sid: 'AdministrarSinUsar', Effect: 'Allow', Principal: { AWS: ADMIN }, Resource: '*', Condition: MFA,
  Action: ['kms:Describe*', 'kms:List*', 'kms:Get*', 'kms:Create*', 'kms:Enable*', 'kms:Put*', 'kms:Update*', 'kms:Revoke*', 'kms:Disable*', 'kms:TagResource',
    'kms:UntagResource', 'kms:ScheduleKeyDeletion', 'kms:CancelKeyDeletion', 'kms:RotateKeyOnDemand'] };
// F18-08 (autorizado por el propietario): sin la raíz en la política, Access Analyzer no podía LEER las claves
// (hallazgos ACCESS_DENIED). Solo su rol vinculado, solo lectura de metadatos y política: ningún uso criptográfico.
const ANALIZADOR = `arn:aws:iam::${CUENTA}:role/aws-service-role/access-analyzer.amazonaws.com/AWSServiceRoleForAccessAnalyzer`;
export const LECTURA_ANALIZADOR = ['kms:DescribeKey', 'kms:GetKeyPolicy', 'kms:ListKeyPolicies', 'kms:ListGrants'];
const lecturaAnalizador = { Sid: 'AccessAnalyzerSoloLee', Effect: 'Allow', Principal: { AWS: ANALIZADOR }, Action: LECTURA_ANALIZADOR, Resource: '*' };
// DescribeKey no admite condiciones de contexto de cifrado: va aparte (solo metadatos de la clave).
const describirOperador = { Sid: 'OperadorDescribeLaClave', Effect: 'Allow', Principal: { AWS: OPERADOR }, Action: 'kms:DescribeKey', Resource: '*' };
export const kms = {
  // Sin la declaración «cuenta raíz → kms:*»: así ninguna política IAM (ni AdministratorAccess) da Decrypt.
  secretos: doc([
    admKms,
    lecturaAnalizador,
    describirOperador,
    { Sid: 'AppDescifraSoloSusParametros', Effect: 'Allow', Principal: { AWS: APP }, Action: 'kms:Decrypt', Resource: '*',
      Condition: { StringEquals: { 'kms:ViaService': `ssm.${R}.amazonaws.com` }, StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': [`arn:aws:ssm:${R}:${CUENTA}:parameter/busperu/prod/app/*`, MIGRADOR] } } },
    { Sid: 'OperadorSoloCifra', Effect: 'Allow', Principal: { AWS: OPERADOR }, Action: ['kms:Encrypt', 'kms:GenerateDataKey'], Resource: '*',
      Condition: { StringEquals: { 'kms:ViaService': `ssm.${R}.amazonaws.com` }, StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': `arn:aws:ssm:${R}:${CUENTA}:parameter/busperu/prod/*` } } },
    { Sid: 'EmergenciaDescifraViaSsm', Effect: 'Allow', Principal: { AWS: EMERGENCIA }, Action: 'kms:Decrypt', Resource: '*',
      Condition: { StringEquals: { 'kms:ViaService': `ssm.${R}.amazonaws.com` } } },
  ]),
  datos: doc([
    admKms,
    lecturaAnalizador,
    describirOperador,
    { Sid: 'AppDescifraSoloLaClaveDeDatos', Effect: 'Allow', Principal: { AWS: APP }, Action: 'kms:Decrypt', Resource: '*',
      Condition: { StringEquals: { 'kms:ViaService': `ssm.${R}.amazonaws.com` }, StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': PARAM_DATOS } } },
    { Sid: 'OperadorSoloCifra', Effect: 'Allow', Principal: { AWS: OPERADOR }, Action: ['kms:Encrypt', 'kms:GenerateDataKey'], Resource: '*',
      Condition: { StringEquals: { 'kms:ViaService': `ssm.${R}.amazonaws.com` }, StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': PARAM_DATOS } } },
    { Sid: 'EmergenciaDescifraViaSsm', Effect: 'Allow', Principal: { AWS: EMERGENCIA }, Action: 'kms:Decrypt', Resource: '*',
      Condition: { StringEquals: { 'kms:ViaService': `ssm.${R}.amazonaws.com` } } },
  ]),
  rds: doc([
    admKms,
    lecturaAnalizador,
    { Sid: 'UsoSoloViaRds', Effect: 'Allow', Principal: { AWS: [EXEC, RECUPERACION] },
      Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'], Resource: '*',
      Condition: { StringEquals: { 'kms:ViaService': `rds.${R}.amazonaws.com`, 'kms:CallerAccount': CUENTA } } },
    { Sid: 'ConcesionesSoloParaRds', Effect: 'Allow', Principal: { AWS: [EXEC, RECUPERACION] }, Action: 'kms:CreateGrant', Resource: '*',
      Condition: { StringEquals: { 'kms:ViaService': `rds.${R}.amazonaws.com` }, Bool: { 'kms:GrantIsForAWSResource': 'true' } } },
  ]),
};

// ------------------------------------------------------------------ CloudTrail
export const trail = {
  bucketPolicy: doc([
    { Sid: 'CloudTrailLeeElAcl', Effect: 'Allow', Principal: { Service: 'cloudtrail.amazonaws.com' }, Action: 's3:GetBucketAcl', Resource: `arn:aws:s3:::${BUCKET_TRAIL}`,
      Condition: { StringEquals: { 'aws:SourceArn': TRAIL } } },
    { Sid: 'CloudTrailEscribe', Effect: 'Allow', Principal: { Service: 'cloudtrail.amazonaws.com' }, Action: 's3:PutObject',
      Resource: `arn:aws:s3:::${BUCKET_TRAIL}/AWSLogs/${CUENTA}/*`,
      Condition: { StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control', 'aws:SourceArn': TRAIL } } },
    { Sid: 'SoloTls', Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [`arn:aws:s3:::${BUCKET_TRAIL}`, `arn:aws:s3:::${BUCKET_TRAIL}/*`],
      Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
    { Sid: 'NadieBorraLaAuditoria', Effect: 'Deny', Principal: '*', Action: ['s3:DeleteObject', 's3:DeleteObjectVersion', 's3:DeleteBucket', 's3:PutBucketPolicy',
      's3:PutLifecycleConfiguration', 's3:PutBucketVersioning'], Resource: [`arn:aws:s3:::${BUCKET_TRAIL}`, `arn:aws:s3:::${BUCKET_TRAIL}/*`],
      Condition: { ArnNotEquals: { 'aws:PrincipalArn': EMERGENCIA } } },
  ]),
  // Configuración del trail (la aplica el administrador en la pila de seguridad de la cuenta, no la de la app).
  config: { Name: `${P}-trail`, S3BucketName: BUCKET_TRAIL, IsMultiRegionTrail: true, IncludeGlobalServiceEvents: true, EnableLogFileValidation: true,
    EventSelectors: [{ ReadWriteType: 'All', IncludeManagementEvents: true }], retencionDias: 400, cifradoBucket: 'SSE-S3', versionado: true, bloqueoPublico: true },
};

export const politicasProd = {
  'exec-trust': exec.trust, 'exec-barriers': exec.barreras, 'exec-core': exec.core, 'exec-compute': exec.compute, 'exec-data': exec.data,
  'operator-trust': operador.trust, 'operator-barriers': operador.barreras, 'operator-policy': operador.policy,
  'recovery-trust': recuperacion.trust, 'recovery-policy': recuperacion.policy,
  'breakglass-trust': emergencia.trust, 'breakglass-policy': emergencia.policy,
  'app-trust': app.trust, 'app-policy': app.policy,
  'kms-secrets-key-policy': kms.secretos, 'kms-data-key-policy': kms.datos, 'kms-rds-key-policy': kms.rds,
  'cloudtrail-bucket-policy': trail.bucketPolicy,
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const destino = args.out ?? fileURLToPath(new URL('./policies/', import.meta.url));
  mkdirSync(destino, { recursive: true });
  for (const [nombre, d] of Object.entries(politicasProd)) {
    writeFileSync(`${destino.replace(/[\\/]?$/, '/')}${nombre}.json`, `${JSON.stringify(d, null, 2)}\n`);
    console.log(`${nombre.padEnd(28)} ${String(JSON.stringify(d).length).padStart(5)} caracteres · ${d.Statement.length} declaraciones`);
  }
  writeFileSync(`${destino.replace(/[\\/]?$/, '/')}cloudtrail-config.json`, `${JSON.stringify(trail.config, null, 2)}\n`);
}
