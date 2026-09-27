// Comprobación local de la plantilla del frontend de staging (no llama a AWS). Código 1 si algo falla.
//
//   node check-web-template.mjs
//
// 1) Referencias: todo Ref / GetAtt / Sub / Condition apunta a algo que existe.
// 2) Reglas de F18-09: solo staging; bucket privado (BPA completo, sin lectura pública, solo la
//    distribución web por OAC); sin dominio ni certificado propio; HTTPS hacia el navegador; fallback
//    de SPA solo en la distribución web; la API sin caché (salvo /api/public/media/*, con clave sin
//    Authorization, cookies ni query) y sin páginas de error; el ALB solo gana la
//    prefix list de CloudFront en el 80 (ningún CIDR nuevo) y el oyente acaba en un 403; sin secretos.
// 3) Que el JSON escrito coincida con el generador.

import { readFileSync } from 'node:fs';
import template, { API_ERROR_CODES, API_MEDIA_PATH, APP_ROLE, MANAGED, MEDIA_DISTRIBUTION_PARAM, ORIGIN_HEADER } from './build-web-template.mjs';

const problemas = [];
const fallo = (m) => problemas.push(m);
const R = template.Resources;
const P = template.Parameters;
const C = template.Conditions ?? {};
const pseudo = new Set(['AWS::Region', 'AWS::AccountId', 'AWS::StackName', 'AWS::NoValue', 'AWS::Partition', 'AWS::URLSuffix']);

// ---------------------------------------------------------------------------- referencias
const existe = (n) => n in R || n in P || pseudo.has(n);
function recorrer(nodo, ruta, vars = new Set()) {
  if (Array.isArray(nodo)) return nodo.forEach((x, i) => recorrer(x, `${ruta}[${i}]`, vars));
  if (!nodo || typeof nodo !== 'object') return;
  for (const [k, v] of Object.entries(nodo)) {
    if (k === 'Ref' && !existe(v)) fallo(`${ruta}: Ref a ${v} inexistente`);
    else if (k === 'Fn::GetAtt' && !(v[0] in R)) fallo(`${ruta}: GetAtt a ${v[0]} inexistente`);
    else if (k === 'Fn::If' && !(v[0] in C)) fallo(`${ruta}: condición ${v[0]} inexistente`);
    else if (k === 'Fn::Sub') {
      const [texto, mapa] = Array.isArray(v) ? v : [v, {}];
      for (const m of texto.matchAll(/\$\{([^}!]+)\}/g)) {
        const base = m[1].split('.')[0];
        if (!(base in (mapa ?? {})) && !existe(base)) fallo(`${ruta}: Sub usa \${${m[1]}} inexistente`);
      }
      if (mapa) recorrer(mapa, `${ruta}.Sub`);
      continue;
    }
    recorrer(v, `${ruta}.${k}`);
  }
}
recorrer(template.Resources, 'Resources');
recorrer(template.Outputs, 'Outputs');
for (const [n, r] of Object.entries(R)) if (r.Condition && !(r.Condition in C)) fallo(`${n}: condición ${r.Condition} inexistente`);

// ---------------------------------------------------------------------------- reglas
const tipos = Object.values(R).map((r) => r.Type).sort();
const PERMITIDOS = new Set(['AWS::S3::Bucket', 'AWS::S3::BucketPolicy', 'AWS::CloudFront::OriginAccessControl', 'AWS::CloudFront::Function',
  'AWS::CloudFront::CachePolicy', 'AWS::CloudFront::Distribution', 'AWS::EC2::SecurityGroupIngress', 'AWS::ElasticLoadBalancingV2::ListenerRule',
  // Fase 3 · solo con las reglas de más abajo: una política IAM mínima y el parámetro SSM con el id de la distribución.
  'AWS::IAM::Policy', 'AWS::SSM::Parameter']);
for (const t of tipos) if (!PERMITIDOS.has(t)) fallo(`tipo de recurso no previsto: ${t}`);
if (JSON.stringify(P.EnvName.AllowedValues) !== '["staging"]') fallo('EnvName debe admitir solo staging');

