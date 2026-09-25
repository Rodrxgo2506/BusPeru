// BusPerú · F18-03D · identidad de despliegue de STAGING (IAM como código).
//
//   node build-iam.mjs                      → escribe ./policies/*.json con la cuenta como {{ACCOUNT_ID}}
//   node build-iam.mjs --account <12 dígitos> --out <dir>   → versión aplicable (fuera del repositorio)
//
// Modelo:
//   usuario IAM administrador ──sts:AssumeRole──▶ rol BusPeruStagingDeployer ──▶ CloudFormation (pila busperu-staging)
//
// Los permisos salen de los handlers del registro de CloudFormation para los 29 tipos de recurso de
// busperu-staging.json (`aws cloudformation describe-type`), recortados a lo que usa la plantilla:
//   · lecturas (Describe/Get/List) que invocan los handlers: se conceden, acotadas;
//   · escrituras: solo las de las propiedades que la plantilla usa de verdad.
// KMS casi nulo: las claves gestionadas por AWS (aws/rds, aws/ebs, aws/ssm) ya autorizan en su propia
// política a cualquier principal de la cuenta a través de su servicio (comprobado en F18-03D). La única
// excepción es kms:DescribeKey vía RDS, que RDS necesita para aws/secretsmanager (F18-04).
//
// Tres barreras además del alcance por recurso:
//   1. Límite de permisos obligatorio en todo rol que cree el despliegue (sin él, poder crear roles y
//      escribirles políticas equivaldría a poder darse cualquier permiso).
//   2. Denegaciones explícitas: VPC por defecto, administración de usuarios/grupos/claves, la propia
//      identidad de despliegue, secretos y cualquier región distinta de sa-east-1.
//   3. Las escrituras sobre recursos EC2 existentes exigen la etiqueta que CloudFormation pone y nadie
//      más puede poner (`aws:cloudformation:stack-name`): el rol no puede tocar lo que no creó la pila.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const CUENTA = args.account ?? '{{ACCOUNT_ID}}';
if (args.account && !/^\d{12}$/.test(args.account)) throw new Error('--account debe tener 12 dígitos');
const R = 'sa-east-1';
const PILA = 'busperu-staging';
const PREFIJO = 'busperu-staging';
const USUARIO_CONFIABLE = `arn:aws:iam::${CUENTA}:user/Rodrigo`;
const VPC_POR_DEFECTO = 'vpc-00b4bcdf074ad434b';
const LIMITE = `arn:aws:iam::${CUENTA}:policy/busperu/BusPeruStagingWorkloadBoundary`;
const DLM_GESTIONADA = 'arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole';
const ec2 = (tipo) => `arn:aws:ec2:${R}:${CUENTA}:${tipo}/*`;
const deLaPila = { StringEquals: { 'aws:ResourceTag/aws:cloudformation:stack-name': PILA } };
const region = { StringEquals: { 'aws:RequestedRegion': R } };

// ------------------------------------------------------------------ confianza
// F18-07B (aplicada el 2026-09-24) · la documentada en HARDENING-F18-07A.md §6: solo el usuario administrador,
// con MFA y autenticada hace menos de una hora. Los roles de servicio (EC2, DLM) no se tocan: no pasan por aquí.
export const trust = {
  Version: '2012-10-17',
  Statement: [{
    Sid: 'SoloElUsuarioAdministradorConMfa',
    Effect: 'Allow',
    Principal: { AWS: USUARIO_CONFIABLE },
    Action: 'sts:AssumeRole',
    Condition: { Bool: { 'aws:MultiFactorAuthPresent': 'true' }, NumericLessThan: { 'aws:MultiFactorAuthAge': '3600' } },
  }],
};

