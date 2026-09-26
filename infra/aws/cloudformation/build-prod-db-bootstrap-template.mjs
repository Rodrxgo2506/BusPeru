// BusPerú · F18-18 (B-10) · rol TEMPORAL para crear los usuarios de la base de producción: pila
// `busperu-prod-db-bootstrap` (sa-east-1). SOLO SE GENERA.
//
//   node build-prod-db-bootstrap-template.mjs → escribe busperu-prod-db-bootstrap.json
//
// Por qué existe. `create-db-users.sh` necesita el usuario maestro de RDS (Secrets Manager, gestionado por RDS).
// En producción el rol de la EC2 (`busperu-prod-app-role`) tiene `Deny secretsmanager:*`, y ese Deny SE MANTIENE:
// la API nunca podrá leer el maestro. En lugar de abrir una excepción en el runtime, se usa una identidad
// aparte, humana, temporal y mínima:
//
//   · la asume SOLO el administrador, con MFA de menos de 1 h y con el nombre de sesión fijo
//     `busperu-db-bootstrap` (sesiones de 1 h como máximo);
//   · puede leer (y hacer rotar) SOLO el secreto maestro de busperu-prod-db;
//   · puede abrir SOLO un túnel de Session Manager (AWS-StartPortForwardingSessionToRemoteHost) a través de la
//     instancia de producción hasta RDS, y cerrar sus propias sesiones;
//   · todo lo demás tiene Deny explícito (NotAction).
//
// Procedimiento: infra/aws/scripts/prod-db-bootstrap.sh desde CloudShell (runbook §5.3). Al terminar se rota el
// maestro y se BORRA esta pila: el rol deja de existir. Crear y borrar la pila dispara las alertas de cambios de
// IAM de la línea base (esperado y auditado en CloudTrail).
//
// La despliega el administrador con MFA (el rol de ejecución de producción solo gestiona la pila busperu-prod).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENV = 'prod';
const P = `busperu-${ENV}`;
export const BOOTSTRAP_ROLE = `${P}-db-bootstrap`;
export const BOOTSTRAP_SESSION = 'busperu-db-bootstrap';
export const TUNEL = 'AWS-StartPortForwardingSessionToRemoteHost';
// Mismo administrador que el modelo IAM de producción (infra/aws/iam/prod/build-iam-prod.mjs, ADMIN).
const ADMIN = { 'Fn::Sub': 'arn:aws:iam::${AWS::AccountId}:user/Rodrigo' };
const sub = (text) => ({ 'Fn::Sub': text });
const ref = (name) => ({ Ref: name });

export const ACCIONES = {
  secreto: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret', 'secretsmanager:RotateSecret'],
  sesion: ['ssm:StartSession'],
  propias: ['ssm:TerminateSession', 'ssm:ResumeSession'],
  lectura: ['ssm:DescribeSessions', 'ssm:GetConnectionStatus', 'ec2:DescribeInstances', 'rds:DescribeDBInstances', 'sts:GetCallerIdentity'],
  kms: ['kms:Decrypt'],
};

