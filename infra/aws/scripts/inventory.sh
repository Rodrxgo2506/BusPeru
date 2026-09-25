#!/usr/bin/env bash
# BusPerú · F18-03 · inventario de SOLO LECTURA de la cuenta AWS (paso 1 del runbook).
#
#   AWS_PROFILE=<perfil> bash infra/aws/scripts/inventory.sh [región]
#
# No crea, modifica ni borra nada: solo `describe`/`list`/`get`. Sirve para saber qué hay ya en la
# cuenta ANTES de desplegar, porque nada garantiza que esté vacía. Imprime identificadores y
# nombres; nunca valores de secretos (de Parameter Store y Secrets Manager solo lista los nombres).
set -uo pipefail
REGION="${1:-${AWS_REGION:-sa-east-1}}"
echo "== cuenta y región"
aws sts get-caller-identity --query '{cuenta:Account,identidad:Arn}' --output table || { echo "sin credenciales válidas: configura el perfil (runbook §1)" >&2; exit 1; }
echo "región consultada: ${REGION}"

t() { echo; echo "== $1"; }
q() { aws --region "${REGION}" "$@" 2>&1 | sed 's/^/  /'; }

t "VPC y red"
q ec2 describe-vpcs --query 'Vpcs[].{id:VpcId,cidr:CidrBlock,porDefecto:IsDefault,nombre:Tags[?Key==`Name`]|[0].Value}' --output table
q ec2 describe-subnets --query 'Subnets[].{id:SubnetId,vpc:VpcId,cidr:CidrBlock,az:AvailabilityZone,ipPublica:MapPublicIpOnLaunch}' --output table
q ec2 describe-route-tables --query 'RouteTables[].{id:RouteTableId,vpc:VpcId,rutas:length(Routes)}' --output table
q ec2 describe-internet-gateways --query 'InternetGateways[].{id:InternetGatewayId,vpc:Attachments[0].VpcId}' --output table
q ec2 describe-nat-gateways --query 'NatGateways[].{id:NatGatewayId,estado:State,subred:SubnetId}' --output table

t "Security groups (y quién puede entrar)"
q ec2 describe-security-groups --query 'SecurityGroups[].{id:GroupId,nombre:GroupName,vpc:VpcId,reglas:length(IpPermissions)}' --output table
echo "  -- reglas abiertas a Internet (0.0.0.0/0), si las hubiera:"
q ec2 describe-security-groups --query 'SecurityGroups[?length(IpPermissions[?IpRanges[?CidrIp==`0.0.0.0/0`]])>`0`].{id:GroupId,nombre:GroupName}' --output table

t "EC2"
q ec2 describe-instances --query 'Reservations[].Instances[].{id:InstanceId,tipo:InstanceType,estado:State.Name,subred:SubnetId,ipPublica:PublicIpAddress,nombre:Tags[?Key==`Name`]|[0].Value}' --output table
q ec2 describe-volumes --query 'Volumes[].{id:VolumeId,gib:Size,tipo:VolumeType,cifrado:Encrypted,estado:State}' --output table

t "RDS"
q rds describe-db-instances --query 'DBInstances[].{id:DBInstanceIdentifier,motor:Engine,version:EngineVersion,clase:DBInstanceClass,publica:PubliclyAccessible,cifrada:StorageEncrypted,multiAZ:MultiAZ,backupDias:BackupRetentionPeriod,estado:DBInstanceStatus}' --output table
q rds describe-db-snapshots --snapshot-type manual --query 'DBSnapshots[].{id:DBSnapshotIdentifier,origen:DBInstanceIdentifier,creada:SnapshotCreateTime}' --output table
echo "  -- versiones MariaDB 10.11 disponibles en la región (para fijar DbEngineVersion):"
# F18-03C: '10.11' entre comillas simples (cadena). Con acentos graves JMESPath lo toma como número y la consulta falla.
q rds describe-db-engine-versions --engine mariadb --query "DBEngineVersions[?starts_with(EngineVersion, '10.11')].EngineVersion" --output text

t "Balanceadores"
q elbv2 describe-load-balancers --query 'LoadBalancers[].{nombre:LoadBalancerName,dns:DNSName,esquema:Scheme,estado:State.Code}' --output table
q elbv2 describe-target-groups --query 'TargetGroups[].{nombre:TargetGroupName,puerto:Port,salud:HealthCheckPath}' --output table

t "Certificados ACM (regional y us-east-1 para CloudFront)"
q acm list-certificates --query 'CertificateSummaryList[].{arn:CertificateArn,dominio:DomainName,estado:Status}' --output table
aws --region us-east-1 acm list-certificates --query 'CertificateSummaryList[].{arn:CertificateArn,dominio:DomainName,estado:Status}' --output table 2>&1 | sed 's/^/  /'

t "S3, CloudFront y DNS (globales)"
aws s3api list-buckets --query 'Buckets[].Name' --output table 2>&1 | sed 's/^/  /'
aws cloudfront list-distributions --query 'DistributionList.Items[].{id:Id,dominio:DomainName,estado:Status}' --output table 2>&1 | sed 's/^/  /'
aws route53 list-hosted-zones --query 'HostedZones[].{id:Id,nombre:Name,registros:ResourceRecordSetCount}' --output table 2>&1 | sed 's/^/  /'

t "IAM (roles del proyecto)"
aws iam list-roles --query 'Roles[?starts_with(RoleName, `busperu`)].{nombre:RoleName,creado:CreateDate}' --output table 2>&1 | sed 's/^/  /'

t "Secretos y parámetros (SOLO nombres, nunca valores)"
q ssm describe-parameters --query 'Parameters[].{nombre:Name,tipo:Type,modificado:LastModifiedDate}' --output table
q secretsmanager list-secrets --query 'SecretList[].{nombre:Name,rotacion:RotationEnabled}' --output table

t "CloudWatch y CloudFormation"
q logs describe-log-groups --query 'logGroups[].{nombre:logGroupName,retencionDias:retentionInDays}' --output table
q cloudwatch describe-alarms --query 'MetricAlarms[].{nombre:AlarmName,estado:StateValue}' --output table
q cloudformation describe-stacks --query 'Stacks[].{nombre:StackName,estado:StackStatus,creada:CreationTime}' --output table

echo
echo "Inventario terminado. Nada se ha creado ni modificado."
