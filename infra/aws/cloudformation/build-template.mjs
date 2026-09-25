// BusPerú · F18-03 · plantilla CloudFormation del entorno de STAGING.
//
// Se escribe como JavaScript que genera JSON (CloudFormation admite JSON) para poder validarla en
// local sin herramientas extra: `node build-template.mjs` escribe `busperu-staging.json` y
// `node check-template.mjs` comprueba referencias y reglas de seguridad.
//
// Qué crea (todo con el prefijo busperu-<env>-):
//   · VPC propia con 2 subredes públicas (ALB y EC2) y 2 privadas (RDS), sin NAT Gateway.
//   · Security groups mínimos: ALB ← CIDR permitido; EC2:3000 ← ALB; RDS:3306 ← EC2.
//   · RDS MariaDB 10.11 privada, cifrada, con backups y parameter group en modo estricto. La
//     contraseña maestra la genera y guarda RDS en Secrets Manager (nadie la escribe).
//   · EC2 (Amazon Linux 2023, arm64) sin clave SSH ni puerto 22: administración por Session Manager.
//     IMDSv2 obligatorio. Volumen EBS gp3 cifrado aparte para STORAGE_DIR, con snapshots diarios (DLM).
//   · ALB con health check en GET /api/ready. HTTPS si se pasa un certificado ACM; sin él, solo HTTP
//     y restringido al CIDR indicado (staging no público).
//   · Bucket privado para los artefactos de despliegue, grupo de logs y alarmas de CloudWatch.
//
// No contiene ningún secreto: los secretos de la aplicación viven en Parameter Store (ver runbook).

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ref = (name) => ({ Ref: name });
const att = (resource, attribute) => ({ 'Fn::GetAtt': [resource, attribute] });
const sub = (text) => ({ 'Fn::Sub': text });
const iff = (condition, yes, no) => ({ 'Fn::If': [condition, yes, no] });
const noValue = { Ref: 'AWS::NoValue' };
const az = (index) => ({ 'Fn::Select': [index, { 'Fn::GetAZs': '' }] });
const tags = (name, extra = {}) => [
  { Key: 'Name', Value: sub(`busperu-\${EnvName}-${name}`) },
  { Key: 'Project', Value: 'busperu' },
  { Key: 'Environment', Value: ref('EnvName') },
  ...Object.entries(extra).map(([Key, Value]) => ({ Key, Value })),
];

const SQL_MODE = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION';
const APP_PORT = 3000;