// ------------------------------------------------------------------ 1 · núcleo
export const core = {
  Version: '2012-10-17',
  Statement: [
    // ---- barreras (Deny explícito: prevalece sobre cualquier Allow)
    { Sid: 'SoloSaoPaulo', Effect: 'Deny', NotAction: ['iam:*', 'sts:*', 'cloudfront:*', 'route53:*', 'support:*', 'health:*'], Resource: '*',
      Condition: { StringNotEquals: { 'aws:RequestedRegion': R } } },
    { Sid: 'NadaSobreLaVpcPorDefecto', Effect: 'Deny', NotAction: ['ec2:Describe*', 'ec2:Get*'], Resource: '*',
      Condition: { StringEquals: { 'ec2:Vpc': `arn:aws:ec2:${R}:${CUENTA}:vpc/${VPC_POR_DEFECTO}` } } },
    { Sid: 'NiLaVpcPorDefectoEnSi', Effect: 'Deny', NotAction: ['ec2:Describe*', 'ec2:Get*'], Resource: `arn:aws:ec2:${R}:${CUENTA}:vpc/${VPC_POR_DEFECTO}` },
    { Sid: 'SinAdministrarPersonasNiCredenciales', Effect: 'Deny',
      Action: ['iam:*User*', 'iam:*Group*', 'iam:*AccessKey*', 'iam:*LoginProfile*', 'iam:*MFADevice*', 'iam:*SSHPublicKey*', 'iam:*ServiceSpecificCredential*',
        'iam:*SigningCertificate*', 'iam:*AccountAlias*', 'iam:*PasswordPolicy*', 'iam:*SAMLProvider*', 'iam:*OpenIDConnectProvider*',
        'iam:CreatePolicy*', 'iam:DeletePolicy*', 'iam:SetDefaultPolicyVersion', 'iam:PutRolePermissionsBoundary', 'iam:DeleteRolePermissionsBoundary',
        'iam:UpdateAssumeRolePolicy', 'organizations:*', 'account:*'],
      Resource: '*' },
    { Sid: 'IntocableLaIdentidadDeDespliegue', Effect: 'Deny', Action: 'iam:*',
      Resource: [`arn:aws:iam::${CUENTA}:role/busperu/*`, `arn:aws:iam::${CUENTA}:policy/busperu/*`] },
    { Sid: 'NingunSecretoEnClaro', Effect: 'Deny', Action: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue', 'secretsmanager:UpdateSecret', 'secretsmanager:RestoreSecret'], Resource: '*' },
    // F18-07 · protección de la base de datos original y de sus copias. Sin condiciones a propósito:
    // `aws:CalledVia` no garantiza que CloudFormation llame a RDS por FAS, así que estas barreras
    // aplican TAMBIÉN a CloudFormation con las credenciales del rol. Consecuencia buscada: ni un
    // `delete-db-instance` directo ni un borrado o reemplazo de la pila pueden destruir la base;
    // hace falta un administrador. `ModifyDBInstance` y `RebootDBInstance` siguen permitidos porque
    // las actualizaciones de la pila los necesitan y RDS no ofrece claves de condición para
    // distinguir un cambio peligroso (solo `rds:ManageMasterUserPassword`): riesgo residual
    // documentado, que en producción se cierra con un rol de servicio de CloudFormation.
    { Sid: 'NoBorrarLaBaseOriginal', Effect: 'Deny', Action: 'rds:DeleteDBInstance', Resource: `arn:aws:rds:${R}:${CUENTA}:db:${PREFIJO}-db` },
    { Sid: 'NoBorrarNiCompartirCopias', Effect: 'Deny',
      Action: ['rds:DeleteDBSnapshot', 'rds:ModifyDBSnapshotAttribute', 'rds:DeleteDBInstanceAutomatedBackup', 'rds:StartExportTask'], Resource: '*' },
    { Sid: 'RestauracionesSiemprePrivadas', Effect: 'Deny', Action: ['rds:RestoreDBInstanceToPointInTime', 'rds:RestoreDBInstanceFromDBSnapshot'], Resource: '*',
      Condition: { Bool: { 'rds:PubliclyAccessible': 'true' } } },
    // F18-07B · borrar un parámetro se lleva también su historial: sin la clave de cifrado, los datos
    // bancarios y las integraciones quedan ilegibles para siempre. Sobrescribir (PutParameter) sigue
    // permitido porque deja historial y lo necesita la rotación; `…_PREVIOUS` no se protege porque la
    // rotación la retira al terminar.
    { Sid: 'NoBorrarSecretosCriticos', Effect: 'Deny', Action: ['ssm:DeleteParameter', 'ssm:DeleteParameters'],
      Resource: [`arn:aws:ssm:${R}:${CUENTA}:parameter/busperu/*/app/INTEGRATIONS_ENCRYPTION_KEY`, `arn:aws:ssm:${R}:${CUENTA}:parameter/busperu/*/app/JWT_SECRET`] },

    // ---- CloudFormation: solo la pila de staging
    { Sid: 'PilaDeStaging', Effect: 'Allow',
      Action: ['cloudformation:CreateStack', 'cloudformation:UpdateStack', 'cloudformation:DeleteStack', 'cloudformation:DescribeStacks', 'cloudformation:DescribeStackEvents',
        'cloudformation:DescribeStackResource', 'cloudformation:DescribeStackResources', 'cloudformation:ListStackResources', 'cloudformation:GetTemplate',
        'cloudformation:CreateChangeSet', 'cloudformation:DescribeChangeSet', 'cloudformation:ExecuteChangeSet', 'cloudformation:DeleteChangeSet',
        'cloudformation:ListChangeSets', 'cloudformation:CancelUpdateStack', 'cloudformation:ContinueUpdateRollback', 'cloudformation:TagResource',
        'cloudformation:UntagResource', 'cloudformation:DetectStackDrift', 'cloudformation:DescribeStackResourceDrifts'],
      Resource: [`arn:aws:cloudformation:${R}:${CUENTA}:stack/${PILA}/*`, `arn:aws:cloudformation:${R}:${CUENTA}:changeSet/*/*`] },
    // Sin recurso a nivel de ARN en la API: validar plantillas y listar pilas.
    { Sid: 'CloudFormationSinRecurso', Effect: 'Allow', Action: ['cloudformation:ValidateTemplate', 'cloudformation:GetTemplateSummary', 'cloudformation:ListStacks', 'cloudformation:DescribeType', 'cloudformation:DescribeStackDriftDetectionStatus'], Resource: '*', Condition: region },

    // ---- IAM de la carga: roles y perfil de instancia de la pila, SIEMPRE con el límite
    { Sid: 'CrearRolesSoloConLimite', Effect: 'Allow', Action: ['iam:CreateRole', 'iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:DetachRolePolicy'],
      Resource: `arn:aws:iam::${CUENTA}:role/${PREFIJO}-*`, Condition: { StringEquals: { 'iam:PermissionsBoundary': LIMITE } } },
    { Sid: 'SoloLaPoliticaGestionadaDeDlm', Effect: 'Allow', Action: 'iam:AttachRolePolicy', Resource: `arn:aws:iam::${CUENTA}:role/${PREFIJO}-*`,
      Condition: { StringEquals: { 'iam:PermissionsBoundary': LIMITE }, ArnEquals: { 'iam:PolicyARN': DLM_GESTIONADA } } },
    { Sid: 'GestionarRolesDeLaPila', Effect: 'Allow',
      Action: ['iam:GetRole', 'iam:GetRolePolicy', 'iam:ListAttachedRolePolicies', 'iam:ListRolePolicies', 'iam:ListInstanceProfilesForRole', 'iam:TagRole', 'iam:UntagRole',
        'iam:UpdateRole', 'iam:UpdateRoleDescription', 'iam:DeleteRole'],
      Resource: `arn:aws:iam::${CUENTA}:role/${PREFIJO}-*` },
    { Sid: 'PerfilDeInstanciaDeLaPila', Effect: 'Allow',
      Action: ['iam:CreateInstanceProfile', 'iam:DeleteInstanceProfile', 'iam:GetInstanceProfile', 'iam:AddRoleToInstanceProfile', 'iam:RemoveRoleFromInstanceProfile',
        'iam:TagInstanceProfile', 'iam:UntagInstanceProfile'],
      Resource: `arn:aws:iam::${CUENTA}:instance-profile/${PREFIJO}-*` },
    // ListRoles y ListInstanceProfiles no admiten recurso (referencia de autorización de AWS).
    { Sid: 'ListarRolesYPerfiles', Effect: 'Allow', Action: ['iam:ListRoles', 'iam:ListInstanceProfiles'], Resource: '*' },
    { Sid: 'PasarRolDeLaAppSoloAEc2', Effect: 'Allow', Action: 'iam:PassRole', Resource: `arn:aws:iam::${CUENTA}:role/${PREFIJO}-app-role`,
      Condition: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } } },
    { Sid: 'PasarRolDeDlmSoloADlm', Effect: 'Allow', Action: 'iam:PassRole', Resource: `arn:aws:iam::${CUENTA}:role/${PREFIJO}-DlmRole-*`,
      Condition: { StringEquals: { 'iam:PassedToService': 'dlm.amazonaws.com' } } },
    // Primera vez que se usan ELB y RDS en la cuenta: crean su rol vinculado al servicio.
    { Sid: 'RolesVinculadosDeElbYRds', Effect: 'Allow', Action: 'iam:CreateServiceLinkedRole', Resource: `arn:aws:iam::${CUENTA}:role/aws-service-role/*`,
      Condition: { StringEquals: { 'iam:AWSServiceName': ['elasticloadbalancing.amazonaws.com', 'rds.amazonaws.com'] } } },

    // ---- Parameter Store: solo /busperu/staging, más el parámetro PÚBLICO de la AMI
    { Sid: 'ParametrosDeStaging', Effect: 'Allow',
      Action: ['ssm:PutParameter', 'ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath', 'ssm:GetParameterHistory', 'ssm:DeleteParameter', 'ssm:DeleteParameters',
        'ssm:AddTagsToResource', 'ssm:RemoveTagsFromResource', 'ssm:ListTagsForResource'],
      Resource: [`arn:aws:ssm:${R}:${CUENTA}:parameter/busperu/staging`, `arn:aws:ssm:${R}:${CUENTA}:parameter/busperu/staging/*`] },
    { Sid: 'AmiPublicaDeAmazonLinux', Effect: 'Allow', Action: ['ssm:GetParameters', 'ssm:GetParameter'], Resource: `arn:aws:ssm:${R}::parameter/aws/service/ami-amazon-linux-latest/*` },
    // DescribeParameters no admite recurso; solo devuelve nombres y metadatos, nunca valores.
    { Sid: 'ListarParametros', Effect: 'Allow', Action: 'ssm:DescribeParameters', Resource: '*', Condition: region },
    // Operación: Session Manager solo contra instancias de la pila.
    { Sid: 'SesionEnLaInstanciaDeLaPila', Effect: 'Allow', Action: 'ssm:StartSession', Resource: ec2('instance'),
      Condition: { StringEquals: { 'ssm:resourceTag/aws:cloudformation:stack-name': PILA } } },
    { Sid: 'DocumentoDeSesion', Effect: 'Allow', Action: 'ssm:StartSession', Resource: `arn:aws:ssm:${R}:${CUENTA}:document/SSM-SessionManagerRunShell` },
    { Sid: 'SusPropiasSesiones', Effect: 'Allow', Action: ['ssm:TerminateSession', 'ssm:ResumeSession'], Resource: `arn:aws:ssm:${R}:${CUENTA}:session/\${aws:userid}-*` },
    { Sid: 'EstadoDeSesiones', Effect: 'Allow', Action: ['ssm:DescribeInstanceInformation', 'ssm:DescribeSessions', 'ssm:GetConnectionStatus'], Resource: '*', Condition: region },
    // F18-04 · Run Command para configurar la instancia (bootstrap, usuarios de BD, migraciones).
    // SendCommand exige permiso sobre el documento Y sobre la instancia: solo AWS-RunShellScript y
    // solo instancias creadas por la pila. En la instancia no hace falta nada nuevo: desde SSM Agent
    // 3.3.40.0, Run Command usa el canal ssmmessages, que el rol de la instancia ya tiene.
    { Sid: 'ComandosSoloEnLaInstanciaDeLaPila', Effect: 'Allow', Action: 'ssm:SendCommand', Resource: ec2('instance'),
      Condition: { StringEquals: { 'ssm:resourceTag/aws:cloudformation:stack-name': PILA } } },
    { Sid: 'SoloElDocumentoRunShellScript', Effect: 'Allow', Action: 'ssm:SendCommand', Resource: `arn:aws:ssm:${R}::document/AWS-RunShellScript` },
    { Sid: 'ResultadosDeComandos', Effect: 'Allow', Action: ['ssm:GetCommandInvocation', 'ssm:ListCommandInvocations', 'ssm:ListCommands', 'ssm:CancelCommand'], Resource: '*', Condition: region },

    // ---- Secrets Manager: solo el secreto maestro que crea RDS (nombres "rds!db-…")
    { Sid: 'SecretoMaestroQueCreaRds', Effect: 'Allow', Action: ['secretsmanager:CreateSecret', 'secretsmanager:TagResource', 'secretsmanager:DescribeSecret'],
      Resource: `arn:aws:secretsmanager:${R}:${CUENTA}:secret:rds!db-*` },
    // F18-04 · ManageMasterUserPassword: RDS describe aws/secretsmanager con las credenciales de quien crea la
    // instancia (guía de RDS, «Permissions required for Secrets Manager integration»). Solo metadatos y solo vía RDS.
    { Sid: 'DescribirClaveDelSecretoMaestro', Effect: 'Allow', Action: 'kms:DescribeKey', Resource: `arn:aws:kms:${R}:${CUENTA}:key/*`,
      Condition: { StringEquals: { 'kms:ViaService': `rds.${R}.amazonaws.com` } } },
  ],
};

