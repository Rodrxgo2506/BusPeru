// Comprobación local de la plantilla del frontend de staging (no llama a AWS). Código 1 si algo falla.
//
//   node check-web-template.mjs
//
// 1) Referencias: todo Ref / GetAtt / Sub / Condition apunta a algo que existe.
// 2) Reglas de F18-09: solo staging; bucket privado (BPA completo, sin lectura pública, solo la
//    distribución web por OAC); sin dominio ni certificado propio; HTTPS hacia el navegador; fallback
//    de SPA solo en la distribución web; la API sin caché y sin páginas de error; el ALB solo gana la
//    prefix list de CloudFront en el 80 (ningún CIDR nuevo) y el oyente acaba en un 403; sin secretos.
// 3) Que el JSON escrito coincida con el generador.

import { readFileSync } from 'node:fs';
import template, { MANAGED, ORIGIN_HEADER } from './build-web-template.mjs';

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
  'AWS::CloudFront::CachePolicy', 'AWS::CloudFront::Distribution', 'AWS::EC2::SecurityGroupIngress', 'AWS::ElasticLoadBalancingV2::ListenerRule']);
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
  if (d.CacheBehaviors) fallo(`${n}: comportamientos adicionales no previstos`);
}
if (web.Origins.length !== 1 || !web.Origins[0].OriginAccessControlId || web.Origins[0].S3OriginConfig?.OriginAccessIdentity !== '') fallo('web: el único origen debe ser S3 con OAC');
const errores = (web.CustomErrorResponses ?? []).map((e) => `${e.ErrorCode}>${e.ResponseCode}${e.ResponsePagePath}`).sort().join();
if (errores !== '403>200/index.html,404>200/index.html') fallo(`web: fallback de SPA inesperado (${errores})`);
if (web.DefaultCacheBehavior.ResponseHeadersPolicyId !== MANAGED.securityHeaders) fallo('web: faltan las cabeceras de seguridad');
if (api.CustomErrorResponses) fallo('api: las páginas de error convertirían los 403/404 de la API en index.html');
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
console.log(`PASS · ${Object.keys(R).length} recursos (${[...new Set(tipos)].length} tipos) · referencias, bucket privado + OAC, HTTPS, fallback solo en la web, API sin caché, ALB con 403 final, sin secretos`);