const b = R.FrontendBucket.Properties;
const bpa = b.PublicAccessBlockConfiguration;
if (!bpa || !['BlockPublicAcls', 'BlockPublicPolicy', 'IgnorePublicAcls', 'RestrictPublicBuckets'].every((k) => bpa[k] === true)) fallo('bucket: Block Public Access incompleto');
if (b.WebsiteConfiguration) fallo('bucket: no debe ser un sitio web S3 público');
if (R.FrontendBucket.DeletionPolicy !== 'Retain') fallo('bucket: debe conservarse al borrar la pila');
for (const s of R.FrontendBucketPolicy.Properties.PolicyDocument.Statement) {
  if (s.Effect !== 'Allow') continue;
  if (JSON.stringify(s.Principal) !== '{"Service":"cloudfront.amazonaws.com"}') fallo(`bucket: ${s.Sid} concede a ${JSON.stringify(s.Principal)}`);
  if (s.Action !== 's3:GetObject') fallo(`bucket: ${s.Sid} concede ${s.Action}`);
  if (!JSON.stringify(s.Condition ?? {}).includes('distribution/${WebDistribution}')) fallo(`bucket: ${s.Sid} no se limita a la distribución web`);
}
const oac = R.FrontendOac.Properties.OriginAccessControlConfig;
if (oac.SigningBehavior !== 'always' || oac.SigningProtocol !== 'sigv4') fallo('OAC: debe firmar siempre con SigV4');

