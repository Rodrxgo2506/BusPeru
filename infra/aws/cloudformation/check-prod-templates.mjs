// BusPerú · F18-18 · comprobación local de las tres plantillas de PRODUCCIÓN (no llama a AWS). Sale con código 1
// si algo no cuadra.
//
//   node check-prod-templates.mjs
//
// 1) Referencias: todo Ref / GetAtt / Sub / If / DependsOn / Condition apunta a algo que existe.
// 2) Separación de entornos: ningún nombre, identificador, CIDR, dominio ni ruta de staging; todo nombre
//    explícito empieza por busperu-prod- (o /busperu/prod/); etiquetas Project=busperu y Environment=prod.
// 3) busperu-prod encaja en el rol BusPeruProdCloudFormationExecution: solo tipos de recurso que ese rol puede
//    crear, con los nombres que admiten sus políticas. No crea el rol de la app (ya existe), ni temas SNS, ni
//    nada de CloudFront.
// 4) Reglas de seguridad de staging (F18-03/03B), endurecidas para producción:
//    - RDS privada, cifrada con la CMK de producción, DeletionProtection fija, backups ≥ 7 días (14 por defecto);
//    - SG mínimos, sin 0.0.0.0/0 de entrada ni puerto 22, y ALB solo desde CloudFront en 443;
//    - listener HTTPS con 403 por defecto y una sola regla con la cabecera secreta;
//    - IMDSv2, sin SSH ni UserData, y protección contra terminación.
// 5) busperu-prod-web:
//    - bucket privado solo para la distribución web (OAC) y TLS;
//    - certificado de us-east-1, TLS 1.2 como mínimo y alias exactos;
//    - CSP sin scripts en línea ni eval, que además cubre todos los orígenes externos que usa el código;
//    - API sin caché ni páginas de error, con el origen solo por HTTPS.
// 6) busperu-prod-observability: filtros solo sobre /busperu/prod/app, alarmas al tema de producción y presupuesto.
// 7) busperu-prod-db-bootstrap (B-10): un único rol temporal y mínimo, asumible solo por el administrador con
//    MFA. El rol de la app conserva su Deny de Secrets Manager.
// 8) Coherencia entre las plantillas, y cada JSON escrito coincide con su generador.
import { readFileSync } from 'node:fs';
import prod, { VPC_CIDR, APP_ROLE, ALARM_TOPIC, ORIGIN_HEADER } from './build-prod-template.mjs';
import web, { CSP, API_ORIGIN, DOMINIO } from './build-prod-web-template.mjs';
import obs from './build-prod-observability-template.mjs';
import boot, { ACCIONES, BOOTSTRAP_SESSION, TUNEL } from './build-prod-db-bootstrap-template.mjs';

const problemas = [];
const fallo = (m) => problemas.push(m);
const pseudo = new Set(['AWS::Region', 'AWS::AccountId', 'AWS::StackName', 'AWS::NoValue', 'AWS::Partition', 'AWS::URLSuffix', 'AWS::StackId']);
const leer = (ruta) => readFileSync(new URL(ruta, import.meta.url), 'utf8');

// ------------------------------------------------------------------ 1. referencias
function referencias(nombre, t) {
  const R = t.Resources; const P = t.Parameters ?? {}; const C = t.Conditions ?? {};
  const recorrer = (nodo, ruta, subVars = new Set()) => {
    if (Array.isArray(nodo)) return nodo.forEach((n, i) => recorrer(n, `${ruta}[${i}]`, subVars));
    if (!nodo || typeof nodo !== 'object') return;
    for (const [k, v] of Object.entries(nodo)) {
      if (k === 'Ref' && typeof v === 'string' && !(v in P) && !(v in R) && !pseudo.has(v)) fallo(`${nombre} ${ruta}: Ref a "${v}" que no existe`);
      if (k === 'Fn::GetAtt' && !(v[0] in R)) fallo(`${nombre} ${ruta}: GetAtt a "${v[0]}" que no existe`);
      if (k === 'Fn::Sub') {
        const texto = typeof v === 'string' ? v : v[0];
        const vars = new Set(typeof v === 'string' ? [] : Object.keys(v[1]));
        for (const [, n] of texto.matchAll(/\$\{([^}!]+)\}/g)) {
          const base = n.split('.')[0];
          if (!(base in P) && !(base in R) && !pseudo.has(n) && !vars.has(n)) fallo(`${nombre} ${ruta}: Sub con \${${n}} que no existe`);
        }
      }
      if (k === 'Fn::If' && !(v[0] in C)) fallo(`${nombre} ${ruta}: If con condición "${v[0]}" que no existe`);
      recorrer(v, `${ruta}.${k}`, subVars);
    }
  };
  for (const [id, r] of Object.entries(R)) {
    recorrer(r.Properties ?? {}, `${id}`);
    for (const d of [].concat(r.DependsOn ?? [])) if (!(d in R)) fallo(`${nombre} ${id}: DependsOn a "${d}" que no existe`);
    if (r.Condition && !(r.Condition in C)) fallo(`${nombre} ${id}: Condition "${r.Condition}" que no existe`);
  }
  recorrer(t.Outputs ?? {}, 'Outputs');
  const plano = JSON.stringify({ R, O: t.Outputs, C });
  for (const p of Object.keys(P)) if (!plano.includes(`"${p}"`) && !plano.includes(`\${${p}}`)) fallo(`${nombre}: parámetro "${p}" sin usar`);
}