// ------------------------------------------------------------------ 2 · cómputo (EC2 + ELB)
const CREAR_EC2 = ['ec2:CreateInternetGateway', 'ec2:CreateSubnet', 'ec2:CreateRouteTable', 'ec2:CreateSecurityGroup', 'ec2:CreateVolume', 'ec2:CreateLaunchTemplate'];
export const compute = {
  Version: '2012-10-17',
  Statement: [
    // Describe* no admite recurso a nivel de ARN en EC2.
    { Sid: 'Ec2Lectura', Effect: 'Allow', Action: ['ec2:Describe*', 'ec2:GetLaunchTemplateData'], Resource: '*', Condition: region },
    // F18-04 · ELB la invoca con las credenciales de quien crea el ALB (no figura en el handler de
    // CloudFormation, sí en la política oficial de ELB). Solo lectura y solo sobre la VPC de la pila.
    { Sid: 'GruposDeLaVpcParaElAlb', Effect: 'Allow', Action: 'ec2:GetSecurityGroupsForVpc', Resource: ec2('vpc'), Condition: deLaPila },
    // Recursos NUEVOS: su ARN no existe antes de crearlos, así que no puede llevar etiqueta. Cada
    // acción aparece solo con el tipo que crea; el recurso "padre" (la VPC) cae en Ec2DeLaPila.
    { Sid: 'CrearVpc', Effect: 'Allow', Action: 'ec2:CreateVpc', Resource: ec2('vpc') },
    { Sid: 'CrearRecursosNuevos', Effect: 'Allow', Action: CREAR_EC2,
      Resource: [ec2('internet-gateway'), ec2('subnet'), ec2('route-table'), ec2('security-group'), ec2('volume'), ec2('launch-template')] },
    { Sid: 'ReglasNuevasDeSg', Effect: 'Allow', Action: ['ec2:AuthorizeSecurityGroupIngress', 'ec2:AuthorizeSecurityGroupEgress'], Resource: ec2('security-group-rule') },
    { Sid: 'EtiquetarAlCrear', Effect: 'Allow', Action: 'ec2:CreateTags', Resource: '*',
      Condition: { StringEquals: { 'ec2:CreateAction': ['CreateVpc', ...CREAR_EC2.map((a) => a.slice(4)), 'RunInstances'] } } },
    // RunInstances: instancia, disco y ENI nuevos; AMI solo de Amazon; subred, SG y plantilla de la pila.
    { Sid: 'LanzarNuevos', Effect: 'Allow', Action: 'ec2:RunInstances', Resource: [ec2('instance'), ec2('volume'), ec2('network-interface')] },
    { Sid: 'LanzarSoloAmiDeAmazon', Effect: 'Allow', Action: 'ec2:RunInstances', Resource: `arn:aws:ec2:${R}::image/*`, Condition: { StringEquals: { 'ec2:Owner': 'amazon' } } },
    // Escrituras sobre lo que YA existe: solo si lo creó esta pila (etiqueta reservada a CloudFormation).
    { Sid: 'Ec2DeLaPila', Effect: 'Allow',
      Action: ['ec2:RunInstances', ...CREAR_EC2, 'ec2:DeleteVpc', 'ec2:ModifyVpcAttribute', 'ec2:DeleteSubnet', 'ec2:ModifySubnetAttribute', 'ec2:AttachInternetGateway',
        'ec2:DetachInternetGateway', 'ec2:DeleteInternetGateway', 'ec2:DeleteRouteTable', 'ec2:CreateRoute', 'ec2:ReplaceRoute', 'ec2:DeleteRoute', 'ec2:AssociateRouteTable',
        'ec2:DisassociateRouteTable', 'ec2:ReplaceRouteTableAssociation', 'ec2:DeleteSecurityGroup', 'ec2:AuthorizeSecurityGroupIngress', 'ec2:AuthorizeSecurityGroupEgress',
        'ec2:RevokeSecurityGroupIngress', 'ec2:RevokeSecurityGroupEgress', 'ec2:UpdateSecurityGroupRuleDescriptionsIngress', 'ec2:UpdateSecurityGroupRuleDescriptionsEgress',
        'ec2:DeleteLaunchTemplate', 'ec2:CreateLaunchTemplateVersion', 'ec2:DeleteLaunchTemplateVersions', 'ec2:ModifyLaunchTemplate', 'ec2:TerminateInstances',
        'ec2:StartInstances', 'ec2:StopInstances', 'ec2:RebootInstances', 'ec2:ModifyInstanceAttribute', 'ec2:ModifyInstanceMetadataOptions', 'ec2:MonitorInstances',
        'ec2:UnmonitorInstances', 'ec2:AssociateIamInstanceProfile', 'ec2:DisassociateIamInstanceProfile', 'ec2:ReplaceIamInstanceProfileAssociation',
        'ec2:DeleteVolume', 'ec2:AttachVolume', 'ec2:DetachVolume', 'ec2:ModifyVolume', 'ec2:ModifyVolumeAttribute', 'ec2:CreateSnapshot', 'ec2:CreateTags', 'ec2:DeleteTags'],
      Resource: `arn:aws:ec2:${R}:${CUENTA}:*/*`, Condition: deLaPila },
    // La plantilla de lanzamiento se etiqueta en la propia plantilla (TagSpecifications) porque no hay
    // garantía de que CloudFormation le añada aws:cloudformation:stack-name. El rol no puede poner
    // esas etiquetas a recursos ajenos: solo etiqueta al crear o sobre recursos de la pila.
    { Sid: 'PlantillaDeLanzamientoDeLaPila', Effect: 'Allow',
      Action: ['ec2:RunInstances', 'ec2:DeleteLaunchTemplate', 'ec2:CreateLaunchTemplateVersion', 'ec2:DeleteLaunchTemplateVersions', 'ec2:ModifyLaunchTemplate', 'ec2:CreateTags', 'ec2:DeleteTags'],
      Resource: ec2('launch-template'), Condition: { StringEquals: { 'aws:ResourceTag/Project': 'busperu', 'aws:ResourceTag/Environment': 'staging' } } },
    // Snapshots del volumen (antes de operaciones delicadas y en el restore): se crean sin etiqueta previa.
    { Sid: 'SnapshotsNuevos', Effect: 'Allow', Action: 'ec2:CreateSnapshot', Resource: `arn:aws:ec2:${R}::snapshot/*` },

    // ---- ALB: nombres fijos de la plantilla
    { Sid: 'ElbLectura', Effect: 'Allow', Action: 'elasticloadbalancing:Describe*', Resource: '*', Condition: region },
    { Sid: 'ElbDeLaPila', Effect: 'Allow',
      Action: ['elasticloadbalancing:CreateLoadBalancer', 'elasticloadbalancing:DeleteLoadBalancer', 'elasticloadbalancing:ModifyLoadBalancerAttributes',
        'elasticloadbalancing:SetSecurityGroups', 'elasticloadbalancing:SetSubnets', 'elasticloadbalancing:CreateTargetGroup', 'elasticloadbalancing:DeleteTargetGroup',
        'elasticloadbalancing:ModifyTargetGroup', 'elasticloadbalancing:ModifyTargetGroupAttributes', 'elasticloadbalancing:RegisterTargets',
        'elasticloadbalancing:DeregisterTargets', 'elasticloadbalancing:CreateListener', 'elasticloadbalancing:DeleteListener', 'elasticloadbalancing:ModifyListener',
        'elasticloadbalancing:ModifyListenerAttributes', 'elasticloadbalancing:AddTags', 'elasticloadbalancing:RemoveTags'],
      Resource: [`arn:aws:elasticloadbalancing:${R}:${CUENTA}:loadbalancer/app/${PREFIJO}-alb/*`, `arn:aws:elasticloadbalancing:${R}:${CUENTA}:targetgroup/${PREFIJO}-api/*`,
        `arn:aws:elasticloadbalancing:${R}:${CUENTA}:listener/app/${PREFIJO}-alb/*`, `arn:aws:elasticloadbalancing:${R}:${CUENTA}:listener-rule/app/${PREFIJO}-alb/*`] },
  ],
};

