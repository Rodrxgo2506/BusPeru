// Comprobación local de la plantilla (no llama a AWS). Falla con código 1 si algo no cuadra.
//
//   node check-template.mjs
//
// 1) Referencias: todo Ref / GetAtt / Sub / DependsOn / Condition apunta a algo que existe.
// 2) Reglas de F18-03: RDS privada y cifrada, MariaDB 10.11, modo estricto, sin SSH ni 22, sin
//    0.0.0.0/0 de entrada, 3306 solo desde la EC2, API solo desde el ALB, IMDSv2, sin UserData ni
//    KeyName, health check en /api/ready, sin nada que parezca un secreto.
// 3) F18-03B: salidas de los SG (EC2 solo 443 / hora / 3306 a la base; ALB solo 3000 a la EC2;
//    RDS sin salida), conectividad de la EC2 demostrada (subred con IP pública → tabla → 0.0.0.0/0 →
//    Internet Gateway de su VPC) e IAM mínimo (sin políticas gestionadas amplias, sin comodines, y
//    Resource "*" solo en acciones que no admiten recurso y con sus condiciones).
// 4) Que el JSON escrito coincida con el generador (nadie lo editó a mano).

import { readFileSync } from 'node:fs';
import template from './build-template.mjs';

const problemas = [];
const fallo = (m) => problemas.push(m);
const R = template.Resources;
const P = template.Parameters;
const C = template.Conditions ?? {};
const APP_PORT = 3000;
const pseudo = new Set(['AWS::Region', 'AWS::AccountId', 'AWS::StackName', 'AWS::NoValue', 'AWS::Partition', 'AWS::URLSuffix', 'AWS::StackId']);

// ----------------------------------------------------------- referencias
function recorrer(nodo, ruta) {
  if (Array.isArray(nodo)) return nodo.forEach((n, i) => recorrer(n, `${ruta}[${i}]`));
  if (!nodo || typeof nodo !== 'object') return;
  for (const [k, v] of Object.entries(nodo)) {
    if (k === 'Ref' && typeof v === 'string' && !(v in P) && !(v in R) && !pseudo.has(v)) fallo(`${ruta}: Ref a "${v}" que no existe`);
    if (k === 'Fn::GetAtt' && !(v[0] in R)) fallo(`${ruta}: GetAtt a "${v[0]}" que no existe`);
    if (k === 'Fn::Sub') {
      const texto = typeof v === 'string' ? v : v[0];
      for (const [, nombre] of texto.matchAll(/\$\{([^}!]+)\}/g)) {
        const base = nombre.split('.')[0];
        if (!(base in P) && !(base in R) && !pseudo.has(nombre)) fallo(`${ruta}: Sub con \${${nombre}} que no existe`);
      }
    }
    if (k === 'Fn::If' && !(v[0] in C)) fallo(`${ruta}: If con condición "${v[0]}" que no existe`);
    recorrer(v, `${ruta}.${k}`);
  }
}
for (const [id, r] of Object.entries(R)) {
  recorrer(r.Properties ?? {}, id);
  for (const d of [].concat(r.DependsOn ?? [])) if (!(d in R)) fallo(`${id}: DependsOn a "${d}" que no existe`);
  if (r.Condition && !(r.Condition in C)) fallo(`${id}: Condition "${r.Condition}" que no existe`);
}
recorrer(template.Outputs, 'Outputs');
recorrer(template.Conditions, 'Conditions');
for (const p of Object.keys(P)) {
  if (!JSON.stringify({ R, O: template.Outputs, C }).includes(`"${p}"`) && !JSON.stringify(R).includes(`\${${p}}`)) fallo(`Parámetro "${p}" sin usar`);
}

