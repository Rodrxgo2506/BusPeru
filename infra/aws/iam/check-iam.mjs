// Comprobación local de las políticas de la identidad de despliegue (no llama a AWS).
//
//   node check-iam.mjs
//
// Falla con código 1 si alguna política rompe las reglas de F18-03D.
import { readFileSync, readdirSync } from 'node:fs';
import { politicas, JUSTIFICACION_COMODIN } from './build-iam.mjs';

const problemas = [];
const fallo = (m) => problemas.push(m);
const REGION = 'sa-east-1';
const lista = (v) => [].concat(v ?? []);
const LECTURA = /^[a-z0-9-]+:(Describe|Get|List)[A-Za-z]*\*$/;
const PERSONAS = /^iam:.*(User|Group|AccessKey|LoginProfile|MFADevice|SSHPublicKey|ServiceSpecificCredential|SigningCertificate|AccountAlias|PasswordPolicy)/;

for (const [nombre, doc] of Object.entries(politicas)) {
  if (nombre.startsWith('trust-policy')) continue;
  const caracteres = JSON.stringify(doc).length;
  if (caracteres > 6144) fallo(`${nombre}: ${caracteres} caracteres (máximo de IAM: 6144)`);
  for (const s of doc.Statement) {
    const id = `${nombre}/${s.Sid}`;
    if (!s.Sid) fallo(`${nombre}: declaración sin Sid`);
    if (s.Effect !== 'Allow') continue;
    const acciones = lista(s.Action);
    if (s.NotAction || s.NotResource) fallo(`${id}: Allow con NotAction/NotResource`);
    for (const a of acciones) {
      if (a === '*' || /:\*$/.test(a)) fallo(`${id}: acción comodín ${a}`);
      else if (a.includes('*') && !LECTURA.test(a)) fallo(`${id}: comodín en una acción que no es de lectura (${a})`);
      if (PERSONAS.test(a)) fallo(`${id}: permite administrar personas o credenciales (${a})`);
      if (/^(organizations|account):/.test(a)) fallo(`${id}: ${a} fuera de alcance`);
    }
    if (lista(s.Resource).includes('*') && !JUSTIFICACION_COMODIN[s.Sid]) fallo(`${id}: Resource "*" sin justificación documentada`);
    if (acciones.includes('iam:PassRole')) {
      if (lista(s.Resource).some((r) => r === '*' || /role\/\*$/.test(r))) fallo(`${id}: iam:PassRole demasiado amplio`);
      if (!s.Condition?.StringEquals?.['iam:PassedToService']) fallo(`${id}: iam:PassRole sin iam:PassedToService`);
    }
    for (const a of ['iam:CreateRole', 'iam:PutRolePolicy', 'iam:AttachRolePolicy']) {
      if (acciones.includes(a) && !s.Condition?.StringEquals?.['iam:PermissionsBoundary']) fallo(`${id}: ${a} sin exigir el límite de permisos`);
    }
    if (acciones.includes('iam:AttachRolePolicy') && !s.Condition?.ArnEquals?.['iam:PolicyARN']) fallo(`${id}: AttachRolePolicy sin limitar qué política`);
    if (acciones.includes('secretsmanager:GetSecretValue') && nombre !== 'BusPeruStagingWorkloadBoundary') fallo(`${id}: el despliegue no debe leer secretos`);
    // Única excepción KMS (F18-04): kms:DescribeKey, y solo cuando lo pide RDS en esta región.
    const describirViaRds = acciones.length === 1 && acciones[0] === 'kms:DescribeKey'
      && s.Condition?.StringEquals?.['kms:ViaService'] === `rds.${REGION}.amazonaws.com`;
    if (acciones.some((a) => a.startsWith('kms:')) && nombre !== 'BusPeruStagingWorkloadBoundary' && !describirViaRds) fallo(`${id}: permisos KMS en el rol de despliegue (solo se admite kms:DescribeKey vía RDS)`);
  }
}