const template = {
  AWSTemplateFormatVersion: '2010-09-09',
  Description: 'BusPeru staging (F18-03): VPC, RDS MariaDB 10.11 privada, EC2 + EBS, ALB, CloudWatch. Sin secretos.',

  Parameters: {
    EnvName: { Type: 'String', Default: 'staging', AllowedPattern: '^[a-z][a-z0-9-]{1,15}$', Description: 'Sufijo de los nombres: busperu-<EnvName>-*' },
    AllowedIngressCidr: {
      Type: 'String',
      // F18-04: prefijo /16 a /32. El patrón ya no admite 0.0.0.0/0 ni bloques más anchos que un /16.
      AllowedPattern: '^(\\d{1,3}\\.){3}\\d{1,3}/(1[6-9]|2\\d|3[0-2])$',
      Description: 'Único origen que puede llegar al ALB (p. ej. tu IP/32). Staging no es público. Nunca 0.0.0.0/0 sin certificado.',
    },
    // F18-04: algunas conexiones salen por dos IP públicas que se alternan (NAT del proveedor). Opcional y solo /32.
    AllowedIngressCidr2: {
      Type: 'String', Default: '',
      AllowedPattern: '^$|^(\\d{1,3}\\.){3}\\d{1,3}/32$',
      Description: 'Segunda IP/32 permitida hacia el ALB (opcional). Vacío = solo AllowedIngressCidr.',
    },
    CertificateArn: { Type: 'String', Default: '', Description: 'ARN del certificado ACM de API_DOMAIN en esta región. Vacío = sin HTTPS (solo validación restringida por CIDR).' },
    DbEngineVersion: {
      Type: 'String', Default: '10.11', AllowedPattern: '^10\\.11(\\.\\d+)?$',
      Description: 'MariaDB 10.11.x. Fijar la versión exacta tras consultar describe-db-engine-versions (runbook §4).',
    },
    DbInstanceClass: { Type: 'String', Default: 'db.t4g.micro' },
    DbAllocatedStorageGiB: { Type: 'Number', Default: 20, MinValue: 20, MaxValue: 200 },
    DbBackupRetentionDays: { Type: 'Number', Default: 7, MinValue: 1, MaxValue: 35 },
    DbDeletionProtection: { Type: 'String', Default: 'true', AllowedValues: ['true', 'false'] },
    AllowMasterSecretAccess: {
      Type: 'String', Default: 'false', AllowedValues: ['true', 'false'],
      Description: 'Solo "true" durante la creación de usuarios de base de datos (runbook §7). Después, volver a "false".',
    },
    AppInstanceType: { Type: 'String', Default: 't4g.small' },
    AppAmiId: { Type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>', Default: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64' },
    DataVolumeSizeGiB: { Type: 'Number', Default: 20, MinValue: 8, MaxValue: 500 },
    LogRetentionDays: { Type: 'Number', Default: 14, AllowedValues: [7, 14, 30, 60, 90] },
    AlarmEmail: { Type: 'String', Default: '', Description: 'Correo para las alarmas (opcional; hay que confirmar la suscripción).' },
  },

  Conditions: {
    HasCertificate: { 'Fn::Not': [{ 'Fn::Equals': [ref('CertificateArn'), ''] }] },
    NoCertificate: { 'Fn::Equals': [ref('CertificateArn'), ''] },
    HasSecondCidr: { 'Fn::Not': [{ 'Fn::Equals': [ref('AllowedIngressCidr2'), ''] }] },
    HasCertificateAndSecondCidr: { 'Fn::And': [{ Condition: 'HasCertificate' }, { Condition: 'HasSecondCidr' }] },
    HasAlarmEmail: { 'Fn::Not': [{ 'Fn::Equals': [ref('AlarmEmail'), ''] }] },
    MasterSecretAccess: { 'Fn::Equals': [ref('AllowMasterSecretAccess'), 'true'] },
  },

  Resources: {
    // ------------------------------------------------------------------ red
    Vpc: { Type: 'AWS::EC2::VPC', Properties: { CidrBlock: '10.20.0.0/16', EnableDnsSupport: true, EnableDnsHostnames: true, Tags: tags('vpc') } },
    InternetGateway: { Type: 'AWS::EC2::InternetGateway', Properties: { Tags: tags('igw') } },
    GatewayAttachment: { Type: 'AWS::EC2::VPCGatewayAttachment', Properties: { VpcId: ref('Vpc'), InternetGatewayId: ref('InternetGateway') } },
    PublicSubnetA: { Type: 'AWS::EC2::Subnet', Properties: { VpcId: ref('Vpc'), CidrBlock: '10.20.0.0/24', AvailabilityZone: az(0), MapPublicIpOnLaunch: true, Tags: tags('public-a') } },
    PublicSubnetB: { Type: 'AWS::EC2::Subnet', Properties: { VpcId: ref('Vpc'), CidrBlock: '10.20.1.0/24', AvailabilityZone: az(1), MapPublicIpOnLaunch: true, Tags: tags('public-b') } },
    PrivateSubnetA: { Type: 'AWS::EC2::Subnet', Properties: { VpcId: ref('Vpc'), CidrBlock: '10.20.10.0/24', AvailabilityZone: az(0), MapPublicIpOnLaunch: false, Tags: tags('private-a') } },
    PrivateSubnetB: { Type: 'AWS::EC2::Subnet', Properties: { VpcId: ref('Vpc'), CidrBlock: '10.20.11.0/24', AvailabilityZone: az(1), MapPublicIpOnLaunch: false, Tags: tags('private-b') } },
    PublicRouteTable: { Type: 'AWS::EC2::RouteTable', Properties: { VpcId: ref('Vpc'), Tags: tags('public-rt') } },
    PublicDefaultRoute: { Type: 'AWS::EC2::Route', DependsOn: 'GatewayAttachment', Properties: { RouteTableId: ref('PublicRouteTable'), DestinationCidrBlock: '0.0.0.0/0', GatewayId: ref('InternetGateway') } },
    PublicSubnetARoutes: { Type: 'AWS::EC2::SubnetRouteTableAssociation', Properties: { SubnetId: ref('PublicSubnetA'), RouteTableId: ref('PublicRouteTable') } },
    PublicSubnetBRoutes: { Type: 'AWS::EC2::SubnetRouteTableAssociation', Properties: { SubnetId: ref('PublicSubnetB'), RouteTableId: ref('PublicRouteTable') } },
    // Las subredes privadas no tienen ruta a Internet: RDS no sale ni entra desde fuera de la VPC.
    PrivateRouteTable: { Type: 'AWS::EC2::RouteTable', Properties: { VpcId: ref('Vpc'), Tags: tags('private-rt') } },
    PrivateSubnetARoutes: { Type: 'AWS::EC2::SubnetRouteTableAssociation', Properties: { SubnetId: ref('PrivateSubnetA'), RouteTableId: ref('PrivateRouteTable') } },
    PrivateSubnetBRoutes: { Type: 'AWS::EC2::SubnetRouteTableAssociation', Properties: { SubnetId: ref('PrivateSubnetB'), RouteTableId: ref('PrivateRouteTable') } },

    // ------------------------------------------------------ security groups
    AlbSecurityGroup: {
      Type: 'AWS::EC2::SecurityGroup',
      Properties: {
        GroupDescription: 'ALB de BusPeru: solo desde el CIDR permitido',
        VpcId: ref('Vpc'),
        SecurityGroupIngress: [
          { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: ref('AllowedIngressCidr'), Description: 'HTTP (redirige a HTTPS si hay certificado)' },
          iff('HasCertificate', { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: ref('AllowedIngressCidr'), Description: 'HTTPS' }, noValue),
          iff('HasSecondCidr', { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: ref('AllowedIngressCidr2'), Description: 'HTTP desde la segunda IP permitida' }, noValue),
          iff('HasCertificateAndSecondCidr', { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: ref('AllowedIngressCidr2'), Description: 'HTTPS desde la segunda IP permitida' }, noValue),
        ],
        // F18-03B: sustituye la salida por defecto (todo) por una regla inerte. La única salida real
        // del ALB es AlbToAppEgress (3000 hacia la EC2), declarada aparte para no crear un ciclo.
        SecurityGroupEgress: [{ IpProtocol: '-1', CidrIp: '127.0.0.1/32', Description: 'Sin salida salvo AlbToAppEgress' }],
        Tags: tags('alb-sg'),
      },
    },
    AppSecurityGroup: {
      Type: 'AWS::EC2::SecurityGroup',
      Properties: {
        GroupDescription: 'EC2 de BusPeru: puerto de la API solo desde el ALB; sin SSH',
        VpcId: ref('Vpc'),
        SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: APP_PORT, ToPort: APP_PORT, SourceSecurityGroupId: ref('AlbSecurityGroup'), Description: 'API desde el ALB' }],
        // F18-03B: salida limitada a lo que la instancia necesita de verdad (ver AWS-ARCHITECTURE §5):
        //   · 443 a Internet: APIs de AWS (SSM, Session Manager, Parameter Store, Secrets Manager,
        //     CloudWatch, S3), nodejs.org, repositorios de Amazon Linux, npm, y en ejecución Culqi,
        //     Resend y OAuth. Todo es HTTPS.
        //   · 3306 solo hacia el SG de la base (AppToDbEgress, aparte para no crear un ciclo).
        //   · 123/udp al servicio de hora de Amazon (enlace local).
        // Si algún día se usa MAIL_TRANSPORT=smtp hay que añadir el puerto del servidor SMTP.
        SecurityGroupEgress: [
          { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0', Description: 'HTTPS saliente (AWS, Node, paquetes, Culqi, Resend, OAuth)' },
          { IpProtocol: 'udp', FromPort: 123, ToPort: 123, CidrIp: '169.254.169.123/32', Description: 'Amazon Time Sync' },
        ],
        Tags: tags('app-sg'),
      },
    },
    AlbToAppEgress: {
      Type: 'AWS::EC2::SecurityGroupEgress',
      Properties: {
        GroupId: ref('AlbSecurityGroup'), IpProtocol: 'tcp', FromPort: APP_PORT, ToPort: APP_PORT,
        DestinationSecurityGroupId: ref('AppSecurityGroup'), Description: 'ALB hacia la API',
      },
    },
    AppToDbEgress: {
      Type: 'AWS::EC2::SecurityGroupEgress',
      Properties: {
        GroupId: ref('AppSecurityGroup'), IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306,
        DestinationSecurityGroupId: ref('DbSecurityGroup'), Description: 'API hacia MariaDB',
      },
    },
    DbSecurityGroup: {
      Type: 'AWS::EC2::SecurityGroup',
      Properties: {
        GroupDescription: 'RDS de BusPeru: 3306 solo desde la EC2; sin salida',
        VpcId: ref('Vpc'),
        SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306, SourceSecurityGroupId: ref('AppSecurityGroup'), Description: 'MariaDB desde la API' }],
        // Sustituye la salida por defecto (todo) por una regla inerte: la base no inicia conexiones.
        SecurityGroupEgress: [{ IpProtocol: '-1', CidrIp: '127.0.0.1/32', Description: 'Sin salida' }],
        Tags: tags('db-sg'),
      },
    },

    // ------------------------------------------------------------------ RDS
    DbSubnetGroup: {
      Type: 'AWS::RDS::DBSubnetGroup',
      Properties: { DBSubnetGroupDescription: 'Subredes privadas de BusPeru', SubnetIds: [ref('PrivateSubnetA'), ref('PrivateSubnetB')], Tags: tags('db-subnets') },
    },
    DbParameterGroup: {
      Type: 'AWS::RDS::DBParameterGroup',
      Properties: {
        Family: 'mariadb10.11',
        Description: 'BusPeru: modo estricto y utf8mb4 (validado en F18-02B)',
        Parameters: { sql_mode: SQL_MODE, character_set_server: 'utf8mb4', collation_server: 'utf8mb4_unicode_ci' },
        Tags: tags('db-params'),
      },
    },
    Database: {
      Type: 'AWS::RDS::DBInstance',
      DeletionPolicy: 'Snapshot',
      UpdateReplacePolicy: 'Snapshot',
      Properties: {
        DBInstanceIdentifier: sub('busperu-${EnvName}-db'),
        Engine: 'mariadb',
        EngineVersion: ref('DbEngineVersion'),
        AutoMinorVersionUpgrade: false,
        DBInstanceClass: ref('DbInstanceClass'),
        AllocatedStorage: ref('DbAllocatedStorageGiB'),
        StorageType: 'gp3',
        StorageEncrypted: true,
        MasterUsername: 'busperu_master',
        ManageMasterUserPassword: true,
        DBSubnetGroupName: ref('DbSubnetGroup'),
        DBParameterGroupName: ref('DbParameterGroup'),
        VPCSecurityGroups: [ref('DbSecurityGroup')],
        PubliclyAccessible: false,
        MultiAZ: false,
        BackupRetentionPeriod: ref('DbBackupRetentionDays'),
        PreferredBackupWindow: '07:00-07:30',
        PreferredMaintenanceWindow: 'sun:08:00-sun:08:30',
        CopyTagsToSnapshot: true,
        DeleteAutomatedBackups: false,
        DeletionProtection: ref('DbDeletionProtection'),
        EnableCloudwatchLogsExports: ['error'],
        Tags: tags('db'),
      },
    },

    // ------------------------------------------------------------------ IAM
    AppRole: {
      Type: 'AWS::IAM::Role',
      Properties: {
        RoleName: sub('busperu-${EnvName}-app-role'),
        // F18-03D: límite de permisos obligatorio (el rol de despliegue no puede crear roles sin él).
        PermissionsBoundary: sub('arn:aws:iam::${AWS::AccountId}:policy/busperu/BusPeruStagingWorkloadBoundary'),
        AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] },
        // F18-03B: SIN políticas gestionadas. `AmazonSSMManagedInstanceCore` concede
        // ssm:GetParameter(s) sobre "*" —con el kms:Decrypt de abajo, la instancia podría leer
        // CUALQUIER SecureString de la cuenta— y `CloudWatchAgentServerPolicy` concede logs:* de
        // creación y retención y X-Ray sobre "*". Se sustituyen por lo mínimo, documentado por AWS.
        Policies: [
          {
            PolicyName: 'busperu-app-minimo',
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [
                {
                  // Mínimo documentado por AWS para Session Manager ("Creating an IAM role with
                  // minimal Session Manager permissions"). Estas acciones no admiten recurso.
                  Sid: 'SessionManager', Effect: 'Allow',
                  Action: ['ssm:UpdateInstanceInformation', 'ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel', 'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel'],
                  Resource: '*',
                },
                {
                  Sid: 'ParametrosDelEntorno', Effect: 'Allow',
                  Action: ['ssm:GetParametersByPath', 'ssm:GetParameter', 'ssm:GetParameters'],
                  Resource: [
                    sub('arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/busperu/${EnvName}'),
                    sub('arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/busperu/${EnvName}/*'),
                  ],
                },
                {
                  // Solo para descifrar a través de Parameter Store y SOLO los parámetros de este
                  // entorno: Parameter Store usa como contexto de cifrado PARAMETER_ARN.
                  Sid: 'DescifrarSoloEsosParametros', Effect: 'Allow', Action: 'kms:Decrypt', Resource: '*',
                  Condition: {
                    StringEquals: { 'kms:ViaService': sub('ssm.${AWS::Region}.amazonaws.com') },
                    StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': sub('arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/busperu/${EnvName}/*') },
                  },
                },
                {
                  // El agente escribe en su grupo de logs (lo crea la pila, con su retención).
                  Sid: 'LogsDeLaAplicacion', Effect: 'Allow',
                  Action: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
                  Resource: att('AppLogGroup', 'Arn'),
                },
                {
                  // PutMetricData no admite recurso; se limita al espacio de nombres del agente.
                  Sid: 'MetricasDelAgente', Effect: 'Allow', Action: 'cloudwatch:PutMetricData', Resource: '*',
                  Condition: { StringEquals: { 'cloudwatch:namespace': 'CWAgent' } },
                },
                { Sid: 'ArtefactosLeer', Effect: 'Allow', Action: ['s3:GetObject'], Resource: sub('${ArtifactsBucket.Arn}/*') },
                { Sid: 'ArtefactosListar', Effect: 'Allow', Action: ['s3:ListBucket'], Resource: att('ArtifactsBucket', 'Arn') },
              ],
            },
          },
        ],
        Tags: tags('app-role'),
      },
    },
    // Acceso temporal al secreto maestro de RDS, solo mientras se crean los usuarios (runbook §7).
    MasterSecretPolicy: {
      Type: 'AWS::IAM::Policy',
      Condition: 'MasterSecretAccess',
      Properties: {
        PolicyName: 'busperu-master-secret-temporal',
        Roles: [ref('AppRole')],
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: att('Database', 'MasterUserSecret.SecretArn') }],
        },
      },
    },
    AppInstanceProfile: { Type: 'AWS::IAM::InstanceProfile', Properties: { Roles: [ref('AppRole')] } },

    // ------------------------------------------------------------ artefactos
    ArtifactsBucket: {
      Type: 'AWS::S3::Bucket',
      Properties: {
        BucketName: sub('busperu-${EnvName}-artifacts-${AWS::AccountId}'),
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
        OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
        BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
        VersioningConfiguration: { Status: 'Enabled' },
        LifecycleConfiguration: { Rules: [{ Id: 'caducar-versiones-antiguas', Status: 'Enabled', NoncurrentVersionExpiration: { NoncurrentDays: 30 } }] },
        Tags: tags('artifacts'),
      },
    },
    ArtifactsBucketPolicy: {
      Type: 'AWS::S3::BucketPolicy',
      Properties: {
        Bucket: ref('ArtifactsBucket'),
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: [{
            Sid: 'SoloTLS', Effect: 'Deny', Principal: '*', Action: 's3:*',
            Resource: [att('ArtifactsBucket', 'Arn'), sub('${ArtifactsBucket.Arn}/*')],
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }],
        },
      },
    },

    // ------------------------------------------------------------------ EC2
    AppLaunchTemplate: {
      Type: 'AWS::EC2::LaunchTemplate',
      Properties: {
        LaunchTemplateName: sub('busperu-${EnvName}-app'),
        // F18-03D: etiquetas propias de la plantilla de lanzamiento; el rol de despliegue solo puede
        // usar o modificar plantillas de lanzamiento con Project=busperu y su Environment.
        TagSpecifications: [{ ResourceType: 'launch-template', Tags: tags('app-lt') }],
        LaunchTemplateData: {
          MetadataOptions: { HttpTokens: 'required', HttpEndpoint: 'enabled', HttpPutResponseHopLimit: 1 },
          BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: { VolumeType: 'gp3', VolumeSize: 20, Encrypted: true, DeleteOnTermination: true } }],
        },
      },
    },
    AppInstance: {
      Type: 'AWS::EC2::Instance',
      Properties: {
        ImageId: ref('AppAmiId'),
        InstanceType: ref('AppInstanceType'),
        LaunchTemplate: { LaunchTemplateId: ref('AppLaunchTemplate'), Version: att('AppLaunchTemplate', 'LatestVersionNumber') },
        IamInstanceProfile: ref('AppInstanceProfile'),
        SubnetId: ref('PublicSubnetA'),
        SecurityGroupIds: [ref('AppSecurityGroup')],
        // Sin KeyName: no hay SSH. Sin UserData: el aprovisionamiento se hace por Session Manager.
        Tags: tags('app'),
      },
    },
    DataVolume: {
      Type: 'AWS::EC2::Volume',
      DeletionPolicy: 'Snapshot',
      UpdateReplacePolicy: 'Snapshot',
      Properties: {
        AvailabilityZone: att('AppInstance', 'AvailabilityZone'),
        Size: ref('DataVolumeSizeGiB'),
        VolumeType: 'gp3',
        Encrypted: true,
        Tags: tags('data', { Backup: sub('busperu-${EnvName}-daily') }),
      },
    },
    DataVolumeAttachment: { Type: 'AWS::EC2::VolumeAttachment', Properties: { InstanceId: ref('AppInstance'), VolumeId: ref('DataVolume'), Device: '/dev/sdf' } },

    // Snapshots diarios del volumen de datos, conservando 7.
    DlmRole: {
      Type: 'AWS::IAM::Role',
      Properties: {
        PermissionsBoundary: sub('arn:aws:iam::${AWS::AccountId}:policy/busperu/BusPeruStagingWorkloadBoundary'),
        AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'dlm.amazonaws.com' }, Action: 'sts:AssumeRole' }] },
        ManagedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole'],
        Tags: tags('dlm-role'),
      },
    },
    DataSnapshotPolicy: {
      Type: 'AWS::DLM::LifecyclePolicy',
      Properties: {
        // DLM solo admite [0-9A-Za-z _-] en la descripción (F18-04: los dos puntos hicieron fallar la pila).
        Description: 'BusPeru - snapshot diario del volumen de STORAGE_DIR',
        State: 'ENABLED',
        // F18-03D: el rol de despliegue solo crea y opera políticas de DLM con estas etiquetas.
        Tags: tags('dlm'),
        ExecutionRoleArn: att('DlmRole', 'Arn'),
        PolicyDetails: {
          ResourceTypes: ['VOLUME'],
          TargetTags: [{ Key: 'Backup', Value: sub('busperu-${EnvName}-daily') }],
          Schedules: [{
            Name: 'diario', CopyTags: true,
            CreateRule: { Interval: 24, IntervalUnit: 'HOURS', Times: ['07:30'] },
            RetainRule: { Count: 7 },
          }],
        },
      },
    },

    // ------------------------------------------------------------------ ALB
    LoadBalancer: {
      Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
      Properties: {
        Name: sub('busperu-${EnvName}-alb'),
        Scheme: 'internet-facing',
        Type: 'application',
        Subnets: [ref('PublicSubnetA'), ref('PublicSubnetB')],
        SecurityGroups: [ref('AlbSecurityGroup')],
        LoadBalancerAttributes: [{ Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' }],
        Tags: tags('alb'),
      },
    },
    TargetGroup: {
      Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
      Properties: {
        Name: sub('busperu-${EnvName}-api'),
        VpcId: ref('Vpc'),
        Protocol: 'HTTP',
        Port: APP_PORT,
        TargetType: 'instance',
        Targets: [{ Id: ref('AppInstance'), Port: APP_PORT }],
        HealthCheckEnabled: true,
        HealthCheckProtocol: 'HTTP',
        HealthCheckPath: '/api/ready',
        HealthCheckIntervalSeconds: 15,
        HealthCheckTimeoutSeconds: 5,
        HealthyThresholdCount: 2,
        UnhealthyThresholdCount: 3,
        Matcher: { HttpCode: '200' },
        // Por encima de los 10 s de cierre ordenado del proceso.
        TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '30' }],
        Tags: tags('api-tg'),
      },
    },
    HttpsListener: {
      Type: 'AWS::ElasticLoadBalancingV2::Listener',
      Condition: 'HasCertificate',
      Properties: {
        LoadBalancerArn: ref('LoadBalancer'),
        Port: 443,
        Protocol: 'HTTPS',
        SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
        Certificates: [{ CertificateArn: ref('CertificateArn') }],
        DefaultActions: [{ Type: 'forward', TargetGroupArn: ref('TargetGroup') }],
      },
    },
    HttpRedirectListener: {
      Type: 'AWS::ElasticLoadBalancingV2::Listener',
      Condition: 'HasCertificate',
      Properties: {
        LoadBalancerArn: ref('LoadBalancer'),
        Port: 80,
        Protocol: 'HTTP',
        DefaultActions: [{ Type: 'redirect', RedirectConfig: { Protocol: 'HTTPS', Port: '443', StatusCode: 'HTTP_301' } }],
      },
    },
    // Sin certificado: HTTP SOLO para validar desde AllowedIngressCidr. No es una publicación.
    HttpValidationListener: {
      Type: 'AWS::ElasticLoadBalancingV2::Listener',
      Condition: 'NoCertificate',
      Properties: {
        LoadBalancerArn: ref('LoadBalancer'),
        Port: 80,
        Protocol: 'HTTP',
        DefaultActions: [{ Type: 'forward', TargetGroupArn: ref('TargetGroup') }],
      },
    },

    // ------------------------------------------------------------ CloudWatch
    AppLogGroup: { Type: 'AWS::Logs::LogGroup', Properties: { LogGroupName: sub('/busperu/${EnvName}/app'), RetentionInDays: ref('LogRetentionDays') } },
    AlarmTopic: { Type: 'AWS::SNS::Topic', Properties: { TopicName: sub('busperu-${EnvName}-alarms'), Tags: tags('alarms') } },
    AlarmSubscription: { Type: 'AWS::SNS::Subscription', Condition: 'HasAlarmEmail', Properties: { TopicArn: ref('AlarmTopic'), Protocol: 'email', Endpoint: ref('AlarmEmail') } },
  },

  Outputs: {
    LoadBalancerDns: { Value: att('LoadBalancer', 'DNSName'), Description: 'DNS del ALB (API_DOMAIN apuntará aquí)' },
    DatabaseEndpoint: { Value: att('Database', 'Endpoint.Address') },
    DatabaseMasterSecretArn: { Value: att('Database', 'MasterUserSecret.SecretArn'), Description: 'Secreto maestro gestionado por RDS (no lo usa la aplicación)' },
    AppInstanceId: { Value: ref('AppInstance') },
    DataVolumeId: { Value: ref('DataVolume') },
    ArtifactsBucketName: { Value: ref('ArtifactsBucket') },
    AppLogGroupName: { Value: ref('AppLogGroup') },
    AlarmTopicArn: { Value: ref('AlarmTopic') },
  },
};

// ------------------------------------------------------------------ alarmas
const alarm = (id, props) => {
  template.Resources[id] = {
    Type: 'AWS::CloudWatch::Alarm',
    Properties: {
      AlarmName: sub(`busperu-\${EnvName}-${id.replace(/Alarm$/, '').replace(/[A-Z]/g, (m, i) => (i ? '-' : '') + m.toLowerCase())}`),
      AlarmActions: [ref('AlarmTopic')],
      OKActions: [ref('AlarmTopic')],
      TreatMissingData: 'notBreaching',
      EvaluationPeriods: 3,
      Period: 60,
      Statistic: 'Average',
      ...props,
    },
  };
};
const albDims = [
  { Name: 'LoadBalancer', Value: att('LoadBalancer', 'LoadBalancerFullName') },
  { Name: 'TargetGroup', Value: att('TargetGroup', 'TargetGroupFullName') },
];
const dbDims = [{ Name: 'DBInstanceIdentifier', Value: ref('Database') }];
const ec2Dims = [{ Name: 'InstanceId', Value: ref('AppInstance') }];

alarm('UnhealthyHostsAlarm', { Namespace: 'AWS/ApplicationELB', MetricName: 'UnHealthyHostCount', Dimensions: albDims, Statistic: 'Maximum', Threshold: 0, ComparisonOperator: 'GreaterThanThreshold', TreatMissingData: 'breaching', AlarmDescription: '/api/ready falla: base o almacenamiento no disponibles' });
alarm('Target5xxAlarm', { Namespace: 'AWS/ApplicationELB', MetricName: 'HTTPCode_Target_5XX_Count', Dimensions: albDims, Statistic: 'Sum', Period: 300, EvaluationPeriods: 1, Threshold: 5, ComparisonOperator: 'GreaterThanThreshold' });
alarm('Elb5xxAlarm', { Namespace: 'AWS/ApplicationELB', MetricName: 'HTTPCode_ELB_5XX_Count', Dimensions: [albDims[0]], Statistic: 'Sum', Period: 300, EvaluationPeriods: 1, Threshold: 5, ComparisonOperator: 'GreaterThanThreshold' });
alarm('Ec2StatusAlarm', { Namespace: 'AWS/EC2', MetricName: 'StatusCheckFailed', Dimensions: ec2Dims, Statistic: 'Maximum', Threshold: 0, ComparisonOperator: 'GreaterThanThreshold' });
alarm('Ec2CpuAlarm', { Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Dimensions: ec2Dims, Period: 300, Threshold: 80, ComparisonOperator: 'GreaterThanThreshold' });
alarm('Ec2MemoryAlarm', { Namespace: 'CWAgent', MetricName: 'mem_used_percent', Dimensions: ec2Dims, Period: 300, Threshold: 85, ComparisonOperator: 'GreaterThanThreshold' });
alarm('DataDiskAlarm', { Namespace: 'CWAgent', MetricName: 'disk_used_percent', Dimensions: [...ec2Dims, { Name: 'path', Value: '/data' }], Period: 300, Threshold: 80, ComparisonOperator: 'GreaterThanThreshold', TreatMissingData: 'breaching', AlarmDescription: 'Volumen de STORAGE_DIR casi lleno o sin montar' });
alarm('RootDiskAlarm', { Namespace: 'CWAgent', MetricName: 'disk_used_percent', Dimensions: [...ec2Dims, { Name: 'path', Value: '/' }], Period: 300, Threshold: 80, ComparisonOperator: 'GreaterThanThreshold' });
alarm('DbCpuAlarm', { Namespace: 'AWS/RDS', MetricName: 'CPUUtilization', Dimensions: dbDims, Period: 300, Threshold: 80, ComparisonOperator: 'GreaterThanThreshold' });
alarm('DbFreeStorageAlarm', { Namespace: 'AWS/RDS', MetricName: 'FreeStorageSpace', Dimensions: dbDims, Period: 300, Threshold: 2 * 1024 ** 3, ComparisonOperator: 'LessThanThreshold' });
alarm('DbFreeMemoryAlarm', { Namespace: 'AWS/RDS', MetricName: 'FreeableMemory', Dimensions: dbDims, Period: 300, Threshold: 100 * 1024 ** 2, ComparisonOperator: 'LessThanThreshold' });
alarm('DbConnectionsAlarm', { Namespace: 'AWS/RDS', MetricName: 'DatabaseConnections', Dimensions: dbDims, Period: 300, Threshold: 40, ComparisonOperator: 'GreaterThanThreshold', AlarmDescription: 'El pool de la app son 10; más de 40 indica fugas o clientes ajenos' });

export default template;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const destino = new URL('./busperu-staging.json', import.meta.url);
  writeFileSync(destino, `${JSON.stringify(template, null, 2)}\n`);
  console.log(`Escrita ${fileURLToPath(destino)} (${Object.keys(template.Resources).length} recursos)`);
}
