// BusPerú · F18-18 · plantilla CloudFormation de PRODUCCIÓN: pila `busperu-prod` (sa-east-1). SOLO SE GENERA.
//
//   node build-prod-template.mjs   → escribe busperu-prod.json
//   node check-prod-templates.mjs  → comprueba esta plantilla y las otras dos de producción
//
// Se despliega SOLO por change set con el rol de servicio `BusPeruProdCloudFormationExecution` (línea base de
// F18-08). Por eso cada recurso encaja en lo que ese rol puede crear: la pila se llama exactamente
// `busperu-prod`, los nombres empiezan por `busperu-prod-`, los roles nuevos llevan el límite
// `BusPeruProdWorkloadBoundary`, y el rol de la instancia NO se crea aquí porque ya existe
// (`busperu-prod-app-role`, pila busperu-security-baseline): solo se le crea el perfil de instancia.
//
// Misma arquitectura que staging (build-template.mjs + build-web-template.mjs), con estas diferencias:
//   · VPC 10.30.0.0/16 (staging es 10.20.0.0/16): nada se comparte ni se solapa.
//   · El ALB NO admite IP de operador ni HTTP. Solo 443, solo desde la prefix list de CloudFront, y solo
//     reenvía si llega la cabecera secreta de origen; lo demás recibe 403. Se diagnostica por Session Manager.
//   · RDS: la CMK `alias/busperu-prod-rds`, 14 días de backups, `DeletionProtection` fija, almacenamiento con
//     autoescalado, logs `error` y `slowquery`.
//   · EC2 con protección contra terminación y el perfil `busperu-prod-app-profile`.
//   · Alarmas hacia el tema existente `busperu-prod-alarms`: esta pila no crea temas SNS.
//   · Sin parámetro EnvName: el entorno está fijado en el código, para que esta plantilla no pueda crear
//     recursos de staging ni al revés.
//
// Qué NO hay aquí y por qué:
//   · CloudFront, el bucket del frontend y la CSP → `busperu-prod-web` (build-prod-web-template.mjs). El
//     rol de ejecución no tiene permisos de CloudFront, y su barrera de región lo impediría.
//   · Filtros de métrica de la aplicación y presupuesto → `busperu-prod-observability`: el rol de ejecución
//     no tiene logs:PutMetricFilter ni Budgets.
//   · Certificados ACM y DNS → los emite y valida el propietario. Aquí solo entra el ARN como parámetro.
//
// No contiene ningún secreto: el valor de la cabecera de origen entra como parámetro NoEcho.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENV = 'prod';
const P = `busperu-${ENV}`;
const ref = (name) => ({ Ref: name });
const att = (resource, attribute) => ({ 'Fn::GetAtt': [resource, attribute] });
const sub = (text) => ({ 'Fn::Sub': text });
const az = (index) => ({ 'Fn::Select': [index, { 'Fn::GetAZs': '' }] });
const tags = (name, extra = {}) => [
  { Key: 'Name', Value: `${P}-${name}` },
  { Key: 'Project', Value: 'busperu' },
  { Key: 'Environment', Value: ENV },
  ...Object.entries(extra).map(([Key, Value]) => ({ Key, Value })),
];

export const VPC_CIDR = '10.30.0.0/16';
export const SQL_MODE = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION';
export const ORIGIN_HEADER = 'X-BusPeru-Origin';
export const APP_ROLE = `${P}-app-role`;
export const ALARM_TOPIC = `${P}-alarms`;
const APP_PORT = 3000;
const BOUNDARY = sub('arn:aws:iam::${AWS::AccountId}:policy/busperu/BusPeruProdWorkloadBoundary');

