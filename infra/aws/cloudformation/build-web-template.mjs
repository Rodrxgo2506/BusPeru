// BusPerú · F18-09 · plantilla CloudFormation del FRONTEND de STAGING sin dominio (pila aparte).
//
//   node build-web-template.mjs   → escribe busperu-staging-web.json
//   node check-web-template.mjs   → comprueba referencias y reglas de seguridad
//
// Por qué una pila aparte de busperu-staging: no toca ningún recurso de la pila principal (solo le
// AÑADE una entrada al SG del ALB y tres reglas al oyente, que se van al borrar esta pila) y la
// plantilla principal ya roza el límite de 51.200 bytes.
//
// Qué crea (sin dominio: se usan los nombres *.cloudfront.net y su certificado por defecto):
//   · Bucket S3 PRIVADO para `dist/` (Block Public Access, cifrado, versionado, solo TLS). Solo lo lee
//     la distribución web por Origin Access Control (OAC, SigV4 siempre).
//   · Distribución WEB: S3 + OAC, HTTP→HTTPS, fallback de SPA (403/404 → /index.html con 200) y
//     cabeceras de seguridad gestionadas.
//   · Distribución API: origen el ALB (HTTP, el ALB de staging no tiene certificado), solo HTTPS
//     hacia el navegador, SIN caché y SIN páginas de error. Va aparte porque las páginas de error de
//     CloudFront son de toda la distribución: con la API dentro, sus 403/404 llegarían como index.html.
//     Sin ella el SPA (HTTPS) no podría llamar a un ALB HTTP (contenido mixto) y la guarda del build
//     rechaza VITE_API_URL con http.
//     Única excepción cacheable: `/api/public/media/*` (fotos públicas de destinos, logos y marca). Su URL lleva
//     un nombre aleatorio que no se reutiliza y el origen ya responde `immutable`; se cachea en el borde con una
//     política propia SIN Authorization, cookies ni query string en la clave, y solo GET/HEAD. El resto de /api/*
//     sigue sin caché.
//   · Fase 3 · invalidación de esa caché al retirar una imagen: la API (rol busperu-staging-app-role) puede
//     pedir `cloudfront:CreateInvalidation` SOLO sobre la distribución de la API, y su id le llega por SSM
//     (/busperu/staging/app/CDN_MEDIA_DISTRIBUTION_ID, que lee render-env.sh). El límite de permisos del rol
//     (BusPeruStagingWorkloadBoundary, infra/aws/iam) admite esa única acción. Actualizar la pila exige
//     `--capabilities CAPABILITY_IAM`.
//   · El ALB sigue sin ser público: su SG admite además la prefix list de CloudFront (solo puerto 80) y
//     el oyente reenvía SOLO si llega la cabecera secreta de origen que pone la distribución API, o si
//     viene de las IP de operador ya aprobadas; todo lo demás recibe 403.
//   · Opcional (ViewerAccess=operators): una CloudFront Function limita ambas distribuciones a las IP
//     de operador, como el ALB de staging hoy.
//
// No contiene ningún secreto: el valor de la cabecera de origen entra como parámetro NoEcho.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ref = (name) => ({ Ref: name });
const att = (resource, attribute) => ({ 'Fn::GetAtt': [resource, attribute] });
const sub = (text, vars) => ({ 'Fn::Sub': vars ? [text, vars] : text });
const iff = (condition, yes, no) => ({ 'Fn::If': [condition, yes, no] });
const noValue = { Ref: 'AWS::NoValue' };
const tags = (name) => [
  { Key: 'Name', Value: sub(`busperu-\${EnvName}-${name}`) },
  { Key: 'Project', Value: 'busperu' },
  { Key: 'Environment', Value: ref('EnvName') },
];

// Políticas gestionadas de CloudFront (identificadores fijos publicados por AWS).
export const MANAGED = {
  cachingOptimized: '658327ea-f89d-4fab-a63d-7e88639e58f6',
  securityHeaders: '67f7725c-6f97-4210-82d7-5512b31e9d03',
  allViewerExceptHost: 'b689b0a8-53d0-40ab-baf2-68738e2966ac',
};
export const ORIGIN_HEADER = 'X-BusPeru-Origin';
/** Fase 2 · único camino de la API que CloudFront puede guardar: imágenes públicas con nombre inmutable. */
export const API_MEDIA_PATH = '/api/public/media/*';
/** Fase 3 · rol con el que corre la API (pila principal) y parámetro por el que recibe el id de la distribución. */
export const APP_ROLE = 'busperu-${EnvName}-app-role';
export const MEDIA_DISTRIBUTION_PARAM = '/busperu/${EnvName}/app/CDN_MEDIA_DISTRIBUTION_ID';
/**
 * F18-19B (F-01) · códigos de error que CloudFront guarda por defecto (ErrorCachingMinTTL 10 s) aunque la política
 * de caché sea TTL 0. En las distribuciones de la API se fijan a 0 s, sin página de sustitución.
 */