// ------------------------------------------------------------------ 2. separación de entornos
const PROHIBIDO = [
  ['la palabra staging', /staging/i],
  ['el CIDR de staging', /10\.20\./],
  ['una distribución de staging', /E2A2KY5BGZ8ZZQ|E1O34SN785WQBD|d25z2lpl1efut1|d1lfpi7fp62ntk/],
  ['la instancia de staging', /i-096d[0-9a-f]+/],
  ['un id de cuenta', /\b\d{12}\b/],
  ['un ARN de cuenta fijo', /arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:/],
  ['una IP pública literal', /\b(?!10\.|127\.|169\.254\.|0\.0\.0\.0)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
  ['una clave de acceso AWS', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['una llave de Culqi', /\b(sk|pk)_(live|test)_[0-9A-Za-z]{6,}/],
  ['una clave de Resend', /\bre_[0-9A-Za-z]{8,}/],
  ['una contraseña literal', /"(Master)?(User)?Password"\s*:\s*"/i],
];
const NOMBRES = ['BucketName', 'DBInstanceIdentifier', 'DBSubnetGroupName', 'DBParameterGroupName', 'InstanceProfileName', 'LaunchTemplateName', 'LogGroupName', 'AlarmName', 'FilterName', 'RoleName', 'TopicName'];
function separacion(nombre, t) {
  const plano = JSON.stringify(t);
  for (const [que, patron] of PROHIBIDO) if (patron.test(plano)) fallo(`${nombre}: contiene ${que} (${plano.match(patron)[0]})`);
  for (const [id, r] of Object.entries(t.Resources)) {
    const p = r.Properties ?? {};
    for (const campo of NOMBRES) {
      if (!(campo in p) || p[campo]?.Ref) continue;   // una referencia a otro recurso de la pila ya se comprueba ahí
      const v = typeof p[campo] === 'string' ? p[campo] : p[campo]['Fn::Sub'];
      if (typeof v !== 'string' || !(/^busperu-prod-/.test(v) || /^\/busperu\/prod\//.test(v))) fallo(`${nombre} ${id}.${campo}: nombre fuera de busperu-prod- (${JSON.stringify(p[campo])})`);
    }
    for (const campo of ['Name']) {
      if (typeof p[campo] === 'string' && !/^busperu-prod-/.test(p[campo])) fallo(`${nombre} ${id}.Name fuera de busperu-prod-: ${p[campo]}`);
    }
    const cfgNombre = p.OriginAccessControlConfig?.Name ?? p.CachePolicyConfig?.Name ?? p.ResponseHeadersPolicyConfig?.Name;
    if (cfgNombre && !/^busperu-prod-/.test(cfgNombre)) fallo(`${nombre} ${id}: nombre fuera de busperu-prod- (${cfgNombre})`);
    const etiquetas = p.Tags ?? p.TagSpecifications?.[0]?.Tags;
    if (Array.isArray(etiquetas)) {
      const e = Object.fromEntries(etiquetas.map((x) => [x.Key, x.Value]));
      if (e.Project !== 'busperu' || e.Environment !== 'prod') fallo(`${nombre} ${id}: etiquetas Project/Environment incorrectas`);
    }
  }
}

// ------------------------------------------------------------------ 3–4. busperu-prod
{
  const R = prod.Resources; const P = prod.Parameters;
  // Tipos que BusPeruProdCloudFormationExecution puede crear (exec-core/compute/data de infra/aws/iam/prod).
  const PERMITIDOS = new Set(['AWS::EC2::VPC', 'AWS::EC2::InternetGateway', 'AWS::EC2::VPCGatewayAttachment', 'AWS::EC2::Subnet', 'AWS::EC2::RouteTable', 'AWS::EC2::Route',
    'AWS::EC2::SubnetRouteTableAssociation', 'AWS::EC2::SecurityGroup', 'AWS::EC2::SecurityGroupEgress', 'AWS::EC2::SecurityGroupIngress', 'AWS::EC2::LaunchTemplate',
    'AWS::EC2::Instance', 'AWS::EC2::Volume', 'AWS::EC2::VolumeAttachment', 'AWS::RDS::DBSubnetGroup', 'AWS::RDS::DBParameterGroup', 'AWS::RDS::DBInstance',
    'AWS::IAM::InstanceProfile', 'AWS::IAM::Role', 'AWS::DLM::LifecyclePolicy', 'AWS::ElasticLoadBalancingV2::LoadBalancer', 'AWS::ElasticLoadBalancingV2::TargetGroup',
    'AWS::ElasticLoadBalancingV2::Listener', 'AWS::ElasticLoadBalancingV2::ListenerRule', 'AWS::S3::Bucket', 'AWS::S3::BucketPolicy', 'AWS::Logs::LogGroup', 'AWS::CloudWatch::Alarm']);
  for (const [id, r] of Object.entries(R)) if (!PERMITIDOS.has(r.Type)) fallo(`busperu-prod ${id}: el rol de ejecución no puede crear ${r.Type}`);

  // Nombres exactos que admiten las políticas del rol de ejecución.
  const db = R.Database.Properties;
  if (db.DBInstanceIdentifier !== 'busperu-prod-db') fallo('RDS: el identificador debe ser busperu-prod-db (NoBorrarLaBaseOriginal y RdsDeLaPila)');
  if (R.LoadBalancer.Properties.Name !== 'busperu-prod-alb') fallo('ALB: el nombre debe ser busperu-prod-alb (ElbDeLaPila)');
  if (R.TargetGroup.Properties.Name !== 'busperu-prod-api') fallo('Target group: el nombre debe ser busperu-prod-api (ElbDeLaPila)');
  if (!/^busperu-prod-artifacts-/.test(R.ArtifactsBucket.Properties.BucketName['Fn::Sub'])) fallo('Artefactos: el bucket debe ser busperu-prod-artifacts-* (BucketDeArtefactos)');
  const roles = Object.entries(R).filter(([, r]) => r.Type === 'AWS::IAM::Role');
  if (roles.length !== 1 || roles[0][0] !== 'DlmRole') fallo('IAM: el único rol que crea la pila es DlmRole (el de la app ya existe)');
  const dlm = R.DlmRole?.Properties ?? {};
  if ('RoleName' in dlm) fallo('DlmRole: sin RoleName, para que CloudFormation lo llame busperu-prod-DlmRole-… (PasarRolDeDlmSoloADlm)');
  if (!JSON.stringify(dlm.PermissionsBoundary ?? '').includes('policy/busperu/BusPeruProdWorkloadBoundary')) fallo('DlmRole: falta el límite BusPeruProdWorkloadBoundary');
  if (JSON.stringify(dlm.ManagedPolicyArns) !== JSON.stringify(['arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole']) || dlm.Policies) fallo('DlmRole: solo la política gestionada de DLM');
  const perfil = R.AppInstanceProfile?.Properties ?? {};
  if (JSON.stringify(perfil.Roles) !== JSON.stringify([APP_ROLE]) || !/^busperu-prod-/.test(perfil.InstanceProfileName ?? '')) fallo('Perfil de instancia: busperu-prod-* con el rol existente busperu-prod-app-role');
  for (const [id, r] of Object.entries(R).filter(([, r]) => r.Type === 'AWS::CloudWatch::Alarm')) {
    const acciones = JSON.stringify([r.Properties.AlarmActions, r.Properties.OKActions]);
    if (!acciones.includes(`:${ALARM_TOPIC}`)) fallo(`${id}: las alarmas deben ir al tema existente ${ALARM_TOPIC}`);
  }

  // Red
  if (R.Vpc.Properties.CidrBlock !== VPC_CIDR || VPC_CIDR !== '10.30.0.0/16') fallo('VPC: debe ser 10.30.0.0/16 (staging usa 10.20.0.0/16)');
  for (const s of ['PublicSubnetA', 'PublicSubnetB', 'PrivateSubnetA', 'PrivateSubnetB']) if (!R[s].Properties.CidrBlock.startsWith('10.30.')) fallo(`${s}: fuera de la VPC de producción`);
  for (const s of ['PrivateSubnetA', 'PrivateSubnetB']) if (R[s].Properties.MapPublicIpOnLaunch !== false) fallo(`${s}: asigna IP pública`);
  if (Object.values(R).some((r) => r.Type === 'AWS::EC2::Route' && JSON.stringify(r).includes('PrivateRouteTable'))) fallo('Las subredes privadas tienen rutas añadidas');
  if (JSON.stringify(R.DbSubnetGroup.Properties.SubnetIds).includes('Public')) fallo('RDS: el subnet group incluye subredes públicas');

  // Security groups
  for (const [id, r] of Object.entries(R).filter(([, r]) => r.Type === 'AWS::EC2::SecurityGroup')) {
    for (const regla of r.Properties.SecurityGroupIngress ?? []) {
      if (/0\.0\.0\.0\/0|::\/0/.test(JSON.stringify(regla))) fallo(`${id}: entrada abierta a Internet`);
      if (regla.FromPort <= 22 && regla.ToPort >= 22) fallo(`${id}: puerto 22 abierto`);
    }
    if (!r.Properties.SecurityGroupEgress) fallo(`${id}: sin SecurityGroupEgress conserva la salida por defecto (todo)`);
  }
  const albIn = R.AlbSecurityGroup.Properties.SecurityGroupIngress;
  if (albIn.length !== 1 || albIn[0].FromPort !== 443 || albIn[0].ToPort !== 443 || albIn[0].SourcePrefixListId?.Ref !== 'CloudFrontPrefixListId' || 'CidrIp' in albIn[0]) fallo('ALB SG: solo 443 desde la prefix list de CloudFront');
  const inerte = (reglas) => reglas.length === 1 && reglas[0].IpProtocol === '-1' && reglas[0].CidrIp === '127.0.0.1/32';
  if (!inerte(R.AlbSecurityGroup.Properties.SecurityGroupEgress) || !inerte(R.DbSecurityGroup.Properties.SecurityGroupEgress)) fallo('ALB/RDS SG: salida inline no inerte');
  const suelta = (g) => Object.values(R).filter((r) => r.Type === 'AWS::EC2::SecurityGroupEgress' && r.Properties.GroupId?.Ref === g);
  const a = suelta('AlbSecurityGroup');
  if (a.length !== 1 || a[0].Properties.FromPort !== 3000 || a[0].Properties.DestinationSecurityGroupId?.Ref !== 'AppSecurityGroup') fallo('ALB SG: debe salir solo hacia la API (3000)');
  const b = suelta('AppSecurityGroup');
  if (b.length !== 1 || b[0].Properties.FromPort !== 3306 || b[0].Properties.DestinationSecurityGroupId?.Ref !== 'DbSecurityGroup') fallo('App SG: 3306 solo hacia la base');
  if (suelta('DbSecurityGroup').length) fallo('RDS SG: no debe tener salida');
  for (const r of R.AppSecurityGroup.Properties.SecurityGroupEgress) {
    const ok = (r.IpProtocol === 'tcp' && r.FromPort === 443 && r.ToPort === 443) || (r.IpProtocol === 'udp' && r.FromPort === 123 && r.CidrIp === '169.254.169.123/32');
    if (!ok) fallo(`App SG: salida no justificada ${JSON.stringify(r)}`);
  }
  const appIn = R.AppSecurityGroup.Properties.SecurityGroupIngress;
  if (appIn.length !== 1 || appIn[0].SourceSecurityGroupId?.Ref !== 'AlbSecurityGroup' || appIn[0].FromPort !== 3000) fallo('App SG: la API solo desde el ALB');
  const dbIn = R.DbSecurityGroup.Properties.SecurityGroupIngress;
  if (dbIn.length !== 1 || dbIn[0].FromPort !== 3306 || dbIn[0].SourceSecurityGroupId?.Ref !== 'AppSecurityGroup') fallo('RDS SG: 3306 solo desde la EC2');

  // RDS
  if (db.Engine !== 'mariadb' || R.DbParameterGroup.Properties.Family !== 'mariadb10.11' || !/^\^10\\\.11/.test(P.DbEngineVersion.AllowedPattern)) fallo('RDS: debe ser MariaDB 10.11');
  if (db.PubliclyAccessible !== false || db.StorageEncrypted !== true) fallo('RDS: debe ser privada y cifrada');
  if (!JSON.stringify(db.KmsKeyId).includes('alias/busperu-prod-rds')) fallo('RDS: debe cifrarse con alias/busperu-prod-rds');
  if (db.DeletionProtection !== true) fallo('RDS: DeletionProtection debe ser true literal (no un parámetro)');
  if (db.ManageMasterUserPassword !== true || 'MasterUserPassword' in db) fallo('RDS: la contraseña maestra la gestiona RDS');
  if (P.DbBackupRetentionDays.Default < 14 || P.DbBackupRetentionDays.MinValue < 7) fallo('RDS: backups 14 días por defecto y nunca menos de 7');
  if (R.Database.DeletionPolicy !== 'Snapshot' || R.Database.UpdateReplacePolicy !== 'Snapshot') fallo('RDS: DeletionPolicy/UpdateReplacePolicy Snapshot');
  if (R.DbParameterGroup.Properties.Parameters.sql_mode !== 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION') fallo('RDS: sql_mode no estricto');
  if (db.AutoMinorVersionUpgrade !== false) fallo('RDS: la versión menor se cambia a propósito, no sola');

  // EC2 y datos
  const ec2 = R.AppInstance.Properties;
  if ('KeyName' in ec2 || 'UserData' in ec2) fallo('EC2: sin KeyName ni UserData');
  if (ec2.DisableApiTermination !== true) fallo('EC2: protección contra terminación');
  if (R.AppLaunchTemplate.Properties.LaunchTemplateData.MetadataOptions.HttpTokens !== 'required') fallo('EC2: IMDSv2 obligatorio');
  if (Object.values(R).filter((r) => r.Type === 'AWS::EC2::Instance').length !== 1) fallo('EC2: una sola instancia (limitador y planificador en memoria)');
  if (R.DataVolume.DeletionPolicy !== 'Snapshot' || R.DataVolume.Properties.Encrypted !== true) fallo('EBS de datos: cifrado y con Snapshot');
  if (R.DataSnapshotPolicy.Properties.PolicyDetails.Schedules[0].RetainRule.Count < 14) fallo('DLM: al menos 14 snapshots');
  const s3 = R.ArtifactsBucket.Properties.PublicAccessBlockConfiguration;
  if (Object.values(s3).some((v) => v !== true)) fallo('Artefactos: bloqueo público incompleto');

  // ALB
  const listeners = Object.values(R).filter((r) => r.Type === 'AWS::ElasticLoadBalancingV2::Listener');
  if (listeners.length !== 1 || listeners[0].Properties.Port !== 443 || listeners[0].Properties.Protocol !== 'HTTPS') fallo('ALB: un único listener HTTPS 443 (sin HTTP)');
  if (listeners[0]?.Properties.DefaultActions[0].FixedResponseConfig?.StatusCode !== '403') fallo('ALB: la acción por defecto debe ser 403');
  if (listeners[0]?.Properties.Certificates?.[0]?.CertificateArn?.Ref !== 'CertificateArn' || !P.CertificateArn.AllowedPattern.includes('sa-east-1')) fallo('ALB: certificado de sa-east-1 por parámetro');
  const reglas = Object.values(R).filter((r) => r.Type === 'AWS::ElasticLoadBalancingV2::ListenerRule');
  if (reglas.length !== 1 || reglas[0].Properties.Conditions[0].HttpHeaderConfig?.HttpHeaderName !== ORIGIN_HEADER || reglas[0].Properties.Conditions[0].HttpHeaderConfig.Values[0].Ref !== 'OriginVerifySecret') fallo('ALB: una sola regla, con la cabecera secreta de origen');
  if (P.OriginVerifySecret.NoEcho !== true) fallo('OriginVerifySecret debe ser NoEcho');
  const atributos = Object.fromEntries(R.LoadBalancer.Properties.LoadBalancerAttributes.map((x) => [x.Key, x.Value]));
  if (atributos['deletion_protection.enabled'] !== 'true' || atributos['routing.http.drop_invalid_header_fields.enabled'] !== 'true') fallo('ALB: protección contra borrado y descarte de cabeceras inválidas');
  if (R.TargetGroup.Properties.HealthCheckPath !== '/api/ready') fallo('ALB: health check en /api/ready');

  // Observabilidad mínima de §13 (F18-17)
  const alarmas = Object.values(R).filter((r) => r.Type === 'AWS::CloudWatch::Alarm').map((r) => r.Properties.MetricName);
  for (const m of ['UnHealthyHostCount', 'HTTPCode_Target_5XX_Count', 'TargetResponseTime', 'StatusCheckFailed', 'CPUUtilization', 'FreeStorageSpace', 'FreeableMemory', 'DatabaseConnections', 'disk_used_percent', 'mem_used_percent']) {
    if (!alarmas.includes(m)) fallo(`Falta la alarma de ${m}`);
  }
  if (R.AppLogGroup.Properties.LogGroupName !== '/busperu/prod/app' || R.AppLogGroup.DeletionPolicy !== 'Retain') fallo('Logs: /busperu/prod/app conservado');
}

// ------------------------------------------------------------------ 5. busperu-prod-web
{
  const R = web.Resources; const P = web.Parameters;
  const b = R.FrontendBucket.Properties;
  if (!/^busperu-prod-web-/.test(b.BucketName['Fn::Sub']) || Object.values(b.PublicAccessBlockConfiguration).some((v) => v !== true) || b.VersioningConfiguration?.Status !== 'Enabled') fallo('Web: bucket busperu-prod-web-* privado y versionado');
  const pol = R.FrontendBucketPolicy.Properties.PolicyDocument.Statement;
  const permite = pol.filter((s) => s.Effect === 'Allow');
  if (permite.length !== 1 || permite[0].Principal?.Service !== 'cloudfront.amazonaws.com' || !JSON.stringify(permite[0].Condition).includes('${WebDistribution}') || permite[0].Action !== 's3:GetObject') fallo('Web: el bucket solo lo lee la distribución web (OAC)');
  if (!pol.some((s) => s.Effect === 'Deny' && s.Condition?.Bool?.['aws:SecureTransport'] === 'false')) fallo('Web: falta el Deny sin TLS');
  if (!P.WebCertificateArn.AllowedPattern.includes('us-east-1')) fallo('Web: el certificado de CloudFront debe ser de us-east-1');
  if (!/^\^busperu-prod-alb-/.test(P.AlbDnsName.AllowedPattern)) fallo('Web: AlbDnsName solo admite el ALB de producción');
  if (P.OriginVerifySecret.NoEcho !== true) fallo('Web: OriginVerifySecret debe ser NoEcho');
  if (P.ViewerAccess.Default !== 'operators') fallo('Web: por defecto solo operadores (el público se abre en el go-live)');

  const wd = R.WebDistribution.Properties.DistributionConfig;
  const ad = R.ApiDistribution.Properties.DistributionConfig;
  if (JSON.stringify(wd.Aliases) !== JSON.stringify([DOMINIO, `www.${DOMINIO}`]) || JSON.stringify(ad.Aliases) !== JSON.stringify([`api.${DOMINIO}`])) fallo('Web: alias incorrectos');
  for (const [n, d] of [['web', wd], ['api', ad]]) {
    if (d.ViewerCertificate.MinimumProtocolVersion !== 'TLSv1.2_2021' || d.ViewerCertificate.SslSupportMethod !== 'sni-only' || d.ViewerCertificate.CloudFrontDefaultCertificate) fallo(`${n}: certificado propio, SNI y TLS 1.2`);
    if (!JSON.stringify(d.DefaultCacheBehavior.FunctionAssociations).includes('ViewerFunction')) fallo(`${n}: sin la función de visor`);
  }
  if (wd.DefaultCacheBehavior.ViewerProtocolPolicy !== 'redirect-to-https' || wd.DefaultCacheBehavior.ResponseHeadersPolicyId?.Ref !== 'WebSecurityHeaders') fallo('web: HTTPS y política de cabeceras propia');
  if (ad.DefaultCacheBehavior.ViewerProtocolPolicy !== 'https-only' || ad.CustomErrorResponses) fallo('api: solo HTTPS y sin páginas de error');
  const origen = ad.Origins[0];
  if (origen.CustomOriginConfig.OriginProtocolPolicy !== 'https-only' || JSON.stringify(origen.CustomOriginConfig.OriginSSLProtocols) !== '["TLSv1.2"]') fallo('api: origen solo HTTPS TLS 1.2');
  if (origen.OriginCustomHeaders?.[0]?.HeaderName !== ORIGIN_HEADER || origen.OriginCustomHeaders[0].HeaderValue.Ref !== 'OriginVerifySecret') fallo('api: falta la cabecera secreta de origen');
  const cache = R.ApiCachePolicy.Properties.CachePolicyConfig;
  if (cache.DefaultTTL !== 0 || cache.MaxTTL > 1 || !cache.ParametersInCacheKeyAndForwardedToOrigin.HeadersConfig.Headers.includes('Authorization')) fallo('api: sin caché y con Authorization');
  const codigo = R.ViewerFunction.Properties.FunctionCode['Fn::Sub'][0];
  if (!codigo.includes('statusCode: 403') || !codigo.includes(`www.${DOMINIO}`) || !codigo.includes('statusCode: 301')) fallo('Función de visor: debe redirigir www y filtrar IP');

  // CSP
  const cabeceras = R.WebSecurityHeaders.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig;
  if (cabeceras.ContentSecurityPolicy.ContentSecurityPolicy !== CSP) fallo('CSP: la política no es la exportada');
  if (cabeceras.StrictTransportSecurity.AccessControlMaxAgeSec < 31536000 || cabeceras.FrameOptions.FrameOption !== 'DENY') fallo('HSTS ≥ 1 año y X-Frame-Options DENY');
  const dir = Object.fromEntries(CSP.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  for (const [k, v] of [['default-src', "'self'"], ['object-src', "'none'"], ['frame-ancestors', "'none'"], ['base-uri', "'self'"], ['form-action', "'self'"]]) if (!dir[k]?.includes(v)) fallo(`CSP: ${k} debe incluir ${v}`);
  if (dir['script-src'].some((v) => /unsafe-(inline|eval)|\*|data:|blob:|http:/.test(v))) fallo("CSP: script-src sin 'unsafe-inline', 'unsafe-eval', comodines ni data:");
  if (!dir['connect-src'].includes(API_ORIGIN) || !dir['img-src'].includes(API_ORIGIN)) fallo('CSP: la API debe estar en connect-src e img-src');
  // Cada origen externo que usa el código debe estar permitido en su directiva.
  const raiz = '../../../frontend/';
  const permitido = (directiva, url) => {
    const host = new URL(url).host;
    return dir[directiva].some((v) => v === `https://${host}` || (v.startsWith('https://*.') && host.endsWith(v.slice('https://*'.length))));
  };
  const culqi = leer(`${raiz}src/services/culqi.ts`).match(/SCRIPT_URL = '([^']+)'/)?.[1];
  const commons = leer(`${raiz}src/constants/images.ts`).match(/COMMONS = '([^']+)'/)?.[1];
  const html = leer(`${raiz}index.html`);
  const hojas = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*href="(https:[^"]+)"/g)].map((m) => m[1]);
  const precon = [...html.matchAll(/rel="preconnect" href="(https:[^"]+)"/g)].map((m) => m[1]);
  if (!culqi || !permitido('script-src', culqi)) fallo(`CSP: script-src no permite Culqi (${culqi})`);
  if (!commons || !permitido('img-src', commons)) fallo(`CSP: img-src no permite las fotos de Commons (${commons})`);
  for (const h of hojas) if (!permitido('style-src', h)) fallo(`CSP: style-src no permite ${h}`);
  if (!precon.some((u) => permitido('font-src', u))) fallo('CSP: font-src no permite el origen de las fuentes');
  // F18-19 · el mapa embebido del perfil de empresa (iframe) debe estar permitido en frame-src.
  const mapa = leer(`${raiz}src/utils/company-profile.ts`).match(/return `(https:\/\/[a-z0-9.-]+)\/export\/embed\.html/)?.[1];
  if (!mapa || !permitido('frame-src', mapa)) fallo(`CSP: frame-src no permite el mapa embebido (${mapa})`);
  const externos = [...leer(`${raiz}src/services/culqi.ts`).matchAll(/https:\/\/[a-z0-9.-]+/g), ...html.matchAll(/https:\/\/[a-z0-9.-]+/g)].map((m) => new URL(m[0]).host);
  for (const h of new Set(externos)) {
    if (!['checkout.culqi.com', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(h)) fallo(`CSP: origen externo nuevo en el código sin revisar (${h})`);
  }
}

// ------------------------------------------------------------------ 6. busperu-prod-observability
{
  const R = obs.Resources;
  const filtros = Object.values(R).filter((r) => r.Type === 'AWS::Logs::MetricFilter');
  if (filtros.length < 5 || filtros.some((f) => f.Properties.LogGroupName !== prod.Resources.AppLogGroup.Properties.LogGroupName)) fallo('Observabilidad: filtros solo sobre el grupo de logs de busperu-prod');
  for (const f of filtros) if (!/^\{.*\}$/.test(f.Properties.FilterPattern)) fallo(`Observabilidad: patrón JSON inválido ${f.Properties.FilterPattern}`);
  for (const [id, r] of Object.entries(R).filter(([, r]) => r.Type === 'AWS::CloudWatch::Alarm')) if (!JSON.stringify(r.Properties.AlarmActions).includes(`:${ALARM_TOPIC}`)) fallo(`Observabilidad ${id}: tema de alarmas`);
  const presupuesto = Object.values(R).find((r) => r.Type === 'AWS::Budgets::Budget');
  if (!presupuesto || presupuesto.Properties.NotificationsWithSubscribers.length < 2) fallo('Observabilidad: falta el presupuesto con avisos');
  const tipos = new Set(Object.values(R).map((r) => r.Type));
  for (const t of tipos) if (!['AWS::Logs::MetricFilter', 'AWS::CloudWatch::Alarm', 'AWS::Budgets::Budget'].includes(t)) fallo(`Observabilidad: tipo no previsto ${t}`);
}

// ------------------------------------------------------------------ 6b. busperu-prod-db-bootstrap (B-10)
{
  const R = boot.Resources;
  const tipos = Object.values(R).map((r) => r.Type);
  if (JSON.stringify(tipos) !== '["AWS::IAM::Role"]') fallo('Bootstrap: solo un rol IAM');
  const rol = R.DbBootstrapRole?.Properties ?? {};
  if (rol.RoleName !== 'busperu-prod-db-bootstrap' || rol.MaxSessionDuration > 3600) fallo('Bootstrap: rol busperu-prod-db-bootstrap con sesiones de 1 h como máximo');
  if (rol.ManagedPolicyArns?.length) fallo('Bootstrap: sin políticas gestionadas');
  const confianza = rol.AssumeRolePolicyDocument.Statement;
  const c = confianza[0]?.Condition ?? {};
  if (confianza.length !== 1 || confianza[0].Action !== 'sts:AssumeRole' || !JSON.stringify(confianza[0].Principal).includes(':user/Rodrigo')
    || c.Bool?.['aws:MultiFactorAuthPresent'] !== 'true' || c.NumericLessThan?.['aws:MultiFactorAuthAge'] !== '3600' || c.StringEquals?.['sts:RoleSessionName'] !== BOOTSTRAP_SESSION) {
    fallo('Bootstrap: solo el administrador, con MFA < 1 h y sesión fija');
  }
  const decl = rol.Policies.flatMap((p) => p.PolicyDocument.Statement);
  const permitidas = new Set(Object.values(ACCIONES).flat());
  for (const s of decl.filter((d) => d.Effect === 'Allow')) {
    for (const a of [].concat(s.Action)) if (!permitidas.has(a) || a.includes('*')) fallo(`Bootstrap: acción no prevista ${a}`);
    const res = JSON.stringify(s.Resource);
    if ([].concat(s.Action).some((a) => a.startsWith('secretsmanager:')) && res !== '{"Ref":"MasterSecretArn"}') fallo('Bootstrap: Secrets Manager solo sobre el secreto maestro');
    if ([].concat(s.Action).includes('kms:Decrypt') && !JSON.stringify(s.Condition).includes('secretsmanager.')) fallo('Bootstrap: kms:Decrypt solo vía Secrets Manager');
    if ([].concat(s.Action).includes('ssm:StartSession') && (!res.includes('instance/${AppInstanceId}') || !res.includes(`document/${TUNEL}`) || res.includes('AWS-StartSSHSession') || res.includes('AWS-StartInteractiveCommand'))) fallo('Bootstrap: StartSession solo con el documento de túnel y solo en la instancia de producción');
    if (res === '"*"' && [].concat(s.Action).some((a) => !ACCIONES.lectura.includes(a))) fallo('Bootstrap: Resource "*" solo para lecturas');
  }
  const nada = decl.find((d) => d.Effect === 'Deny' && d.NotAction);
  if (!nada || JSON.stringify([...nada.NotAction].sort()) !== JSON.stringify([...permitidas].sort())) fallo('Bootstrap: falta el Deny de todo lo demás (NotAction)');
  if (!decl.some((d) => d.Effect === 'Deny' && [].concat(d.Action).includes('secretsmanager:PutSecretValue'))) fallo('Bootstrap: el secreto nunca se escribe desde aquí');
  if (!boot.Parameters.MasterSecretArn.AllowedPattern.includes('secret:rds!')) fallo('Bootstrap: el parámetro solo admite el secreto gestionado por RDS');
  // El rol de la EC2 (línea base) conserva su Deny de Secrets Manager: esta pila no lo toca.
  const appPol = JSON.parse(leer('../iam/prod/policies/app-policy.json'));
  if (!appPol.Statement.some((d) => d.Effect === 'Deny' && [].concat(d.Action).includes('secretsmanager:*'))) fallo('El rol de la app debe conservar Deny secretsmanager:* (B-10)');
  if (JSON.stringify(prod).includes('db-bootstrap')) fallo('busperu-prod no debe crear el rol de bootstrap');
}

// ------------------------------------------------------------------ 1, 2 y 7 para las tres
const nombresAlarma = [];
for (const [nombre, t, archivo] of [['busperu-prod', prod, './busperu-prod.json'], ['busperu-prod-web', web, './busperu-prod-web.json'], ['busperu-prod-observability', obs, './busperu-prod-observability.json'], ['busperu-prod-db-bootstrap', boot, './busperu-prod-db-bootstrap.json']]) {
  referencias(nombre, t);
  separacion(nombre, t);
  for (const r of Object.values(t.Resources)) if (r.Type === 'AWS::CloudWatch::Alarm') nombresAlarma.push(r.Properties.AlarmName);
  let escrito = null;
  try { escrito = leer(archivo); } catch { fallo(`Falta ${archivo}: ejecuta su build-*.mjs`); }
  if (escrito !== null && escrito !== `${JSON.stringify(t, null, 2)}\n`) fallo(`${archivo} no coincide con su generador: regenéralo`);
  const bytes = Buffer.byteLength(escrito ?? '');
  console.log(`${nombre.padEnd(28)} ${String(Object.keys(t.Resources).length).padStart(3)} recursos · ${String(Object.keys(t.Parameters ?? {}).length).padStart(2)} parámetros · ${bytes} bytes${bytes > 51200 ? ' (> 51 200: desplegar con --template-url desde S3)' : ''}`);
}
const repetidas = nombresAlarma.filter((n, i) => nombresAlarma.indexOf(n) !== i);
if (repetidas.length) fallo(`Nombres de alarma repetidos: ${repetidas}`);
if (web.Outputs.ApiUrl.Value !== `${API_ORIGIN}/api`) fallo('ApiUrl de busperu-prod-web no coincide con la CSP');

if (problemas.length) {
  console.error(`✖ ${problemas.length} problema(s):\n - ${problemas.join('\n - ')}`);
  process.exit(1);
}
console.log('✔ Plantillas de producción coherentes: separadas de staging, compatibles con el rol de ejecución, CSP alineada con el código.');