// ------------------------------------------------------------------ 3 · datos (RDS, S3, logs, alarmas, SNS, DLM)
const rds = (tipo) => `arn:aws:rds:${R}:${CUENTA}:${tipo}:${PREFIJO}-*`;
const BUCKET = `arn:aws:s3:::${PREFIJO}-artifacts-*`;
export const data = {
  Version: '2012-10-17',
  Statement: [
    { Sid: 'RdsLectura', Effect: 'Allow', Action: ['rds:Describe*', 'rds:ListTagsForResource'], Resource: '*', Condition: region },
    { Sid: 'RdsDeLaPila', Effect: 'Allow',
      Action: ['rds:CreateDBInstance', 'rds:ModifyDBInstance', 'rds:DeleteDBInstance', 'rds:RebootDBInstance', 'rds:CreateDBSnapshot', 'rds:DeleteDBSnapshot',
        'rds:RestoreDBInstanceToPointInTime', 'rds:RestoreDBInstanceFromDBSnapshot', 'rds:CreateDBSubnetGroup', 'rds:ModifyDBSubnetGroup', 'rds:DeleteDBSubnetGroup',
        'rds:CreateDBParameterGroup', 'rds:ModifyDBParameterGroup', 'rds:ResetDBParameterGroup', 'rds:DeleteDBParameterGroup', 'rds:AddTagsToResource', 'rds:RemoveTagsFromResource'],
      Resource: [rds('db'), rds('subgrp'), rds('pg'), rds('snapshot'), `arn:aws:rds:${R}:${CUENTA}:og:default:mariadb-10-11`] },

    { Sid: 'BucketDeArtefactos', Effect: 'Allow',
      Action: ['s3:CreateBucket', 's3:DeleteBucket', 's3:ListBucket', 's3:ListBucketVersions', 's3:GetBucket*', 's3:PutBucketPublicAccessBlock', 's3:PutBucketOwnershipControls',
        's3:PutBucketVersioning', 's3:PutBucketTagging', 's3:PutBucketPolicy', 's3:DeleteBucketPolicy', 's3:GetEncryptionConfiguration', 's3:PutEncryptionConfiguration',
        's3:GetLifecycleConfiguration', 's3:PutLifecycleConfiguration', 's3:GetAccelerateConfiguration', 's3:GetReplicationConfiguration', 's3:GetAnalyticsConfiguration',
        's3:GetInventoryConfiguration', 's3:GetMetricsConfiguration', 's3:GetIntelligentTieringConfiguration', 's3:ListTagsForResource'],
      Resource: BUCKET },
    { Sid: 'VersionesEnElBucket', Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject', 's3:GetObjectVersion', 's3:DeleteObject', 's3:DeleteObjectVersion'], Resource: `${BUCKET}/*` },
    // ListAllMyBuckets no admite recurso: devuelve solo nombres.
    { Sid: 'ListarBuckets', Effect: 'Allow', Action: 's3:ListAllMyBuckets', Resource: '*' },

    { Sid: 'LogsDeStaging', Effect: 'Allow',
      Action: ['logs:CreateLogGroup', 'logs:DeleteLogGroup', 'logs:PutRetentionPolicy', 'logs:DeleteRetentionPolicy', 'logs:TagResource', 'logs:UntagResource', 'logs:TagLogGroup',
        'logs:ListTagsForResource', 'logs:ListTagsLogGroup', 'logs:DescribeLogStreams', 'logs:GetLogEvents', 'logs:FilterLogEvents'],
      Resource: `arn:aws:logs:${R}:${CUENTA}:log-group:/busperu/staging/*` },
    { Sid: 'LogsLectura', Effect: 'Allow', Action: 'logs:DescribeLogGroups', Resource: '*', Condition: region },

    { Sid: 'AlarmasDeStaging', Effect: 'Allow', Action: ['cloudwatch:PutMetricAlarm', 'cloudwatch:DeleteAlarms', 'cloudwatch:TagResource', 'cloudwatch:UntagResource', 'cloudwatch:ListTagsForResource'],
      Resource: `arn:aws:cloudwatch:${R}:${CUENTA}:alarm:${PREFIJO}-*` },
    { Sid: 'MetricasLectura', Effect: 'Allow', Action: ['cloudwatch:DescribeAlarms', 'cloudwatch:GetMetricData', 'cloudwatch:ListMetrics'], Resource: '*', Condition: region },

    { Sid: 'TemaDeAlarmas', Effect: 'Allow',
      Action: ['sns:CreateTopic', 'sns:DeleteTopic', 'sns:GetTopicAttributes', 'sns:SetTopicAttributes', 'sns:TagResource', 'sns:UntagResource', 'sns:ListTagsForResource',
        'sns:Subscribe', 'sns:Unsubscribe', 'sns:ListSubscriptionsByTopic', 'sns:GetSubscriptionAttributes', 'sns:SetSubscriptionAttributes'],
      // El patrón del tema cubre también sus suscripciones (…:tema:id).
      Resource: `arn:aws:sns:${R}:${CUENTA}:${PREFIJO}-*` },
    { Sid: 'SnsListar', Effect: 'Allow', Action: ['sns:ListTopics', 'sns:ListSubscriptions'], Resource: '*', Condition: region },

    // dlm:CreateLifecyclePolicy no admite ARN (referencia de autorización de AWS), pero sí
    // aws:RequestTag: solo se crean políticas que llegan con las etiquetas del proyecto.
    { Sid: 'CrearPoliticaDeSnapshots', Effect: 'Allow', Action: ['dlm:CreateLifecyclePolicy', 'dlm:TagResource'], Resource: '*',
      Condition: { StringEquals: { 'aws:RequestTag/Project': 'busperu', 'aws:RequestTag/Environment': 'staging', 'aws:RequestedRegion': R } } },
    { Sid: 'OperarPoliticaDeSnapshots', Effect: 'Allow',
      Action: ['dlm:GetLifecyclePolicy', 'dlm:UpdateLifecyclePolicy', 'dlm:DeleteLifecyclePolicy', 'dlm:TagResource', 'dlm:UntagResource', 'dlm:ListTagsForResource'],
      Resource: `arn:aws:dlm:${R}:${CUENTA}:policy/*`, Condition: { StringEquals: { 'aws:ResourceTag/Project': 'busperu', 'aws:ResourceTag/Environment': 'staging' } } },
    { Sid: 'DlmListar', Effect: 'Allow', Action: 'dlm:GetLifecyclePolicies', Resource: '*', Condition: region },
  ],
};

// ------------------------------------------------------------------ límite de los roles de la carga
// Máximo que puede llegar a tener CUALQUIER rol que cree la pila: la unión del rol de la aplicación
// (F18-03B) y de la política gestionada del rol de DLM (contenido oficial, leído en F18-03D).
export const boundary = {
  Version: '2012-10-17',
  Statement: [
    { Sid: 'SessionManager', Effect: 'Allow', Action: ['ssm:UpdateInstanceInformation', 'ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel', 'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel'], Resource: '*' },
    { Sid: 'Parametros', Effect: 'Allow', Action: ['ssm:GetParametersByPath', 'ssm:GetParameter', 'ssm:GetParameters'], Resource: [`arn:aws:ssm:${R}:${CUENTA}:parameter/busperu/staging`, `arn:aws:ssm:${R}:${CUENTA}:parameter/busperu/staging/*`] },
    { Sid: 'Descifrar', Effect: 'Allow', Action: 'kms:Decrypt', Resource: '*',
      Condition: { StringEquals: { 'kms:ViaService': `ssm.${R}.amazonaws.com` }, StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': `arn:aws:ssm:${R}:${CUENTA}:parameter/busperu/staging/*` } } },
    { Sid: 'Logs', Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'], Resource: `arn:aws:logs:${R}:${CUENTA}:log-group:/busperu/staging/*` },
    { Sid: 'Metricas', Effect: 'Allow', Action: 'cloudwatch:PutMetricData', Resource: '*', Condition: { StringEquals: { 'cloudwatch:namespace': 'CWAgent' } } },
    { Sid: 'Artefactos', Effect: 'Allow', Action: ['s3:GetObject', 's3:ListBucket'], Resource: BUCKET }, // el patrón cubre el bucket y sus objetos
    { Sid: 'SecretoMaestro', Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: `arn:aws:secretsmanager:${R}:${CUENTA}:secret:rds!db-*` },
    // Copia literal de arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole.
    { Sid: 'DlmServicio', Effect: 'Allow',
      Action: ['ec2:CreateSnapshot', 'ec2:CreateSnapshots', 'ec2:DeleteSnapshot', 'ec2:DescribeInstances', 'ec2:DescribeVolumes', 'ec2:DescribeSnapshots', 'ec2:EnableFastSnapshotRestores',
        'ec2:DescribeFastSnapshotRestores', 'ec2:DisableFastSnapshotRestores', 'ec2:CopySnapshot', 'ec2:ModifySnapshotAttribute', 'ec2:DescribeSnapshotAttribute',
        'ec2:DescribeSnapshotTierStatus', 'ec2:ModifySnapshotTier', 'ec2:DescribeAvailabilityZones'],
      Resource: '*' },
    { Sid: 'DlmEtiquetas', Effect: 'Allow', Action: 'ec2:CreateTags', Resource: 'arn:aws:ec2:*::snapshot/*' },
    { Sid: 'DlmReglas', Effect: 'Allow',
      Action: ['events:PutRule', 'events:DeleteRule', 'events:DescribeRule', 'events:EnableRule', 'events:DisableRule', 'events:ListTargetsByRule', 'events:PutTargets', 'events:RemoveTargets'],
      Resource: 'arn:aws:events:*:*:rule/AwsDataLifecycleRule.managed-cwe.*' },
  ],
};

// Por qué cada Resource "*" no puede estrecharse (lo exige el comprobador).
export const JUSTIFICACION_COMODIN = {
  SoloSaoPaulo: 'Deny: debe aplicar a todo para cerrar las demás regiones',
  NadaSobreLaVpcPorDefecto: 'Deny: la condición ec2:Vpc selecciona los recursos de la VPC por defecto',
  SinAdministrarPersonasNiCredenciales: 'Deny: aplica a cualquier usuario, grupo o credencial de la cuenta',
  NingunSecretoEnClaro: 'Deny: ningún secreto de la cuenta, sin excepción',
  ListarRolesYPerfiles: 'iam:ListRoles e iam:ListInstanceProfiles no admiten ARN; solo listan nombres',
  CloudFormationSinRecurso: 'ValidateTemplate, GetTemplateSummary, ListStacks, DescribeType y DescribeStackDriftDetectionStatus no admiten ARN',
  ListarParametros: 'ssm:DescribeParameters no admite ARN; devuelve metadatos, nunca valores',
  EstadoDeSesiones: 'DescribeInstanceInformation, DescribeSessions y GetConnectionStatus no admiten ARN',
  ResultadosDeComandos: 'GetCommandInvocation, ListCommandInvocations, ListCommands y CancelCommand no admiten ARN (referencia de autorización de AWS)',
  Ec2Lectura: 'ec2:Describe* no admite ARN',
  EtiquetarAlCrear: 'solo en el mismo acto de creación (ec2:CreateAction); el ARN aún no existe',
  ElbLectura: 'elasticloadbalancing:Describe* no admite ARN',
  RdsLectura: 'rds:Describe* de listado no admite ARN',
  ListarBuckets: 's3:ListAllMyBuckets no admite ARN',
  LogsLectura: 'logs:DescribeLogGroups no admite ARN de un grupo concreto',
  MetricasLectura: 'DescribeAlarms (listado), GetMetricData y ListMetrics no admiten ARN',
  SnsListar: 'ListTopics y ListSubscriptions no admiten ARN',
  DlmListar: 'dlm:GetLifecyclePolicies no admite ARN',
  CrearPoliticaDeSnapshots: 'dlm:CreateLifecyclePolicy no admite ARN; se exige aws:RequestTag Project/Environment',
  SessionManager: 'acciones de Session Manager sin ARN (mínimo documentado por AWS)',
  Descifrar: 'clave gestionada por AWS; se acota por servicio y por PARAMETER_ARN',
  Metricas: 'PutMetricData no admite ARN; se acota al espacio de nombres CWAgent',
  DlmServicio: 'copia literal de la política gestionada de DLM',
};

// IAM limita cada política gestionada a 6 144 caracteres: las declaraciones de operación
// (Parameter Store, Session Manager y el secreto que crea RDS) van en una cuarta política.
const DE_OPERACION = new Set(['ParametrosDeStaging', 'AmiPublicaDeAmazonLinux', 'ListarParametros', 'SesionEnLaInstanciaDeLaPila',
  'DocumentoDeSesion', 'SusPropiasSesiones', 'EstadoDeSesiones', 'SecretoMaestroQueCreaRds', 'DescribirClaveDelSecretoMaestro',
  'ComandosSoloEnLaInstanciaDeLaPila', 'SoloElDocumentoRunShellScript', 'ResultadosDeComandos']);
export const operate = { Version: '2012-10-17', Statement: core.Statement.filter((s) => DE_OPERACION.has(s.Sid)) };
core.Statement = core.Statement.filter((s) => !DE_OPERACION.has(s.Sid));

export const politicas = {
  'trust-policy': trust,
  'BusPeruStagingDeployerPolicy': core,
  'BusPeruStagingDeployerPolicy-Compute': compute,
  'BusPeruStagingDeployerPolicy-Data': data,
  'BusPeruStagingDeployerPolicy-Operate': operate,
  'BusPeruStagingWorkloadBoundary': boundary,
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const destino = args.out ?? new URL('./policies/', import.meta.url);
  mkdirSync(destino, { recursive: true });
  for (const [nombre, doc] of Object.entries(politicas)) {
    const texto = JSON.stringify(doc, null, 2);
    writeFileSync(new URL(`${nombre}.json`, typeof destino === 'string' ? `file:///${destino.replace(/\\/g, '/').replace(/\/?$/, '/')}` : destino), `${texto}\n`);
    console.log(`${nombre.padEnd(40)} ${String(JSON.stringify(doc).length).padStart(5)} caracteres sin espacios · ${doc.Statement.length} declaraciones`);
  }
}