const template = {
  AWSTemplateFormatVersion: '2010-09-09',
  Description: 'BusPeru PRODUCCION (F18-18, B-10): rol TEMPORAL y minimo para crear los usuarios de la base. Se borra al terminar.',
  Parameters: {
    MasterSecretArn: {
      Type: 'String',
      AllowedPattern: '^arn:aws:secretsmanager:sa-east-1:[0-9]{12}:secret:rds![a-z0-9-]+$',
      Description: 'Salida DatabaseMasterSecretArn de busperu-prod (secreto maestro gestionado por RDS)',
    },
    AppInstanceId: { Type: 'String', AllowedPattern: '^i-[0-9a-f]{8,17}$', Description: 'Salida AppInstanceId de busperu-prod' },
  },
  Resources: {
    DbBootstrapRole: {
      Type: 'AWS::IAM::Role',
      Properties: {
        RoleName: BOOTSTRAP_ROLE,
        Description: 'TEMPORAL (B-10): leer el maestro de busperu-prod-db y abrir un tunel a RDS. Borrar la pila al terminar.',
        MaxSessionDuration: 3600,
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [{
            Sid: 'SoloElAdministradorConMfaYSesionFija',
            Effect: 'Allow',
            Principal: { AWS: ADMIN },
            Action: 'sts:AssumeRole',
            Condition: {
              Bool: { 'aws:MultiFactorAuthPresent': 'true' },
              NumericLessThan: { 'aws:MultiFactorAuthAge': '3600' },
              StringEquals: { 'sts:RoleSessionName': BOOTSTRAP_SESSION },
            },
          }],
        },
        Policies: [{
          PolicyName: 'busperu-prod-db-bootstrap-minimo',
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              { Sid: 'SoloElSecretoMaestro', Effect: 'Allow', Action: ACCIONES.secreto, Resource: ref('MasterSecretArn') },
              {
                // El secreto gestionado por RDS se cifra con aws/secretsmanager: descifrar solo a través de Secrets Manager.
                Sid: 'DescifrarSoloViaSecretsManager', Effect: 'Allow', Action: ACCIONES.kms, Resource: sub('arn:aws:kms:${AWS::Region}:${AWS::AccountId}:key/*'),
                Condition: { StringEquals: { 'kms:ViaService': sub('secretsmanager.${AWS::Region}.amazonaws.com') } },
              },
              {
                Sid: 'TunelSoloPorLaInstanciaDeProduccion', Effect: 'Allow', Action: ACCIONES.sesion,
                Resource: [sub('arn:aws:ec2:${AWS::Region}:${AWS::AccountId}:instance/${AppInstanceId}'), sub(`arn:aws:ssm:\${AWS::Region}::document/${TUNEL}`)],
                Condition: { BoolIfExists: { 'ssm:SessionDocumentAccessCheck': 'true' } },
              },
              { Sid: 'SusPropiasSesiones', Effect: 'Allow', Action: ACCIONES.propias, Resource: sub(`arn:aws:ssm:\${AWS::Region}:\${AWS::AccountId}:session/${BOOTSTRAP_SESSION}-*`) },
              { Sid: 'LecturasMinimas', Effect: 'Allow', Action: ACCIONES.lectura, Resource: '*', Condition: { StringEquals: { 'aws:RequestedRegion': 'sa-east-1' } } },
              {
                Sid: 'NadaMas', Effect: 'Deny', Resource: '*',
                NotAction: [...ACCIONES.secreto, ...ACCIONES.kms, ...ACCIONES.sesion, ...ACCIONES.propias, ...ACCIONES.lectura],
              },
              {
                // Aunque el secreto se pueda leer, nunca se modifica ni se borra desde aquí (la rotación la hace RDS).
                Sid: 'NiEscribirNiBorrarSecretos', Effect: 'Deny', Resource: '*',
                Action: ['secretsmanager:PutSecretValue', 'secretsmanager:UpdateSecret', 'secretsmanager:DeleteSecret', 'secretsmanager:RestoreSecret', 'secretsmanager:PutResourcePolicy'],
              },
            ],
          },
        }],
        Tags: [
          { Key: 'Name', Value: BOOTSTRAP_ROLE },
          { Key: 'Project', Value: 'busperu' },
          { Key: 'Environment', Value: ENV },
          { Key: 'Temporal', Value: 'borrar-tras-el-bootstrap' },
        ],
      },
    },
  },
  Outputs: {
    DbBootstrapRoleArn: { Value: { 'Fn::GetAtt': ['DbBootstrapRole', 'Arn'] }, Description: `Asumir con --role-session-name ${BOOTSTRAP_SESSION} y MFA` },
  },
};

export default template;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const destino = new URL('./busperu-prod-db-bootstrap.json', import.meta.url);
  const json = `${JSON.stringify(template, null, 2)}\n`;
  writeFileSync(destino, json);
  console.log(`busperu-prod-db-bootstrap.json · ${Object.keys(template.Resources).length} recurso · ${Buffer.byteLength(json)} bytes`);
}
