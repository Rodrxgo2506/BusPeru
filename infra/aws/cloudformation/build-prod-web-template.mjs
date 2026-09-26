// BusPerú · F18-18 · plantilla CloudFormation del BORDE de PRODUCCIÓN: pila `busperu-prod-web` (sa-east-1). SOLO
// SE GENERA.
//
//   node build-prod-web-template.mjs → escribe busperu-prod-web.json
//
// La despliega el administrador con MFA (como busperu-staging-web): el rol de ejecución de producción no tiene
// permisos de CloudFront ni del bucket del frontend. Va DESPUÉS de busperu-prod (necesita el DNS del ALB) y
// ANTES de tocar el DNS público.
//
// Qué crea:
//   · Bucket S3 PRIVADO busperu-prod-web-<cuenta> para dist/ (Block Public Access, SSE, versionado, solo TLS).
//     Solo lo lee la distribución web por OAC.
//   · Distribución WEB con alias busperuonline.pe y www.busperuonline.pe (certificado de us-east-1),
//     fallback de SPA y la política de cabeceras de seguridad CON CSP. La CSP se validó en F18-18 contra
//     staging con Chrome: 0 violaciones en 10 rutas y en Culqi Checkout v4, y el control positivo
//     (script en línea) quedó bloqueado.
//   · Distribución API con alias api.busperuonline.pe. Origen: el ALB de busperu-prod por HTTPS. Reenvía el
//     Host del visitante para que el ALB presente el certificado de api.busperuonline.pe (sa-east-1). No
//     cachea y no tiene páginas de error. Añade la cabecera secreta de origen.
//   · Una CloudFront Function de visor (las dos distribuciones): www → 301 al dominio raíz y, con
//     ViewerAccess=operators, 403 a cualquier IP fuera de la lista. Sirve para el humo previo al go-live
//     con el DNS ya apuntando.
//
// No crea certificados ni registros DNS. No contiene secretos: la cabecera de origen entra como NoEcho.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ORIGIN_HEADER } from './build-prod-template.mjs';

const ENV = 'prod';
const P = `busperu-${ENV}`;
const ref = (name) => ({ Ref: name });
const att = (resource, attribute) => ({ 'Fn::GetAtt': [resource, attribute] });
const sub = (text, vars) => ({ 'Fn::Sub': vars ? [text, vars] : text });
const tags = (name) => [
  { Key: 'Name', Value: `${P}-${name}` },
  { Key: 'Project', Value: 'busperu' },
  { Key: 'Environment', Value: ENV },
];

// Políticas gestionadas de CloudFront (identificadores fijos publicados por AWS).
export const MANAGED = {
  cachingOptimized: '658327ea-f89d-4fab-a63d-7e88639e58f6',
  allViewer: '216adef6-5c7f-47e4-b989-5492eafa07d3',
};

export const DOMINIO = 'busperuonline.pe';
export const API_ORIGIN = `https://api.${DOMINIO}`;