const template = {
  AWSTemplateFormatVersion: '2010-09-09',
  Description: 'BusPeru PRODUCCION (F18-18): VPC, RDS MariaDB 10.11 privada (CMK), EC2 + EBS, ALB HTTPS solo para CloudFront, alarmas. Sin secretos.',

  Parameters: {
    CertificateArn: {
      Type: 'String',
      AllowedPattern: '^arn:aws:acm:sa-east-1:[0-9]{12}:certificate/[0-9a-f-]{36}$',
      Description: 'Certificado ACM de api.busperuonline.pe en sa-east-1 (ISSUED). CloudFront envía Host=api.busperuonline.pe y valida este certificado.',
    },
    CloudFrontPrefixListId: { Type: 'String', AllowedPattern: '^pl-[0-9a-f]+$', Description: 'com.amazonaws.global.cloudfront.origin-facing en sa-east-1' },
    OriginVerifySecret: { Type: 'String', NoEcho: true, AllowedPattern: '^[0-9a-f]{64}$', Description: 'Cabecera secreta CloudFront → ALB (32 bytes en hex). La misma que en busperu-prod-web.' },
    DbEngineVersion: { Type: 'String', Default: '10.11.19', AllowedPattern: '^10\\.11\\.[0-9]+$', Description: 'MariaDB 10.11.x exacta (la validada en F18: 10.11.19)' },
    DbInstanceClass: { Type: 'String', Default: 'db.t4g.small', AllowedValues: ['db.t4g.micro', 'db.t4g.small', 'db.t4g.medium', 'db.m7g.large'] },
    DbAllocatedStorageGiB: { Type: 'Number', Default: 20, MinValue: 20, MaxValue: 500 },
    DbMaxAllocatedStorageGiB: { Type: 'Number', Default: 100, MinValue: 21, MaxValue: 1000, Description: 'Techo del autoescalado de almacenamiento' },
    DbBackupRetentionDays: { Type: 'Number', Default: 14, MinValue: 7, MaxValue: 35 },
    DbMultiAz: { Type: 'String', Default: 'false', AllowedValues: ['true', 'false'], Description: 'Decisión de coste del propietario (F18-08: false en la primera producción)' },
    AppInstanceType: { Type: 'String', Default: 't4g.small', AllowedValues: ['t4g.small', 't4g.medium', 't4g.large'] },
    AppAmiId: { Type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>', Default: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64' },
    DataVolumeSizeGiB: { Type: 'Number', Default: 20, MinValue: 8, MaxValue: 500 },
    AppLogRetentionDays: { Type: 'Number', Default: 90, AllowedValues: [90, 180, 365] },
  },

  Conditions: {
    MultiAz: { 'Fn::Equals': [ref('DbMultiAz'), 'true'] },
  },

  Resources: {
    // ------------------------------------------------------------------ red
    Vpc: { Type: 'AWS::EC2::VPC', Properties: { CidrBlock: VPC_CIDR, EnableDnsSupport: true, EnableDnsHostnames: true, Tags: tags('vpc') } },
    InternetGateway: { Type: 'AWS::EC2::InternetGateway', Properties: { Tags: tags('igw') } },
    GatewayAttachment: { Type: 'AWS::EC2::VPCGatewayAttachment', Properties: { VpcId: ref('Vpc'), InternetGatewayId: ref('InternetGateway') } },
    PublicSubnetA: { Type: 'AWS::EC2::Subnet', Properties: { VpcId: ref('Vpc'), CidrBlock: '10.30.0.0/24', AvailabilityZone: az(0), MapPublicIpOnLaunch: true, Tags: tags('public-a') } },
    PublicSubnetB: { Type: 'AWS::EC2::Subnet', Properties: { VpcId: ref('Vpc'), CidrBlock: '10.30.1.0/24', AvailabilityZone: az(1), MapPublicIpOnLaunch: true, Tags: tags('public-b') } },
    PrivateSubnetA: { Type: 'AWS::EC2::Subnet', Properties: { VpcId: ref('Vpc'), CidrBlock: '10.30.10.0/24', AvailabilityZone: az(0), MapPublicIpOnLaunch: false, Tags: tags('private-a') } },
    PrivateSubnetB: { Type: 'AWS::EC2::Subnet', Properties: { VpcId: ref('Vpc'), CidrBlock: '10.30.11.0/24', AvailabilityZone: az(1), MapPublicIpOnLaunch: false, Tags: tags('private-b') } },
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
        GroupDescription: 'ALB de BusPeru prod: 443 solo desde CloudFront (origin-facing)',
        VpcId: ref('Vpc'),
        SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, SourcePrefixListId: ref('CloudFrontPrefixListId'), Description: 'HTTPS desde CloudFront' }],
        SecurityGroupEgress: [{ IpProtocol: '-1', CidrIp: '127.0.0.1/32', Description: 'Sin salida salvo AlbToAppEgress' }],
        Tags: tags('alb-sg'),
      },
    },
    AppSecurityGroup: {
      Type: 'AWS::EC2::SecurityGroup',
      Properties: {
        GroupDescription: 'EC2 de BusPeru prod: API solo desde el ALB; sin SSH',
        VpcId: ref('Vpc'),
        SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: APP_PORT, ToPort: APP_PORT, SourceSecurityGroupId: ref('AlbSecurityGroup'), Description: 'API desde el ALB' }],
        // Igual que staging (F18-03B): 443 saliente (AWS, Node, paquetes, Culqi, Resend, OAuth) y hora de Amazon.
        SecurityGroupEgress: [
          { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0', Description: 'HTTPS saliente (AWS, Node, paquetes, Culqi, Resend, OAuth)' },
          { IpProtocol: 'udp', FromPort: 123, ToPort: 123, CidrIp: '169.254.169.123/32', Description: 'Amazon Time Sync' },
        ],
        Tags: tags('app-sg'),
      },
    },
    AlbToAppEgress: {
      Type: 'AWS::EC2::SecurityGroupEgress',
      Properties: { GroupId: ref('AlbSecurityGroup'), IpProtocol: 'tcp', FromPort: APP_PORT, ToPort: APP_PORT, DestinationSecurityGroupId: ref('AppSecurityGroup'), Description: 'ALB hacia la API' },
    },
    AppToDbEgress: {
      Type: 'AWS::EC2::SecurityGroupEgress',
      Properties: { GroupId: ref('AppSecurityGroup'), IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306, DestinationSecurityGroupId: ref('DbSecurityGroup'), Description: 'API hacia MariaDB' },
    },
    DbSecurityGroup: {
      Type: 'AWS::EC2::SecurityGroup',
      Properties: {
        GroupDescription: 'RDS de BusPeru prod: 3306 solo desde la EC2; sin salida',
        VpcId: ref('Vpc'),
        SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 3306, ToPort: 3306, SourceSecurityGroupId: ref('AppSecurityGroup'), Description: 'MariaDB desde la API' }],
        SecurityGroupEgress: [{ IpProtocol: '-1', CidrIp: '127.0.0.1/32', Description: 'Sin salida' }],
        Tags: tags('db-sg'),
      },
    },

    // ------------------------------------------------------------------ RDS
    DbSubnetGroup: {
      Type: 'AWS::RDS::DBSubnetGroup',
      Properties: { DBSubnetGroupName: `${P}-db-subnets`, DBSubnetGroupDescription: 'Subredes privadas de BusPeru prod', SubnetIds: [ref('PrivateSubnetA'), ref('PrivateSubnetB')], Tags: tags('db-subnets') },
    },
    DbParameterGroup: {
      Type: 'AWS::RDS::DBParameterGroup',
      Properties: {
        DBParameterGroupName: `${P}-db-params`,
        Family: 'mariadb10.11',
        Description: 'BusPeru prod: modo estricto, utf8mb4 y consultas lentas',
        Parameters: { sql_mode: SQL_MODE, character_set_server: 'utf8mb4', collation_server: 'utf8mb4_unicode_ci', slow_query_log: '1', long_query_time: '1', log_output: 'FILE' },
        Tags: tags('db-params'),
      },
    },
    Database: {
      Type: 'AWS::RDS::DBInstance',
      DeletionPolicy: 'Snapshot',
      UpdateReplacePolicy: 'Snapshot',
      Properties: {
        DBInstanceIdentifier: `${P}-db`,
        Engine: 'mariadb',
        EngineVersion: ref('DbEngineVersion'),
        AutoMinorVersionUpgrade: false,
        DBInstanceClass: ref('DbInstanceClass'),
        AllocatedStorage: ref('DbAllocatedStorageGiB'),
        MaxAllocatedStorage: ref('DbMaxAllocatedStorageGiB'),
        StorageType: 'gp3',
        StorageEncrypted: true,
        KmsKeyId: sub(`arn:aws:kms:\${AWS::Region}:\${AWS::AccountId}:alias/${P}-rds`),
        MasterUsername: 'busperu_master',
        ManageMasterUserPassword: true,
        DBSubnetGroupName: ref('DbSubnetGroup'),
        DBParameterGroupName: ref('DbParameterGroup'),
        VPCSecurityGroups: [ref('DbSecurityGroup')],
        PubliclyAccessible: false,
        MultiAZ: { 'Fn::If': ['MultiAz', true, false] },
        BackupRetentionPeriod: ref('DbBackupRetentionDays'),
        PreferredBackupWindow: '07:00-07:30',
        PreferredMaintenanceWindow: 'sun:08:00-sun:08:30',
        CopyTagsToSnapshot: true,
        DeleteAutomatedBackups: false,
        DeletionProtection: true,
        EnableCloudwatchLogsExports: ['error', 'slowquery'],
        Tags: tags('db'),
      },
    },

    // ------------------------------------------------------------------ IAM
    // El rol busperu-prod-app-role ya existe (línea base). Solo se crea su perfil de instancia.
    AppInstanceProfile: { Type: 'AWS::IAM::InstanceProfile', Properties: { InstanceProfileName: `${P}-app-profile`, Roles: [APP_ROLE] } },
    // Nombre generado por CloudFormation: busperu-prod-DlmRole-…, el único que el rol de ejecución puede pasar a DLM.
    DlmRole: {
      Type: 'AWS::IAM::Role',
      Properties: {
        PermissionsBoundary: BOUNDARY,
        AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'dlm.amazonaws.com' }, Action: 'sts:AssumeRole' }] },
        ManagedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole'],
        Tags: tags('dlm-role'),
      },
    },

    // ------------------------------------------------------------ artefactos
    ArtifactsBucket: {
      Type: 'AWS::S3::Bucket',
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: {
        BucketName: sub(`${P}-artifacts-\${AWS::AccountId}`),
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
        OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
        BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
        VersioningConfiguration: { Status: 'Enabled' },
        LifecycleConfiguration: { Rules: [{ Id: 'caducar-versiones-antiguas', Status: 'Enabled', NoncurrentVersionExpiration: { NoncurrentDays: 90 } }] },
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
        LaunchTemplateName: `${P}-app`,
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
        // Una sola instancia (F18-08): el limitador de peticiones y el planificador viven en memoria.
        DisableApiTermination: true,
        // Sin KeyName (sin SSH) y sin UserData: se aprovisiona por Session Manager (bootstrap-ec2.sh --env prod).
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
        Tags: tags('data', { Backup: `${P}-daily` }),
      },
    },
    DataVolumeAttachment: { Type: 'AWS::EC2::VolumeAttachment', Properties: { InstanceId: ref('AppInstance'), VolumeId: ref('DataVolume'), Device: '/dev/sdf' } },
    DataSnapshotPolicy: {
      Type: 'AWS::DLM::LifecyclePolicy',
      Properties: {
        Description: 'BusPeru prod - snapshot diario del volumen de STORAGE_DIR',
        State: 'ENABLED',
        Tags: tags('dlm'),
        ExecutionRoleArn: att('DlmRole', 'Arn'),
        PolicyDetails: {
          ResourceTypes: ['VOLUME'],
          TargetTags: [{ Key: 'Backup', Value: `${P}-daily` }],
          Schedules: [{ Name: 'diario', CopyTags: true, CreateRule: { Interval: 24, IntervalUnit: 'HOURS', Times: ['07:30'] }, RetainRule: { Count: 14 } }],
        },
      },
    },

    // ------------------------------------------------------------------ ALB
    LoadBalancer: {
      Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
      Properties: {
        Name: `${P}-alb`,
        Scheme: 'internet-facing',
        Type: 'application',
        Subnets: [ref('PublicSubnetA'), ref('PublicSubnetB')],
        SecurityGroups: [ref('AlbSecurityGroup')],
        LoadBalancerAttributes: [
          { Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
          { Key: 'idle_timeout.timeout_seconds', Value: '60' },
          { Key: 'deletion_protection.enabled', Value: 'true' },
        ],
        Tags: tags('alb'),
      },
    },
    TargetGroup: {
      Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
      Properties: {
        Name: `${P}-api`,
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
        TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '30' }],
        Tags: tags('api-tg'),
      },
    },
    HttpsListener: {
      Type: 'AWS::ElasticLoadBalancingV2::Listener',
      Properties: {
        LoadBalancerArn: ref('LoadBalancer'),
        Port: 443,
        Protocol: 'HTTPS',
        SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
        Certificates: [{ CertificateArn: ref('CertificateArn') }],
        // Por defecto, 403: solo la regla de la cabecera de origen llega a la API.
        DefaultActions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '403', ContentType: 'text/plain', MessageBody: 'Forbidden' } }],
      },
    },
    RuleFromCloudFront: {
      Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
      Properties: {
        ListenerArn: ref('HttpsListener'),
        Priority: 10,
        Conditions: [{ Field: 'http-header', HttpHeaderConfig: { HttpHeaderName: ORIGIN_HEADER, Values: [ref('OriginVerifySecret')] } }],
        Actions: [{ Type: 'forward', TargetGroupArn: ref('TargetGroup') }],
      },
    },

    // ------------------------------------------------------------ CloudWatch
    AppLogGroup: {
      Type: 'AWS::Logs::LogGroup',
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: { LogGroupName: `/busperu/${ENV}/app`, RetentionInDays: ref('AppLogRetentionDays') },
    },
  },

  Outputs: {
    LoadBalancerDns: { Value: att('LoadBalancer', 'DNSName'), Description: 'Origen de la distribución API de busperu-prod-web (AlbDnsName)' },
    DatabaseEndpoint: { Value: att('Database', 'Endpoint.Address'), Description: 'Valor de /busperu/prod/app/DB_HOST' },
    DatabaseMasterSecretArn: { Value: att('Database', 'MasterUserSecret.SecretArn'), Description: 'Secreto maestro gestionado por RDS (no lo usa la aplicación)' },
    AppInstanceId: { Value: ref('AppInstance') },
    DataVolumeId: { Value: ref('DataVolume') },
    ArtifactsBucketName: { Value: ref('ArtifactsBucket') },
    AppLogGroupName: { Value: ref('AppLogGroup') },
  },
};