// Barreras que deben existir en el núcleo.
const denegadas = politicas.BusPeruStagingDeployerPolicy.Statement.filter((s) => s.Effect === 'Deny').map((s) => s.Sid);
for (const sid of ['SoloSaoPaulo', 'NadaSobreLaVpcPorDefecto', 'NiLaVpcPorDefectoEnSi', 'SinAdministrarPersonasNiCredenciales', 'IntocableLaIdentidadDeDespliegue', 'NingunSecretoEnClaro',
  // F18-07 · la base original y sus copias
  'NoBorrarLaBaseOriginal', 'NoBorrarNiCompartirCopias', 'RestauracionesSiemprePrivadas',
  // F18-07B · la clave de cifrado y el secreto JWT no se pueden borrar
  'NoBorrarSecretosCriticos']) {
  if (!denegadas.includes(sid)) fallo(`Falta la barrera ${sid}`);
}
// F18-07 · la barrera de la base original tiene que apuntar EXACTAMENTE a ella (sin comodines): un
// `db:*` también bloquearía borrar las instancias temporales de las pruebas de restauración (F18-06).
{
  const base = politicas.BusPeruStagingDeployerPolicy.Statement.find((s) => s.Sid === 'NoBorrarLaBaseOriginal');
  if (base && (base.Condition || lista(base.Resource).length !== 1 || !/:db:busperu-staging-db$/.test(lista(base.Resource)[0]))) {
    fallo('NoBorrarLaBaseOriginal debe denegar sin condiciones y solo sobre db:busperu-staging-db');
  }
  const copias = politicas.BusPeruStagingDeployerPolicy.Statement.find((s) => s.Sid === 'NoBorrarNiCompartirCopias');
  for (const a of ['rds:DeleteDBSnapshot', 'rds:ModifyDBSnapshotAttribute', 'rds:DeleteDBInstanceAutomatedBackup']) {
    if (copias && !lista(copias.Action).includes(a)) fallo(`NoBorrarNiCompartirCopias debe incluir ${a}`);
  }
}

// F18-07B · exactamente esas dos acciones, sin condiciones, y solo sobre esos dos parámetros de app/.
{
  const s = politicas.BusPeruStagingDeployerPolicy.Statement.find((x) => x.Sid === 'NoBorrarSecretosCriticos');
  const recursos = lista(s?.Resource).map((r) => r.replace(/^arn:aws:ssm:[a-z0-9-]+:(\d{12}|\{\{ACCOUNT_ID\}\}):/, ''));
  if (s && (s.Condition || lista(s.Action).sort().join() !== 'ssm:DeleteParameter,ssm:DeleteParameters'
    || recursos.sort().join() !== 'parameter/busperu/*/app/INTEGRATIONS_ENCRYPTION_KEY,parameter/busperu/*/app/JWT_SECRET')) {
    fallo('NoBorrarSecretosCriticos debe denegar DeleteParameter(s), sin condiciones, sobre INTEGRATIONS_ENCRYPTION_KEY y JWT_SECRET de app/');
  }
}

// Confianza (vigente y con MFA): exactamente un principal, que es un usuario de ESTA cuenta.
for (const nombre of ['trust-policy']) {
  const trust = politicas[nombre];
  if (trust.Statement.length !== 1) fallo(`${nombre}: debe tener una sola declaración`);
  for (const s of trust.Statement) {
    const p = s.Principal?.AWS;
    if (s.Principal === '*' || p === '*' || lista(p).length !== 1) fallo(`${nombre}: el principal debe ser exactamente un usuario`);
    if (!/^arn:aws:iam::(\d{12}|\{\{ACCOUNT_ID\}\}):user\/[A-Za-z0-9+=,.@_-]+$/.test(lista(p)[0] ?? '')) fallo(`${nombre}: principal no permitido ${p}`);
    if (s.Action !== 'sts:AssumeRole') fallo(`${nombre}: solo sts:AssumeRole`);
  }
}
{
  // F18-07B · MFA obligatoria en la confianza del rol humano.
  const c = politicas['trust-policy'].Statement[0].Condition ?? {};
  if (c.Bool?.['aws:MultiFactorAuthPresent'] !== 'true' || !(Number(c.NumericLessThan?.['aws:MultiFactorAuthAge']) <= 3600)) {
    fallo('trust-policy: debe exigir aws:MultiFactorAuthPresent=true y aws:MultiFactorAuthAge < 3600');
  }
}

// El límite no puede dar IAM ni comodines.
for (const s of politicas.BusPeruStagingWorkloadBoundary.Statement) {
  for (const a of lista(s.Action)) if (a.startsWith('iam:') || a === '*' || /:\*$/.test(a)) fallo(`boundary/${s.Sid}: ${a}`);
}

// En el repositorio, la cuenta va siempre como marcador.
for (const f of readdirSync(new URL('./policies/', import.meta.url))) {
  const texto = readFileSync(new URL(`./policies/${f}`, import.meta.url), 'utf8');
  if (/\d{12}/.test(texto)) fallo(`policies/${f}: contiene un número de cuenta real`);
}

const total = Object.values(politicas).reduce((n, d) => n + d.Statement.length, 0);
console.log(`Políticas: ${Object.keys(politicas).length} · declaraciones: ${total}`);
if (problemas.length) { console.error(`✖ ${problemas.length} problema(s):\n - ${problemas.join('\n - ')}`); process.exit(1); }
console.log('✔ Identidad de despliegue conforme a las reglas de F18-03D.');
