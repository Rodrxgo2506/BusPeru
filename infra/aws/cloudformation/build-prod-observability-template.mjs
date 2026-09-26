// BusPerú · F18-18 · observabilidad de aplicación de PRODUCCIÓN: pila `busperu-prod-observability` (sa-east-1). SOLO
// SE GENERA.
//
//   node build-prod-observability-template.mjs → escribe busperu-prod-observability.json
//
// La despliega el administrador con MFA DESPUÉS de busperu-prod (el grupo /busperu/prod/app lo crea esa pila).
// Va aparte porque el rol de ejecución de producción no tiene logs:PutMetricFilter ni permisos de Budgets.
//
// Qué crea:
//   · Filtros de métrica sobre los registros JSON de la API (backend/src/utils/logger.ts: una línea por suceso,
//     con `level` y `message`), en el espacio de nombres BusPeru/App, y sus alarmas → busperu-prod-alarms:
//       - ErroresApp: `level = "error"` (los 500 los registra el manejador central una sola vez);
//       - Fatal: `level = "fatal"` (excepción no controlada: el proceso se reinicia);
//       - Expiracion: fallos del job de expiración de reservas (booking-expiry.service.ts);
//       - Correo: fallo al enviar un correo (email.service.ts);
//       - WebhookCulqi: webhook no autorizado, no correlacionado, marcado como fallido o compensado
//         (culqi.routes.ts, WebhookOutcome).
//   · Presupuesto mensual de la cuenta (AWS Budgets): aviso por correo al 80 % real y al 100 % previsto.
//
// Los umbrales son de arranque y deben revisarse tras el primer mes con tráfico real.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALARM_TOPIC } from './build-prod-template.mjs';

const ENV = 'prod';
const P = `busperu-${ENV}`;
const LOG_GROUP = `/busperu/${ENV}/app`;
const NAMESPACE = 'BusPeru/App';
const ref = (name) => ({ Ref: name });
const sub = (text) => ({ 'Fn::Sub': text });
const TEMA = sub(`arn:aws:sns:\${AWS::Region}:\${AWS::AccountId}:${ALARM_TOPIC}`);

export const FILTROS = {
  ErroresApp: { patron: '{ $.level = "error" }', umbral: 5, periodo: 300, descripcion: 'Errores de la API (500) en 5 min' },
  Fatal: { patron: '{ $.level = "fatal" }', umbral: 0, periodo: 60, descripcion: 'Excepción no controlada: el proceso se cerró' },
  Expiracion: { patron: '{ $.level = "error" && $.message = "*expirar*" }', umbral: 0, periodo: 300, descripcion: 'Fallo del job de expiración de reservas' },
  Correo: { patron: '{ $.level = "error" && $.message = "No se pudo enviar un correo" }', umbral: 3, periodo: 900, descripcion: 'Fallos de envío de correo (Resend)' },
  WebhookCulqi: {
    patron: '{ $.provider = "CULQI" && ($.outcome = "unauthorized" || $.outcome = "not_correlated" || $.outcome = "marked_failed" || $.outcome = "compensated") }',
    umbral: 0, periodo: 300, descripcion: 'Webhook de Culqi rechazado o con cargo compensado: revisar pagos',
  },
};

const template = {
  AWSTemplateFormatVersion: '2010-09-09',
  Description: 'BusPeru PRODUCCION (F18-18): filtros de métrica y alarmas de la aplicación, presupuesto mensual',
  Parameters: {
    MonthlyBudgetUsd: { Type: 'Number', Default: 150, MinValue: 10, MaxValue: 5000, Description: 'Presupuesto mensual de la cuenta en USD (decisión del propietario)' },
    BudgetEmail: { Type: 'String', AllowedPattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$', Description: 'Buzón del propietario para los avisos de coste' },
  },
  Resources: {
    MonthlyBudget: {
      Type: 'AWS::Budgets::Budget',
      Properties: {
        Budget: { BudgetName: `${P}-mensual`, BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: ref('MonthlyBudgetUsd'), Unit: 'USD' } },
        NotificationsWithSubscribers: [
          { Notification: { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: 80, ThresholdType: 'PERCENTAGE' }, Subscribers: [{ SubscriptionType: 'EMAIL', Address: ref('BudgetEmail') }] },
          { Notification: { NotificationType: 'FORECASTED', ComparisonOperator: 'GREATER_THAN', Threshold: 100, ThresholdType: 'PERCENTAGE' }, Subscribers: [{ SubscriptionType: 'EMAIL', Address: ref('BudgetEmail') }] },
        ],
      },
    },
  },
  Outputs: {},
};

for (const [nombre, f] of Object.entries(FILTROS)) {
  template.Resources[`Filtro${nombre}`] = {
    Type: 'AWS::Logs::MetricFilter',
    Properties: {
      LogGroupName: LOG_GROUP,
      FilterName: `${P}-${nombre.toLowerCase()}`,
      FilterPattern: f.patron,
      MetricTransformations: [{ MetricNamespace: NAMESPACE, MetricName: nombre, MetricValue: '1', DefaultValue: 0 }],
    },
  };
  template.Resources[`Alarma${nombre}`] = {
    Type: 'AWS::CloudWatch::Alarm',
    Properties: {
      AlarmName: `${P}-app-${nombre.replace(/[A-Z]/g, (m, i) => (i ? '-' : '') + m.toLowerCase())}`,
      AlarmDescription: f.descripcion,
      Namespace: NAMESPACE,
      MetricName: nombre,
      Statistic: 'Sum',
      Period: f.periodo,
      EvaluationPeriods: 1,
      Threshold: f.umbral,
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'notBreaching',
      AlarmActions: [TEMA],
      OKActions: [TEMA],
    },
  };
}

export default template;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const destino = new URL('./busperu-prod-observability.json', import.meta.url);
  const json = `${JSON.stringify(template, null, 2)}\n`;
  writeFileSync(destino, json);
  console.log(`busperu-prod-observability.json · ${Object.keys(template.Resources).length} recursos · ${Buffer.byteLength(json)} bytes`);
}