// ------------------------------------------------------------------ alarmas (tema existente busperu-prod-alarms)
const TEMA = sub(`arn:aws:sns:\${AWS::Region}:\${AWS::AccountId}:${ALARM_TOPIC}`);
const alarm = (id, props) => {
  template.Resources[id] = {
    Type: 'AWS::CloudWatch::Alarm',
    Properties: {
      AlarmName: `${P}-${id.replace(/Alarm$/, '').replace(/[A-Z]/g, (m, i) => (i ? '-' : '') + m.toLowerCase())}`,
      AlarmActions: [TEMA],
      OKActions: [TEMA],
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
alarm('LatencyP95Alarm', { Namespace: 'AWS/ApplicationELB', MetricName: 'TargetResponseTime', Dimensions: albDims, Statistic: undefined, ExtendedStatistic: 'p95', Period: 300, EvaluationPeriods: 2, Threshold: 2, ComparisonOperator: 'GreaterThanThreshold', AlarmDescription: 'p95 de la API por encima de 2 s' });
alarm('Ec2StatusAlarm', { Namespace: 'AWS/EC2', MetricName: 'StatusCheckFailed', Dimensions: ec2Dims, Statistic: 'Maximum', Threshold: 0, ComparisonOperator: 'GreaterThanThreshold' });
alarm('Ec2CpuAlarm', { Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Dimensions: ec2Dims, Period: 300, Threshold: 80, ComparisonOperator: 'GreaterThanThreshold' });
alarm('Ec2MemoryAlarm', { Namespace: 'CWAgent', MetricName: 'mem_used_percent', Dimensions: ec2Dims, Period: 300, Threshold: 85, ComparisonOperator: 'GreaterThanThreshold' });
alarm('DataDiskAlarm', { Namespace: 'CWAgent', MetricName: 'disk_used_percent', Dimensions: [...ec2Dims, { Name: 'path', Value: '/data' }], Period: 300, Threshold: 80, ComparisonOperator: 'GreaterThanThreshold', TreatMissingData: 'breaching', AlarmDescription: 'Volumen de STORAGE_DIR casi lleno o sin montar' });
alarm('RootDiskAlarm', { Namespace: 'CWAgent', MetricName: 'disk_used_percent', Dimensions: [...ec2Dims, { Name: 'path', Value: '/' }], Period: 300, Threshold: 80, ComparisonOperator: 'GreaterThanThreshold' });
alarm('DbCpuAlarm', { Namespace: 'AWS/RDS', MetricName: 'CPUUtilization', Dimensions: dbDims, Period: 300, Threshold: 80, ComparisonOperator: 'GreaterThanThreshold' });
alarm('DbFreeStorageAlarm', { Namespace: 'AWS/RDS', MetricName: 'FreeStorageSpace', Dimensions: dbDims, Period: 300, Threshold: 2 * 1024 ** 3, ComparisonOperator: 'LessThanThreshold' });
alarm('DbFreeMemoryAlarm', { Namespace: 'AWS/RDS', MetricName: 'FreeableMemory', Dimensions: dbDims, Period: 300, Threshold: 100 * 1024 ** 2, ComparisonOperator: 'LessThanThreshold' });
alarm('DbConnectionsAlarm', { Namespace: 'AWS/RDS', MetricName: 'DatabaseConnections', Dimensions: dbDims, Period: 300, Threshold: 40, ComparisonOperator: 'GreaterThanThreshold', AlarmDescription: 'El pool de la app son 10; más de 40 indica fugas o clientes ajenos' });
for (const a of Object.values(template.Resources)) if (a.Type === 'AWS::CloudWatch::Alarm' && a.Properties.Statistic === undefined) delete a.Properties.Statistic;

export default template;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const destino = new URL('./busperu-prod.json', import.meta.url);
  const json = `${JSON.stringify(template, null, 2)}\n`;
  writeFileSync(destino, json);
  console.log(`busperu-prod.json · ${Object.keys(template.Resources).length} recursos · ${Buffer.byteLength(json)} bytes`);
}