/**
 * CSP del SPA. Cada origen externo está justificado por el código:
 *   · script-src  checkout.culqi.com         → Culqi Checkout v4 (frontend/src/services/culqi.ts)
 *   · frame-src   checkout[view].culqi.com   → ventana de pago de Culqi (iframe checkoutview)
 *   · style-src   fonts.googleapis.com, 'unsafe-inline' → hoja de Google Fonts (index.html) y estilos que
 *                 inyectan Culqi y las bibliotecas de gráficos. Solo estilos: los scripts en línea siguen bloqueados.
 *   · font-src    fonts.gstatic.com          → fuente Inter
 *   · img-src     la API (logotipos, destinos, favicon), *.wikimedia.org (fotos de Commons, redirigen a
 *                 thumb/upload), *.culqi.com (logotipos del formulario de pago), data:
 *   · connect-src la API
 * frame-ancestors 'none': nadie puede incrustar BusPerú. La API tiene su propia CSP (Helmet).
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' https://checkout.culqi.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  `img-src 'self' data: ${API_ORIGIN} https://*.wikimedia.org https://*.culqi.com`,
  `connect-src 'self' ${API_ORIGIN}`,
  'frame-src https://checkout.culqi.com https://checkoutview.culqi.com',
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

const BUCKET_ARN = sub('arn:${AWS::Partition}:s3:::${FrontendBucket}');

// CloudFront Functions (cloudfront-js-2.0). ${Modo} = operators | public; ${Lista} = IPv4 permitidas.
const CODIGO_VISOR = [
  'function handler(event) {',
  '  var req = event.request;',
  `  if (req.headers.host && req.headers.host.value === 'www.${DOMINIO}') {`,
  `    return { statusCode: 301, statusDescription: 'Moved Permanently', headers: { location: { value: 'https://${DOMINIO}' + req.uri } } };`,
  '  }',
  "  if ('${Modo}' === 'operators' && ['${Lista}'].indexOf(event.viewer.ip) === -1) {",
  "    return { statusCode: 403, statusDescription: 'Forbidden' };",
  '  }',
  '  return req;',
  '}',
].join('\n');

const template = {
  AWSTemplateFormatVersion: '2010-09-09',
  Description: 'BusPeru PRODUCCION (F18-18): frontend S3 privado + CloudFront (OAC, CSP) y la API por CloudFront hacia el ALB de busperu-prod',
  Parameters: {
    WebCertificateArn: {
      Type: 'String',
      AllowedPattern: '^arn:aws:acm:us-east-1:[0-9]{12}:certificate/[0-9a-f-]{36}$',
      Description: `Certificado ACM en us-east-1 (ISSUED) con ${DOMINIO}, www.${DOMINIO} y api.${DOMINIO}`,
    },
    AlbDnsName: { Type: 'String', AllowedPattern: '^busperu-prod-alb-[0-9]+\\.sa-east-1\\.elb\\.amazonaws\\.com$', Description: 'Salida LoadBalancerDns de busperu-prod' },
    OriginVerifySecret: { Type: 'String', NoEcho: true, AllowedPattern: '^[0-9a-f]{64}$', Description: 'La misma cabecera secreta de origen que en busperu-prod' },
    ViewerAccess: { Type: 'String', AllowedValues: ['operators', 'public'], Default: 'operators', Description: 'operators: solo ViewerAllowedIps (humo previo al go-live); public: abierto (go-live)' },
    ViewerAllowedIps: { Type: 'CommaDelimitedList', Default: '', Description: 'IPv4 exactas del operador cuando ViewerAccess=operators (vacía = nadie pasa)' },
  },
  Resources: {
    FrontendBucket: {
      Type: 'AWS::S3::Bucket',
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: {
        BucketName: sub(`${P}-web-\${AWS::AccountId}`),
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
        OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
        BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
        VersioningConfiguration: { Status: 'Enabled' },
        LifecycleConfiguration: { Rules: [{ Id: 'versiones-antiguas', Status: 'Enabled', NoncurrentVersionExpiration: { NoncurrentDays: 90 } }] },
        Tags: tags('web'),
      },
    },
    FrontendBucketPolicy: {
      Type: 'AWS::S3::BucketPolicy',
      Properties: {
        Bucket: ref('FrontendBucket'),
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'SoloLaDistribucionWebLee',
              Effect: 'Allow',
              Principal: { Service: 'cloudfront.amazonaws.com' },
              Action: 's3:GetObject',
              Resource: sub('arn:${AWS::Partition}:s3:::${FrontendBucket}/*'),
              Condition: { StringEquals: { 'AWS:SourceArn': sub('arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${WebDistribution}') } },
            },
            {
              Sid: 'SoloTls',
              Effect: 'Deny',
              Principal: '*',
              Action: 's3:*',
              Resource: [BUCKET_ARN, sub('arn:${AWS::Partition}:s3:::${FrontendBucket}/*')],
              Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            },
          ],
        },
      },
    },
    FrontendOac: {
      Type: 'AWS::CloudFront::OriginAccessControl',
      Properties: {
        OriginAccessControlConfig: {
          Name: `${P}-web-oac`,
          Description: 'BusPeru prod: CloudFront firma las lecturas del bucket del frontend',
          OriginAccessControlOriginType: 's3',
          SigningBehavior: 'always',
          SigningProtocol: 'sigv4',
        },
      },
    },
    ViewerFunction: {
      Type: 'AWS::CloudFront::Function',
      Properties: {
        Name: `${P}-viewer`,
        AutoPublish: true,
        FunctionConfig: { Comment: 'BusPeru prod: www a dominio raiz y lista de IP antes del go-live', Runtime: 'cloudfront-js-2.0' },
        FunctionCode: sub(CODIGO_VISOR, { Modo: ref('ViewerAccess'), Lista: { 'Fn::Join': ["','", ref('ViewerAllowedIps')] } }),
      },
    },
    WebSecurityHeaders: {
      Type: 'AWS::CloudFront::ResponseHeadersPolicy',
      Properties: {
        ResponseHeadersPolicyConfig: {
          Name: `${P}-web-security`,
          Comment: 'BusPeru prod: CSP, HSTS y cabeceras de seguridad del SPA',
          SecurityHeadersConfig: {
            ContentSecurityPolicy: { ContentSecurityPolicy: CSP, Override: true },
            StrictTransportSecurity: { AccessControlMaxAgeSec: 31536000, IncludeSubdomains: true, Preload: false, Override: true },
            ContentTypeOptions: { Override: true },
            FrameOptions: { FrameOption: 'DENY', Override: true },
            ReferrerPolicy: { ReferrerPolicy: 'strict-origin-when-cross-origin', Override: true },
          },
          CustomHeadersConfig: {
            Items: [{ Header: 'Permissions-Policy', Value: 'camera=(), microphone=(), geolocation=(), usb=()', Override: true }],
          },
        },
      },
    },
    ApiCachePolicy: {
      Type: 'AWS::CloudFront::CachePolicy',
      Properties: {
        CachePolicyConfig: {
          Name: `${P}-api-sin-cache`,
          Comment: 'La API no se cachea (TTL 0, tope 1 s); Authorization llega al origen',
          MinTTL: 0,
          DefaultTTL: 0,
          MaxTTL: 1,
          ParametersInCacheKeyAndForwardedToOrigin: {
            EnableAcceptEncodingGzip: true,
            EnableAcceptEncodingBrotli: true,
            HeadersConfig: { HeaderBehavior: 'whitelist', Headers: ['Authorization'] },
            CookiesConfig: { CookieBehavior: 'none' },
            QueryStringsConfig: { QueryStringBehavior: 'all' },
          },
        },
      },
    },
    WebDistribution: {
      Type: 'AWS::CloudFront::Distribution',
      Properties: {
        DistributionConfig: {
          Enabled: true,
          Comment: `${P}-web (SPA)`,
          Aliases: [DOMINIO, `www.${DOMINIO}`],
          PriceClass: 'PriceClass_All',
          HttpVersion: 'http2and3',
          IPV6Enabled: true,
          DefaultRootObject: 'index.html',
          Origins: [{
            Id: 'frontend-s3',
            DomainName: att('FrontendBucket', 'RegionalDomainName'),
            OriginAccessControlId: att('FrontendOac', 'Id'),
            S3OriginConfig: { OriginAccessIdentity: '' },
          }],
          DefaultCacheBehavior: {
            TargetOriginId: 'frontend-s3',
            ViewerProtocolPolicy: 'redirect-to-https',
            AllowedMethods: ['GET', 'HEAD'],
            CachedMethods: ['GET', 'HEAD'],
            CachePolicyId: MANAGED.cachingOptimized,
            ResponseHeadersPolicyId: ref('WebSecurityHeaders'),
            Compress: true,
            FunctionAssociations: [{ EventType: 'viewer-request', FunctionARN: att('ViewerFunction', 'FunctionARN') }],
          },
          CustomErrorResponses: [403, 404].map((ErrorCode) => ({ ErrorCode, ResponseCode: 200, ResponsePagePath: '/index.html', ErrorCachingMinTTL: 0 })),
          ViewerCertificate: { AcmCertificateArn: ref('WebCertificateArn'), SslSupportMethod: 'sni-only', MinimumProtocolVersion: 'TLSv1.2_2021' },
        },
        Tags: tags('web-cdn'),
      },
    },
    ApiDistribution: {
      Type: 'AWS::CloudFront::Distribution',
      Properties: {
        DistributionConfig: {
          Enabled: true,
          Comment: `${P}-api (ALB)`,
          Aliases: [`api.${DOMINIO}`],
          PriceClass: 'PriceClass_All',
          HttpVersion: 'http2and3',
          IPV6Enabled: true,
          Origins: [{
            Id: 'api-alb',
            DomainName: ref('AlbDnsName'),
            // Igual que staging (F18-11B): 55 s de keepalive, por debajo del idle_timeout del ALB (60 s).
            CustomOriginConfig: { HTTPSPort: 443, OriginProtocolPolicy: 'https-only', OriginSSLProtocols: ['TLSv1.2'], OriginReadTimeout: 30, OriginKeepaliveTimeout: 55 },
            OriginCustomHeaders: [{ HeaderName: ORIGIN_HEADER, HeaderValue: ref('OriginVerifySecret') }],
          }],
          DefaultCacheBehavior: {
            TargetOriginId: 'api-alb',
            ViewerProtocolPolicy: 'https-only',
            AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'],
            CachedMethods: ['GET', 'HEAD'],
            CachePolicyId: ref('ApiCachePolicy'),
            // Reenvía también Host: el ALB presenta el certificado de api.busperuonline.pe y CloudFront lo valida.
            OriginRequestPolicyId: MANAGED.allViewer,
            Compress: true,
            FunctionAssociations: [{ EventType: 'viewer-request', FunctionARN: att('ViewerFunction', 'FunctionARN') }],
          },
          ViewerCertificate: { AcmCertificateArn: ref('WebCertificateArn'), SslSupportMethod: 'sni-only', MinimumProtocolVersion: 'TLSv1.2_2021' },
        },
        Tags: tags('api-cdn'),
      },
    },
  },
  Outputs: {
    WebUrl: { Description: 'FRONTEND_URL', Value: `https://${DOMINIO}` },
    ApiUrl: { Description: 'VITE_API_URL del build', Value: `${API_ORIGIN}/api` },
    FrontendBucketName: { Value: ref('FrontendBucket') },
    WebDistributionId: { Value: ref('WebDistribution') },
    ApiDistributionId: { Value: ref('ApiDistribution') },
    WebDistributionDomain: { Value: att('WebDistribution', 'DomainName'), Description: `Destino de los alias A/AAAA de ${DOMINIO} y www` },
    ApiDistributionDomain: { Value: att('ApiDistribution', 'DomainName'), Description: `Destino de los alias A/AAAA de api.${DOMINIO}` },
  },
};

export default template;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const destino = new URL('./busperu-prod-web.json', import.meta.url);
  const json = `${JSON.stringify(template, null, 2)}\n`;
  writeFileSync(destino, json);
  console.log(`busperu-prod-web.json · ${Object.keys(template.Resources).length} recursos · ${Buffer.byteLength(json)} bytes`);
}