// ------------------------------------------------------ reglas de seguridad
const db = R.Database?.Properties ?? {};
if (db.Engine !== 'mariadb') fallo('RDS: el motor debe ser mariadb');
if (!new RegExp(P.DbEngineVersion.AllowedPattern).test(P.DbEngineVersion.Default)) fallo('RDS: versión por defecto fuera de 10.11');
if (!/^\^10\\\.11/.test(P.DbEngineVersion.AllowedPattern)) fallo('RDS: el patrón de versión debe limitar a 10.11');
if (db.PubliclyAccessible !== false) fallo('RDS: PubliclyAccessible debe ser false');
if (db.StorageEncrypted !== true) fallo('RDS: almacenamiento sin cifrar');
if (db.ManageMasterUserPassword !== true || 'MasterUserPassword' in db) fallo('RDS: la contraseña maestra debe gestionarla RDS en Secrets Manager');
if (R.Database?.DeletionPolicy !== 'Snapshot') fallo('RDS: falta DeletionPolicy Snapshot');
if (R.DataVolume?.DeletionPolicy !== 'Snapshot') fallo('EBS de datos: falta DeletionPolicy Snapshot');
if (R.DataVolume?.Properties?.Encrypted !== true) fallo('EBS de datos sin cifrar');
const modo = R.DbParameterGroup?.Properties?.Parameters?.sql_mode;
if (modo !== 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION') fallo(`RDS: sql_mode inesperado (${modo})`);
if (R.DbParameterGroup?.Properties?.Family !== 'mariadb10.11') fallo('RDS: familia del parameter group distinta de mariadb10.11');
const subredesDb = JSON.stringify(R.DbSubnetGroup?.Properties?.SubnetIds);
if (subredesDb.includes('Public')) fallo('RDS: el subnet group incluye subredes públicas');
for (const s of ['PrivateSubnetA', 'PrivateSubnetB']) if (R[s].Properties.MapPublicIpOnLaunch !== false) fallo(`${s}: asigna IP pública`);
const rutasPrivadas = Object.values(R).filter((r) => r.Type === 'AWS::EC2::Route' && JSON.stringify(r).includes('PrivateRouteTable'));
if (rutasPrivadas.length) fallo('Las subredes privadas tienen rutas añadidas');

for (const [id, r] of Object.entries(R).filter(([, r]) => r.Type === 'AWS::EC2::SecurityGroup')) {
  for (const regla of r.Properties.SecurityGroupIngress ?? []) {
    const texto = JSON.stringify(regla);
    if (texto.includes('0.0.0.0/0') || texto.includes('::/0')) fallo(`${id}: entrada abierta a Internet`);
    if (regla.FromPort <= 22 && regla.ToPort >= 22) fallo(`${id}: puerto 22 abierto`);
  }
}
// F18-04 · los orígenes permitidos hacia el ALB nunca pueden ser Internet entero.
for (const nombre of ['AllowedIngressCidr', 'AllowedIngressCidr2']) {
  const patron = P[nombre] && new RegExp(P[nombre].AllowedPattern);
  if (!patron) { fallo(`Falta el parámetro ${nombre}`); continue; }
  for (const abierto of ['0.0.0.0/0', '0.0.0.0/1', '10.0.0.0/8']) if (patron.test(abierto)) fallo(`${nombre}: el patrón admite ${abierto}`);
  if (!patron.test('203.0.113.7/32')) fallo(`${nombre}: el patrón no admite una IP/32`);
}
if (P.AllowedIngressCidr2 && P.AllowedIngressCidr2.Default !== '') fallo('AllowedIngressCidr2 debe ser opcional (vacío por defecto)');
const origenesAlb = JSON.stringify(R.AlbSecurityGroup.Properties.SecurityGroupIngress);
if ((origenesAlb.match(/"CidrIp"/g) ?? []).length !== 4 || /"CidrIp":"/.test(origenesAlb)) fallo('ALB SG: las reglas de entrada deben usar solo AllowedIngressCidr y AllowedIngressCidr2');

const ingresoDb = R.DbSecurityGroup.Properties.SecurityGroupIngress;
if (ingresoDb.length !== 1 || ingresoDb[0].FromPort !== 3306 || ingresoDb[0].SourceSecurityGroupId?.Ref !== 'AppSecurityGroup') fallo('RDS SG: 3306 debe venir solo del SG de la aplicación');
const ingresoApp = R.AppSecurityGroup.Properties.SecurityGroupIngress;
if (ingresoApp.length !== 1 || ingresoApp[0].SourceSecurityGroupId?.Ref !== 'AlbSecurityGroup') fallo('App SG: la API debe recibir solo desde el ALB');

// --------------------------------------------- F18-03B · salidas de los security groups
// Un SG de CloudFormation sin SecurityGroupEgress conserva la regla por defecto de AWS (todo).
const egresoInline = (id) => R[id].Properties.SecurityGroupEgress;
const egresoSuelto = (id) => Object.entries(R).filter(([, r]) => r.Type === 'AWS::EC2::SecurityGroupEgress' && r.Properties.GroupId?.Ref === id);
const inerte = (reglas) => reglas.length === 1 && reglas[0].IpProtocol === '-1' && reglas[0].CidrIp === '127.0.0.1/32';
for (const id of ['AlbSecurityGroup', 'AppSecurityGroup', 'DbSecurityGroup']) {
  if (!egresoInline(id)) fallo(`${id}: sin SecurityGroupEgress conserva la salida por defecto de AWS (todo abierto)`);
  for (const regla of egresoInline(id) ?? []) if (regla.IpProtocol === '-1' && regla.CidrIp !== '127.0.0.1/32') fallo(`${id}: salida de todos los protocolos hacia ${JSON.stringify(regla.CidrIp)}`);
}
if (!inerte(egresoInline('AlbSecurityGroup') ?? [])) fallo('ALB SG: su única salida debe ser AlbToAppEgress');
const albSale = egresoSuelto('AlbSecurityGroup');
if (albSale.length !== 1 || albSale[0][1].Properties.FromPort !== APP_PORT || albSale[0][1].Properties.DestinationSecurityGroupId?.Ref !== 'AppSecurityGroup') fallo('ALB SG: debe salir solo hacia la API (3000 → App SG)');
if (!inerte(egresoInline('DbSecurityGroup') ?? []) || egresoSuelto('DbSecurityGroup').length) fallo('RDS SG: no debe tener salida');
const salidaApp = egresoInline('AppSecurityGroup') ?? [];
const salidaAppPermitida = (r) => (r.IpProtocol === 'tcp' && r.FromPort === 443 && r.ToPort === 443) || (r.IpProtocol === 'udp' && r.FromPort === 123 && r.CidrIp === '169.254.169.123/32');
for (const r of salidaApp) if (!salidaAppPermitida(r)) fallo(`App SG: salida no justificada ${JSON.stringify(r)}`);
const appSale = egresoSuelto('AppSecurityGroup');
if (appSale.length !== 1 || appSale[0][1].Properties.FromPort !== 3306 || appSale[0][1].Properties.DestinationSecurityGroupId?.Ref !== 'DbSecurityGroup') fallo('App SG: 3306 debe salir solo hacia el SG de la base');

// ------------------------------- F18-03B · la EC2 tiene salida a Internet (demostrado)
// Se sigue la cadena real: instancia → subred con IP pública → tabla de rutas asociada →
// ruta 0.0.0.0/0 → Internet Gateway adjunto a la MISMA VPC. Sin NAT no hay otra vía.
{
  const subred = R.AppInstance.Properties.SubnetId?.Ref;
  const props = R[subred]?.Properties ?? {};
  if (props.MapPublicIpOnLaunch !== true) fallo(`Conectividad: la subred de la EC2 (${subred}) no asigna IP pública y no hay NAT`);
  const tablas = Object.values(R).filter((r) => r.Type === 'AWS::EC2::SubnetRouteTableAssociation' && r.Properties.SubnetId?.Ref === subred).map((r) => r.Properties.RouteTableId?.Ref);
  const rutaInternet = Object.values(R).find((r) => r.Type === 'AWS::EC2::Route' && tablas.includes(r.Properties.RouteTableId?.Ref) && r.Properties.DestinationCidrBlock === '0.0.0.0/0' && r.Properties.GatewayId?.Ref);
  const igw = rutaInternet?.Properties.GatewayId.Ref;
  const adjunto = Object.values(R).some((r) => r.Type === 'AWS::EC2::VPCGatewayAttachment' && r.Properties.InternetGatewayId?.Ref === igw && r.Properties.VpcId?.Ref === props.VpcId?.Ref);
  if (!rutaInternet || R[igw]?.Type !== 'AWS::EC2::InternetGateway' || !adjunto) fallo('Conectividad: la subred de la EC2 no tiene ruta 0.0.0.0/0 a un Internet Gateway adjunto a su VPC');
  if (R.AppInstance.Properties.NetworkInterfaces?.some((n) => n.AssociatePublicIpAddress === false)) fallo('Conectividad: la EC2 desactiva la IP pública');
  const nacl = Object.values(R).filter((r) => r.Type === 'AWS::EC2::NetworkAclEntry');
  if (nacl.length) fallo('Hay NACL propias: revisar que no corten 443 de salida ni los puertos efímeros de vuelta');
}

// ------------------------------------------------------------- F18-03B · IAM mínimo
const GESTIONADAS_PERMITIDAS = new Set(['arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole']);
// Acciones sin permisos a nivel de recurso: son las únicas que pueden ir con Resource "*".
const SIN_RECURSO = new Set(['ssm:UpdateInstanceInformation', 'ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel', 'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel', 'cloudwatch:PutMetricData', 'kms:Decrypt']);
const declaraciones = [];
for (const [id, r] of Object.entries(R)) {
  if (r.Type === 'AWS::IAM::Role') {
    for (const arn of r.Properties.ManagedPolicyArns ?? []) if (!GESTIONADAS_PERMITIDAS.has(arn)) fallo(`${id}: política gestionada no permitida ${arn}`);
    for (const p of r.Properties.Policies ?? []) declaraciones.push(...p.PolicyDocument.Statement.map((s) => [id, s]));
  }
  if (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy') declaraciones.push(...r.Properties.PolicyDocument.Statement.map((s) => [id, s]));
}
for (const [id, s] of declaraciones) {
  if (s.Effect !== 'Allow') continue;
  const acciones = [].concat(s.Action);
  for (const a of acciones) if (a === '*' || /:\*$/.test(a) || a.includes('*')) fallo(`${id}: acción comodín ${a}`);
  if ([].concat(s.Resource).includes('*')) {
    for (const a of acciones) if (!SIN_RECURSO.has(a)) fallo(`${id}: ${a} sobre Resource "*" (debe limitarse a un recurso)`);
    if (acciones.includes('kms:Decrypt') && !(s.Condition?.StringEquals?.['kms:ViaService'] && s.Condition?.StringLike?.['kms:EncryptionContext:PARAMETER_ARN'])) fallo(`${id}: kms:Decrypt sin limitar al servicio y a los parámetros del entorno`);
    if (acciones.includes('cloudwatch:PutMetricData') && !s.Condition?.StringEquals?.['cloudwatch:namespace']) fallo(`${id}: PutMetricData sin limitar el espacio de nombres`);
  }
  if (acciones.some((a) => /^ssm:GetParameter/.test(a)) && !JSON.stringify(s.Resource).includes('parameter/busperu/')) fallo(`${id}: lectura de parámetros fuera de /busperu/`);
  if (acciones.some((a) => /^iam:|^sts:AssumeRole$/.test(a))) fallo(`${id}: la instancia no debe poder tocar IAM`);
}

// F18-03D: todo rol de la pila lleva el límite de permisos que exige el rol de despliegue.
for (const [id, r] of Object.entries(R).filter(([, r]) => r.Type === 'AWS::IAM::Role')) {
  if (!JSON.stringify(r.Properties.PermissionsBoundary ?? '').includes('policy/busperu/BusPeruStagingWorkloadBoundary')) fallo(`${id}: falta el límite de permisos BusPeruStagingWorkloadBoundary`);
}
const etiquetasLt = JSON.stringify(R.AppLaunchTemplate?.Properties?.TagSpecifications ?? []);
if (!etiquetasLt.includes('"launch-template"') || !etiquetasLt.includes('"Project"')) fallo('AppLaunchTemplate: sin etiquetas propias (el rol de despliegue las exige)');

const ec2 = R.AppInstance.Properties;
if ('KeyName' in ec2) fallo('EC2: no debe tener KeyName (sin SSH)');
if ('UserData' in ec2) fallo('EC2: no debe llevar UserData (los secretos no viajan ahí)');
if (R.AppLaunchTemplate.Properties.LaunchTemplateData.MetadataOptions.HttpTokens !== 'required') fallo('EC2: IMDSv2 no obligatorio');
if (R.TargetGroup.Properties.HealthCheckPath !== '/api/ready') fallo('ALB: el health check debe ser /api/ready');
if (R.HttpValidationListener?.Condition !== 'NoCertificate') fallo('ALB: el listener HTTP de validación debe existir solo sin certificado');
if (R.HttpsListener?.Condition !== 'HasCertificate') fallo('ALB: el listener HTTPS debe depender del certificado');
const s3 = R.ArtifactsBucket.Properties.PublicAccessBlockConfiguration;
if (!s3 || Object.values(s3).some((v) => v !== true)) fallo('S3: el bloqueo de acceso público no es total');

// ------------------------------------------------ valores que AWS valida al crear (F18-04)
// El change set no los comprueba: fallan en plena creación y hacen retroceder la pila entera.
const DLM_TEXTO = /^[0-9A-Za-z _-]{1,500}$/;                        // Description y Schedules[].Name de DLM
const SG_TEXTO = /^[a-zA-Z0-9. _\-:/()#,@[\]+=&;{}!$*]{0,255}$/;  // descripciones de security groups y sus reglas
for (const [id, r] of Object.entries(R)) {
  const p = r.Properties ?? {};
  if (r.Type === 'AWS::DLM::LifecyclePolicy') {
    if (!DLM_TEXTO.test(p.Description ?? '')) fallo(`${id}: Description de DLM fuera de [0-9A-Za-z _-]`);
    for (const s of p.PolicyDetails?.Schedules ?? []) if (!DLM_TEXTO.test(s.Name ?? '')) fallo(`${id}: nombre de programación de DLM fuera de [0-9A-Za-z _-]`);
  }
  const textosSg = [];
  if (r.Type === 'AWS::EC2::SecurityGroup') {
    textosSg.push(p.GroupDescription);
    for (const regla of [...(p.SecurityGroupIngress ?? []), ...(p.SecurityGroupEgress ?? [])]) {
      recorrerTexto(regla, (k, v) => { if (k === 'Description') textosSg.push(v); });
    }
  }
  if (r.Type === 'AWS::EC2::SecurityGroupIngress' || r.Type === 'AWS::EC2::SecurityGroupEgress') textosSg.push(p.Description);
  for (const t of textosSg) if (typeof t === 'string' && !SG_TEXTO.test(t)) fallo(`${id}: descripción de security group con caracteres no admitidos: "${t}"`);
}
function recorrerTexto(nodo, f) {
  if (!nodo || typeof nodo !== 'object') return;
  for (const [k, v] of Object.entries(nodo)) { if (typeof v === 'string') f(k, v); else recorrerTexto(v, f); }
}

const plano = JSON.stringify(template);
for (const [nombre, patron] of [
  ['clave de acceso AWS', /AKIA[0-9A-Z]{16}/],
  ['contraseña literal', /"(Master)?(User)?Password"\s*:\s*"/i],
  ['llave de Culqi', /sk_(live|test)_[0-9a-zA-Z]{8,}/],
  ['llave de Resend', /re_[0-9a-zA-Z]{16,}/],
]) if (patron.test(plano)) fallo(`La plantilla contiene algo que parece un secreto: ${nombre}`);

// ------------------------------------------------ JSON escrito == generador
let escrito = null;
try { escrito = readFileSync(new URL('./busperu-staging.json', import.meta.url), 'utf8'); } catch { fallo('Falta busperu-staging.json: ejecuta node build-template.mjs'); }
if (escrito !== null && escrito !== `${JSON.stringify(template, null, 2)}\n`) fallo('busperu-staging.json no coincide con el generador: regenéralo');
const bytes = Buffer.byteLength(escrito ?? '');
if (bytes > 51200) console.log(`Aviso: ${bytes} bytes; por encima de 51 200 hay que subir la plantilla a S3 (--s3-bucket) para desplegarla.`);

console.log(`Recursos: ${Object.keys(R).length} · parámetros: ${Object.keys(P).length} · salidas: ${Object.keys(template.Outputs).length} · ${bytes} bytes`);
if (problemas.length) {
  console.error(`✖ ${problemas.length} problema(s):\n - ${problemas.join('\n - ')}`);
  process.exit(1);
}
console.log('✔ Plantilla coherente y conforme a las reglas de F18-03.');