const web = R.WebDistribution.Properties.DistributionConfig;
const api = R.ApiDistribution.Properties.DistributionConfig;
for (const [n, d] of [['web', web], ['api', api]]) {
  if (d.Aliases) fallo(`${n}: sin dominio en F18-09 (Aliases prohibido)`);
  if (JSON.stringify(d.ViewerCertificate) !== '{"CloudFrontDefaultCertificate":true}') fallo(`${n}: solo el certificado por defecto de CloudFront`);
  if (!['redirect-to-https', 'https-only'].includes(d.DefaultCacheBehavior.ViewerProtocolPolicy)) fallo(`${n}: permite HTTP al navegador`);
  if (n === 'web' && d.CacheBehaviors) fallo(`${n}: comportamientos adicionales no previstos`);
}
// Fase 2 · la API tiene UN comportamiento adicional y solo uno: las imágenes públicas de /api/public/media/*.
const extras = api.CacheBehaviors ?? [];
if (extras.length !== 1) fallo(`api: se espera exactamente 1 comportamiento adicional (hay ${extras.length})`);
for (const b of extras) {
  if (b.PathPattern !== API_MEDIA_PATH) fallo(`api: comportamiento cacheable fuera de ${API_MEDIA_PATH} (${b.PathPattern})`);
  if (b.TargetOriginId !== 'api-alb') fallo('api/media: debe ir al mismo origen ALB (con la cabecera secreta)');
  if (b.ViewerProtocolPolicy !== 'https-only') fallo('api/media: solo HTTPS');
  if (JSON.stringify(b.AllowedMethods) !== '["GET","HEAD"]' || JSON.stringify(b.CachedMethods) !== '["GET","HEAD"]') fallo('api/media: solo GET y HEAD');
  if (JSON.stringify(b.CachePolicyId) !== '{"Ref":"ApiMediaCachePolicy"}') fallo('api/media: debe usar ApiMediaCachePolicy');
  if (b.OriginRequestPolicyId) fallo('api/media: sin política de petición al origen (no se reenvía Authorization ni cookies)');
  if (JSON.stringify(b.FunctionAssociations) !== JSON.stringify(api.DefaultCacheBehavior.FunctionAssociations)) fallo('api/media: debe tener la misma restricción de visitantes que el resto de la API');
}
const media = R.ApiMediaCachePolicy?.Properties.CachePolicyConfig;
if (!media) fallo('falta ApiMediaCachePolicy');
else {
  const k = media.ParametersInCacheKeyAndForwardedToOrigin;
  if (k.HeadersConfig.HeaderBehavior !== 'none' || k.HeadersConfig.Headers) fallo('api/media: ninguna cabecera (tampoco Authorization) en la clave de caché');
  if (k.CookiesConfig.CookieBehavior !== 'none') fallo('api/media: sin cookies en la clave de caché');
  if (k.QueryStringsConfig.QueryStringBehavior !== 'none') fallo('api/media: sin query string en la clave de caché');
  if (!(media.MaxTTL > 0 && media.MaxTTL <= 604800)) fallo(`api/media: MaxTTL en el borde entre 1 s y 7 días (hay ${media.MaxTTL})`);
}
// Fase 3 · invalidación: UNA política IAM, UNA acción, SOLO la distribución de la API, SOLO el rol de la app.
const iam = Object.entries(R).filter(([, r]) => r.Type.startsWith('AWS::IAM::'));
if (iam.length !== 1 || iam[0][0] !== 'ApiMediaInvalidationPolicy' || iam[0][1].Type !== 'AWS::IAM::Policy') fallo(`iam: solo se admite la política ApiMediaInvalidationPolicy (hay ${iam.map(([n, r]) => `${n}:${r.Type}`).join(', ')})`);
const inval = R.ApiMediaInvalidationPolicy?.Properties;
if (inval) {
  if (JSON.stringify(inval.Roles) !== JSON.stringify([{ 'Fn::Sub': APP_ROLE }])) fallo(`iam: la política solo va en el rol de la aplicación (${JSON.stringify(inval.Roles)})`);
  const st = inval.PolicyDocument.Statement;
  if (st.length !== 1 || st[0].Effect !== 'Allow' || st[0].NotAction || st[0].NotResource || st[0].Condition) fallo('iam: una sola declaración Allow, sin NotAction/NotResource');
  const acciones = [].concat(st[0].Action);
  if (acciones.length !== 1 || acciones[0] !== 'cloudfront:CreateInvalidation') fallo(`iam: solo cloudfront:CreateInvalidation (hay ${acciones.join(', ')})`);
  if (JSON.stringify(st[0].Resource) !== JSON.stringify({ 'Fn::Sub': 'arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${ApiDistribution}' })) fallo(`iam: el recurso debe ser exactamente la distribución de la API (${JSON.stringify(st[0].Resource)})`);
}
const param = R.ApiMediaDistributionIdParam?.Properties;
if (!param || R.ApiMediaDistributionIdParam.Type !== 'AWS::SSM::Parameter') fallo('falta el parámetro SSM con el id de la distribución de la API');
else {
  if (JSON.stringify(param.Name) !== JSON.stringify({ 'Fn::Sub': MEDIA_DISTRIBUTION_PARAM })) fallo(`ssm: nombre inesperado ${JSON.stringify(param.Name)}`);
  if (param.Type !== 'String') fallo('ssm: el id no es secreto, tipo String');
  if (JSON.stringify(param.Value) !== '{"Ref":"ApiDistribution"}') fallo('ssm: el valor debe ser el id de la distribución de la API (no la web)');
}
if (web.Origins.length !== 1 || !web.Origins[0].OriginAccessControlId || web.Origins[0].S3OriginConfig?.OriginAccessIdentity !== '') fallo('web: el único origen debe ser S3 con OAC');
const errores = (web.CustomErrorResponses ?? []).map((e) => `${e.ErrorCode}>${e.ResponseCode}${e.ResponsePagePath}`).sort().join();
if (errores !== '403>200/index.html,404>200/index.html') fallo(`web: fallback de SPA inesperado (${errores})`);
if (web.DefaultCacheBehavior.ResponseHeadersPolicyId !== MANAGED.securityHeaders) fallo('web: faltan las cabeceras de seguridad');
// F18-19B (F-01): cada error cacheable de la API con TTL 0 y SIN página de sustitución (un 403/404 de la API nunca
// puede convertirse en index.html ni guardarse 10 s en CloudFront).
const erroresApi = (api.CustomErrorResponses ?? []);
if (erroresApi.some((e) => e.ResponsePagePath || e.ResponseCode)) fallo('api: las páginas de error convertirían los errores de la API en index.html');
if (erroresApi.map((e) => `${e.ErrorCode}:${e.ErrorCachingMinTTL}`).sort().join() !== API_ERROR_CODES.map((c) => `${c}:0`).sort().join()) fallo(`api: los errores deben tener ErrorCachingMinTTL 0 (${JSON.stringify(erroresApi)})`);
if (api.Origins.length !== 1 || !api.Origins[0].CustomOriginConfig) fallo('api: el único origen debe ser el ALB');
const cabecera = api.Origins[0].OriginCustomHeaders ?? [];
if (cabecera.length !== 1 || cabecera[0].HeaderName !== ORIGIN_HEADER || JSON.stringify(cabecera[0].HeaderValue) !== '{"Ref":"OriginVerifySecret"}') fallo('api: la cabecera de origen debe salir del parámetro secreto');
if (JSON.stringify(api.DefaultCacheBehavior.CachePolicyId) !== '{"Ref":"ApiCachePolicy"}') fallo('api: debe usar la política sin caché');
// F18-11B: CloudFront reutiliza la conexión con el ALB, pero la cierra ANTES que el ALB (idle_timeout 60 s).
const keepalive = api.Origins[0].CustomOriginConfig?.OriginKeepaliveTimeout;
if (!(keepalive >= 30 && keepalive < 60)) fallo(`api: OriginKeepaliveTimeout debe estar entre 30 y 59 s (hay ${keepalive})`);
const cp = R.ApiCachePolicy.Properties.CachePolicyConfig;
if (cp.DefaultTTL !== 0 || cp.MinTTL !== 0 || cp.MaxTTL > 1) fallo('api: la política de caché no es «sin caché»');
if (!cp.ParametersInCacheKeyAndForwardedToOrigin.HeadersConfig.Headers.includes('Authorization')) fallo('api: Authorization no llegaría al origen');
if (!P.OriginVerifySecret.NoEcho) fallo('OriginVerifySecret debe ser NoEcho');