export const API_ERROR_CODES = [400, 403, 404, 405, 414, 416, 500, 501, 502, 503, 504];

const BUCKET_ARN = sub('arn:${AWS::Partition}:s3:::${FrontendBucket}');
const funcion = iff('RestrictViewers', [{ EventType: 'viewer-request', FunctionARN: att('ViewerAllowlist', 'FunctionARN') }], noValue);

// CloudFront Functions (cloudfront-js-2.0): 403 a cualquier IP que no esté en la lista.
const CODIGO_LISTA = [
  'function handler(event) {',
  "  var permitidas = ['${Lista}'];",
  '  if (permitidas.indexOf(event.viewer.ip) === -1) {',
  "    return { statusCode: 403, statusDescription: 'Forbidden' };",
  '  }',
  '  return event.request;',
  '}',
].join('\n');

const template = {
  AWSTemplateFormatVersion: '2010-09-09',
  Description: 'BusPeru F18-09 - frontend de staging sin dominio: S3 privado + CloudFront (OAC) y la API por CloudFront hacia el ALB',
  Parameters: {
    EnvName: { Type: 'String', AllowedValues: ['staging'], Default: 'staging', Description: 'Solo staging: esta pila no se usa en produccion' },
    AlbDnsName: { Type: 'String', AllowedPattern: '^busperu-staging-alb-[0-9]+\\.[a-z0-9-]+\\.elb\\.amazonaws\\.com$', Description: 'DNS del ALB de busperu-staging' },
    AlbSecurityGroupId: { Type: 'AWS::EC2::SecurityGroup::Id', Description: 'SG del ALB de busperu-staging' },
    ListenerArn: { Type: 'String', AllowedPattern: '^arn:aws:elasticloadbalancing:[a-z0-9-]+:[0-9]{12}:listener/app/busperu-staging-alb/.+$', Description: 'Oyente HTTP:80 del ALB' },
    TargetGroupArn: { Type: 'String', AllowedPattern: '^arn:aws:elasticloadbalancing:[a-z0-9-]+:[0-9]{12}:targetgroup/.+$', Description: 'Grupo de destino de la API' },
    OperatorCidrs: { Type: 'CommaDelimitedList', Description: 'CIDR /32 de operador ya aprobados en el SG del ALB' },
    CloudFrontPrefixListId: { Type: 'String', AllowedPattern: '^pl-[0-9a-f]+$', Description: 'com.amazonaws.global.cloudfront.origin-facing en esta region' },
    OriginVerifySecret: { Type: 'String', NoEcho: true, AllowedPattern: '^[0-9a-f]{64}$', Description: 'Valor de la cabecera secreta de origen (32 bytes en hex)' },
    ViewerAccess: { Type: 'String', AllowedValues: ['operators', 'public'], Default: 'operators', Description: 'operators: solo las IP de ViewerAllowedIps; public: cualquiera' },
    ViewerAllowedIps: { Type: 'CommaDelimitedList', Description: 'IPv4 exactas permitidas cuando ViewerAccess=operators' },
  },
  Conditions: {
    RestrictViewers: { 'Fn::Equals': [ref('ViewerAccess'), 'operators'] },
  },
  Resources: {
    FrontendBucket: {
      Type: 'AWS::S3::Bucket',
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: {
        BucketName: sub('busperu-${EnvName}-web-${AWS::AccountId}'),
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
        OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
        BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
        VersioningConfiguration: { Status: 'Enabled' },
        LifecycleConfiguration: { Rules: [{ Id: 'versiones-antiguas', Status: 'Enabled', NoncurrentVersionExpiration: { NoncurrentDays: 30 } }] },
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
          Name: sub('busperu-${EnvName}-web-oac'),
          Description: 'BusPeru staging: CloudFront firma las lecturas del bucket del frontend',
          OriginAccessControlOriginType: 's3',
          SigningBehavior: 'always',
          SigningProtocol: 'sigv4',
        },
      },
    },
    ViewerAllowlist: {
      Type: 'AWS::CloudFront::Function',
      Condition: 'RestrictViewers',
      Properties: {
        Name: sub('busperu-${EnvName}-viewer-allowlist'),
        AutoPublish: true,
        FunctionConfig: { Comment: 'BusPeru staging: solo IP de operador', Runtime: 'cloudfront-js-2.0' },
        FunctionCode: sub(CODIGO_LISTA, { Lista: { 'Fn::Join': ["','", ref('ViewerAllowedIps')] } }),
      },
    },
    ApiCachePolicy: {
      Type: 'AWS::CloudFront::CachePolicy',
      Properties: {
        CachePolicyConfig: {
          Name: sub('busperu-${EnvName}-api-sin-cache'),
          Comment: 'La API no se cachea (TTL 0 salvo que el origen pida otra cosa, tope 1 s); Authorization llega al origen',
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
    // Fotos públicas de la API (`/api/public/media/*`). La clave de caché es solo la ruta: sin Authorization, sin
    // cookies y sin query string, así ninguna respuesta queda ligada a una sesión. El origen responde
    // `public, max-age=31536000, immutable`; en el borde se guarda como mucho 7 días (una imagen retirada deja de
    // servirse sola en ese plazo sin invalidar), y el navegador conserva el año que pide el origen.
    ApiMediaCachePolicy: {
      Type: 'AWS::CloudFront::CachePolicy',
      Properties: {
        CachePolicyConfig: {
          Name: sub('busperu-${EnvName}-api-media'),
          Comment: 'Solo /api/public/media/*: imagenes publicas con nombre inmutable; clave sin Authorization, cookies ni query',
          MinTTL: 0,
          DefaultTTL: 86400,
          MaxTTL: 604800,
          ParametersInCacheKeyAndForwardedToOrigin: {
            EnableAcceptEncodingGzip: false,
            EnableAcceptEncodingBrotli: false,
            HeadersConfig: { HeaderBehavior: 'none' },
            CookiesConfig: { CookieBehavior: 'none' },
            QueryStringsConfig: { QueryStringBehavior: 'none' },
          },
        },
      },
    },
    // Fase 3 · al retirar una imagen pública la API invalida SU ruta. Permiso mínimo: una acción, sobre esta
    // distribución de la API y nada más; va en el rol de la aplicación, acotado además por su límite de permisos.
    ApiMediaInvalidationPolicy: {
      Type: 'AWS::IAM::Policy',
      Properties: {
        PolicyName: sub('busperu-${EnvName}-api-media-invalidation'),
        Roles: [sub(APP_ROLE)],
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: [{
            Sid: 'InvalidarMediaPublicaRetirada',
            Effect: 'Allow',
            Action: 'cloudfront:CreateInvalidation',
            Resource: sub('arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${ApiDistribution}'),
          }],
        },
      },
    },
    // Id de la distribución para la API, en la ruta que render-env.sh vuelca en su entorno. No es secreto.
    ApiMediaDistributionIdParam: {
      Type: 'AWS::SSM::Parameter',
      Properties: {
        Name: sub(MEDIA_DISTRIBUTION_PARAM),
        Type: 'String',
        Value: ref('ApiDistribution'),
        Description: 'Distribucion de CloudFront de la API: se invalida /api/public/media/<ref> al retirar una imagen publica',
      },
    },
    WebDistribution: {
      Type: 'AWS::CloudFront::Distribution',
      Properties: {
        DistributionConfig: {
          Enabled: true,
          Comment: 'busperu-staging-web (SPA)',
          PriceClass: 'PriceClass_All',
          HttpVersion: 'http2and3',
          IPV6Enabled: false,
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
            ResponseHeadersPolicyId: MANAGED.securityHeaders,
            Compress: true,
            FunctionAssociations: funcion,
          },
          // BrowserRouter: cualquier ruta del SPA que no sea un archivo llega como 403 (sin ListBucket)
          // o 404 y se sirve index.html. Sin caché del error, para que una publicación se vea al momento.
          CustomErrorResponses: [403, 404].map((ErrorCode) => ({ ErrorCode, ResponseCode: 200, ResponsePagePath: '/index.html', ErrorCachingMinTTL: 0 })),
          ViewerCertificate: { CloudFrontDefaultCertificate: true },
        },
        Tags: tags('web-cdn'),
      },
    },
    ApiDistribution: {
      Type: 'AWS::CloudFront::Distribution',
      Properties: {
        DistributionConfig: {
          Enabled: true,
          Comment: 'busperu-staging-api (ALB)',
          PriceClass: 'PriceClass_All',
          HttpVersion: 'http2and3',
          IPV6Enabled: false,
          Origins: [{
            Id: 'api-alb',
            DomainName: ref('AlbDnsName'),
            // F18-11B: 55 s (antes 5 s). Reutiliza la conexión Lima → São Paulo en vez de abrir otra (~80 ms);
            // por debajo del idle_timeout del ALB (60 s) para que sea CloudFront quien cierre primero.
            CustomOriginConfig: { HTTPPort: 80, OriginProtocolPolicy: 'http-only', OriginReadTimeout: 30, OriginKeepaliveTimeout: 55 },
            OriginCustomHeaders: [{ HeaderName: ORIGIN_HEADER, HeaderValue: ref('OriginVerifySecret') }],
          }],
          DefaultCacheBehavior: {
            TargetOriginId: 'api-alb',
            ViewerProtocolPolicy: 'https-only',
            AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'],
            CachedMethods: ['GET', 'HEAD'],
            CachePolicyId: ref('ApiCachePolicy'),
            OriginRequestPolicyId: MANAGED.allViewerExceptHost,
            Compress: true,
            FunctionAssociations: funcion,
          },
          // Fase 2 · la única ruta cacheable de la API. Mismo origen (con su cabecera secreta) y la misma restricción
          // por IP; sin política de petición al origen: al ALB solo llega la ruta, nunca Authorization ni cookies.
          CacheBehaviors: [{
            PathPattern: API_MEDIA_PATH,
            TargetOriginId: 'api-alb',
            ViewerProtocolPolicy: 'https-only',
            AllowedMethods: ['GET', 'HEAD'],
            CachedMethods: ['GET', 'HEAD'],
            CachePolicyId: ref('ApiMediaCachePolicy'),
            Compress: false,
            FunctionAssociations: funcion,
          }],
          // F18-19B (F-01): sin esto CloudFront guarda ~10 s los errores de la API (404, 403, 5xx…) aunque la
          // política de caché sea TTL 0, y un perfil recién aprobado seguía respondiendo «no encontrado».
          // Solo el TTL del error: sin ResponsePagePath ni ResponseCode, el error llega tal cual (nunca index.html).
          CustomErrorResponses: API_ERROR_CODES.map((ErrorCode) => ({ ErrorCode, ErrorCachingMinTTL: 0 })),
          ViewerCertificate: { CloudFrontDefaultCertificate: true },
        },
        Tags: tags('api-cdn'),
      },
    },
    AlbFromCloudFront: {
      Type: 'AWS::EC2::SecurityGroupIngress',
      Properties: {
        GroupId: ref('AlbSecurityGroupId'),
        Description: 'F18-09: CloudFront (origin-facing) hacia el ALB, solo HTTP 80',
        IpProtocol: 'tcp',
        FromPort: 80,
        ToPort: 80,
        SourcePrefixListId: ref('CloudFrontPrefixListId'),
      },
    },
    RuleFromApiDistribution: {
      Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
      Properties: {
        ListenerArn: ref('ListenerArn'),
        Priority: 10,
        Conditions: [{ Field: 'http-header', HttpHeaderConfig: { HttpHeaderName: ORIGIN_HEADER, Values: [ref('OriginVerifySecret')] } }],
        Actions: [{ Type: 'forward', TargetGroupArn: ref('TargetGroupArn') }],
      },
    },
    RuleFromOperators: {
      Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
      Properties: {
        ListenerArn: ref('ListenerArn'),
        Priority: 20,
        Conditions: [{ Field: 'source-ip', SourceIpConfig: { Values: ref('OperatorCidrs') } }],
        Actions: [{ Type: 'forward', TargetGroupArn: ref('TargetGroupArn') }],
      },
    },
    RuleDenyEverythingElse: {
      Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
      Properties: {
        ListenerArn: ref('ListenerArn'),
        Priority: 30,
        Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['*'] } }],
        Actions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '403', ContentType: 'text/plain', MessageBody: 'Forbidden' } }],
      },
    },
  },
  Outputs: {
    WebUrl: { Description: 'Origen del SPA (FRONTEND_URL)', Value: sub('https://${WebDistribution.DomainName}') },
    ApiUrl: { Description: 'VITE_API_URL del build', Value: sub('https://${ApiDistribution.DomainName}/api') },
    FrontendBucketName: { Value: ref('FrontendBucket') },
    WebDistributionId: { Value: ref('WebDistribution') },
    ApiDistributionId: { Value: ref('ApiDistribution') },
  },
};

export default template;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const destino = new URL('./busperu-staging-web.json', import.meta.url);
  const json = `${JSON.stringify(template, null, 2)}\n`;
  writeFileSync(destino, json);
  console.log(`busperu-staging-web.json · ${Object.keys(template.Resources).length} recursos · ${Buffer.byteLength(json)} bytes`);
}