const ing = R.AlbFromCloudFront.Properties;
if (ing.CidrIp || ing.CidrIpv6 || !ing.SourcePrefixListId || ing.FromPort !== 80 || ing.ToPort !== 80) fallo('SG del ALB: solo la prefix list de CloudFront en el 80');
const reglas = Object.values(R).filter((r) => r.Type === 'AWS::ElasticLoadBalancingV2::ListenerRule').map((r) => r.Properties).sort((x, y) => x.Priority - y.Priority);
const ultima = reglas.at(-1);
if (ultima.Actions[0].Type !== 'fixed-response' || ultima.Actions[0].FixedResponseConfig.StatusCode !== '403' || JSON.stringify(ultima.Conditions[0].PathPatternConfig?.Values) !== '["*"]') fallo('oyente: la última regla debe ser un 403 para todo');
for (const r of reglas.slice(0, -1)) {
  if (r.Actions[0].Type !== 'forward') fallo(`oyente: la regla ${r.Priority} no reenvía`);
  const campo = r.Conditions[0].Field;
  if (campo === 'http-header' && JSON.stringify(r.Conditions[0].HttpHeaderConfig.Values) !== '[{"Ref":"OriginVerifySecret"}]') fallo('oyente: la cabecera debe compararse con el parámetro secreto');
  if (!['http-header', 'source-ip'].includes(campo)) fallo(`oyente: condición ${campo} no prevista`);
}

const texto = JSON.stringify(template);
if (/0\.0\.0\.0\/0|::\/0/.test(texto)) fallo('aparece 0.0.0.0/0 o ::/0');
if (/[0-9a-f]{40,}/i.test(texto.replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ''))) fallo('aparece algo que parece un secreto');
if (/busperuonline|\bprod\b|production/i.test(texto)) fallo('referencia a producción o al dominio real');
if (!C.RestrictViewers || !R.ViewerAllowlist || R.ViewerAllowlist.Condition !== 'RestrictViewers') fallo('falta la restricción opcional por IP');

// ---------------------------------------------------------------------------- JSON escrito
const escrito = readFileSync(new URL('./busperu-staging-web.json', import.meta.url), 'utf8');
if (escrito !== `${JSON.stringify(template, null, 2)}\n`) fallo('busperu-staging-web.json no coincide con el generador (ejecuta build-web-template.mjs)');
if (Buffer.byteLength(escrito) > 51200) fallo('la plantilla supera 51.200 bytes (habría que subirla a S3)');

if (problemas.length) {
  console.error(`FAIL · ${problemas.length} problema(s):`);
  for (const p of problemas) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`PASS · ${Object.keys(R).length} recursos (${[...new Set(tipos)].length} tipos) · referencias, bucket privado + OAC, HTTPS, fallback solo en la web, API sin caché salvo ${API_MEDIA_PATH} (clave sin Authorization), invalidación solo de la API y solo para el rol de la app, ALB con 403 final, sin secretos`);
