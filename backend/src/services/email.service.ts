import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logError } from '../utils/logger';

/**
 * Envío de correo desacoplado del resto de la aplicación.
 *
 * Los casos de uso solo llaman a `sendPasswordResetCode` / `sendPasswordResetConfirmation`:
 * no conocen SMTP ni credenciales. El transporte se elige con `MAIL_TRANSPORT`:
 *
 *   · `log`    (por defecto en desarrollo) escribe el correo en consola. Nunca envía nada.
 *   · `smtp`   usa nodemailer con las variables MAIL_*.
 *   · `resend` usa la API de Resend con RESEND_API_KEY y RESEND_FROM_EMAIL.
 *   · `memory` retiene los mensajes; solo lo usa la suite.
 *
 * Añadir Resend NO cambió nada de la lógica de negocio: los casos de uso siguen llamando a
 * `sendEmail` y no saben quién entrega el correo. Cambiar de proveedor es cambiar una
 * variable de entorno.
 *
 * En producción el transporte `log` está prohibido: `createTransport` lanza si se
 * configura, para que un despliegue mal configurado falle al arrancar y no silenciosamente.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailTransport {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

/**
 * Transporte de desarrollo. Imprime el correo para poder seguir el flujo sin proveedor.
 *
 * ADVERTENCIA: esto revela el código de recuperación en los logs del servidor. Es
 * aceptable en una máquina de desarrollo y NUNCA en producción, donde este transporte
 * está bloqueado.
 */
class LogTransport implements EmailTransport {
  readonly name = 'log';

  async send(message: EmailMessage): Promise<void> {
    if (env.isProduction) throw new Error('El transporte de correo "log" no puede usarse en producción');
    console.log(
      [
        '',
        '┌─ CORREO (transporte de desarrollo, no se envió nada) ─────────────',
        `│ Para:    ${message.to}`,
        `│ Asunto:  ${message.subject}`,
        '│',
        ...message.text.split('\n').map((line) => `│ ${line}`),
        '└──────────────────────────────────────────────────────────────────',
        '',
      ].join('\n'),
    );
  }
}

/** Transporte real por SMTP. Las credenciales salen siempre del entorno. */
class SmtpTransport implements EmailTransport {
  readonly name = 'smtp';
  private transporter: Transporter | null = null;

  private client(): Transporter {
    if (this.transporter) return this.transporter;

    const { host, port, user, password, secure } = env.mail;
    if (!host) throw new Error('Falta MAIL_HOST para el transporte de correo SMTP');

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      ...(user ? { auth: { user, pass: password } } : {}),
    });
    return this.transporter;
  }

  async send(message: EmailMessage): Promise<void> {
    await this.client().sendMail({
      from: env.mail.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    });
  }
}

/**
 * Cliente mínimo de Resend: solo lo que este servicio usa.
 *
 * Se declara aquí, en vez de importar el tipo del SDK, para poder inyectar un doble en la
 * suite sin tocar la red ni depender de la forma interna de la biblioteca.
 */
export interface ResendClient {
  emails: {
    send(payload: {
      from: string;
      to: string;
      subject: string;
      text: string;
      html?: string;
    }): Promise<{ data: { id: string } | null; error: { name?: string; message: string } | null }>;
  };
}

/**
 * Transporte por Resend.
 *
 * El SDK se carga de forma perezosa y solo cuando de verdad hay que enviar: así ni la suite
 * ni un despliegue que use otro transporte pagan el coste de instanciarlo, y sobre todo el
 * arranque no falla por una clave que todavía no está puesta.
 *
 * La clave sale únicamente de `RESEND_API_KEY`. No se registra, no se devuelve y no aparece
 * en ningún mensaje de error: lo único que se dice cuando falta es que falta.
 */
export class ResendTransport implements EmailTransport {
  readonly name = 'resend';
  private resend: ResendClient | null = null;

  /** El cliente se puede inyectar; la suite lo aprovecha para no salir a la red. */
  constructor(client?: ResendClient) {
    this.resend = client ?? null;
  }

  private async client(): Promise<ResendClient> {
    if (this.resend) return this.resend;

    if (!env.resend.apiKey) {
      throw new Error('Falta RESEND_API_KEY para el transporte de correo "resend"');
    }
    const { Resend } = await import('resend');
    this.resend = new Resend(env.resend.apiKey) as unknown as ResendClient;
    return this.resend;
  }

  async send(message: EmailMessage): Promise<void> {
    const client = await this.client();
    const { error } = await client.emails.send({
      from: env.resend.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html ?? htmlEnvelope(message),
    });

    // El SDK devuelve el fallo en el cuerpo en vez de lanzarlo. Se convierte en excepción
    // para que `sendEmail` lo trate igual que cualquier otro transporte, y se copia solo el
    // mensaje del proveedor: nunca la petición, que lleva la clave en las cabeceras.
    if (error) throw new Error(`Resend rechazó el envío: ${error.message}`);
  }
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => ESCAPES[char]!);

/** Colores de la identidad de BusPerú, los mismos que usa el frontend (tailwind `brand`). */
const MARCA = {
  acento: '#EA580C',
  acentoSuave: '#FFF7ED',
  tinta: '#0F172A',
  tinta2: '#334155',
  tinta3: '#64748B',
  linea: '#E2E8F0',
  fondo: '#F1F5F9',
  panel: '#FFFFFF',
};

/** Una línea que es solo un código numérico suelto: así llega `{{code}}` en la plantilla. */
const ES_CODIGO = /^\d{4,10}$/;

/**
 * Convierte el cuerpo de texto en bloques HTML.
 *
 * Las plantillas están escritas para leerse en texto plano, con los renglones cortados a mano
 * a unos 90 caracteres. Volcar cada renglón como su propio párrafo parte las frases por la
 * mitad —«El equipo de BusPerú jamás» / «te lo pedirá por teléfono»—, así que se agrupan: una
 * línea en blanco separa párrafos y dentro de cada uno los renglones se vuelven a unir. Eso
 * devuelve al navegador la decisión de dónde cortar, que es lo que hace falta para que el
 * mismo correo se lea bien en un móvil y en un monitor.
 *
 * Lo único que se reconoce aparte es un párrafo que sea únicamente un código numérico, que se
 * destaca en grande. Es una heurística deliberadamente pobre, y por eso segura: cualquier otra
 * cosa se pinta como párrafo, de modo que una plantilla futura sin código se ve igual de bien
 * sin tocar nada de aquí.
 */
function bloques(texto: string): string {
  const parrafos = texto
    .split(/\n\s*\n/)
    .map((bloque) =>
      bloque
        .split('\n')
        .map((linea) => linea.trim())
        .filter((linea) => linea !== '')
        .join(' '),
    )
    .filter((parrafo) => parrafo !== '');

  return parrafos
    .map((parrafo) => {
      if (ES_CODIGO.test(parrafo)) {
        return [
          `<div style="margin:26px 0;padding:20px 12px;background:${MARCA.acentoSuave};`,
          `border:1px dashed ${MARCA.acento};border-radius:10px;text-align:center">`,
          `<div style="font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;`,
          `font-size:34px;line-height:1.1;font-weight:700;letter-spacing:9px;color:${MARCA.acento}">`,
          escapeHtml(parrafo),
          '</div></div>',
        ].join('');
      }

      return `<p style="margin:0 0 14px;color:${MARCA.tinta2}">${escapeHtml(parrafo)}</p>`;
    })
    .join('');
}

/**
 * Versión HTML de un correo que solo trae texto.
 *
 * Las plantillas de BusPerú son de texto plano y viven en `notification_templates`. Esto NO
 * las sustituye ni las toca: toma el texto que ya produce `renderTemplate` y lo viste con la
 * identidad del proyecto —la misma naranja `brand` del frontend— para que el correo llegue
 * como algo que un cliente reconoce y no como un bloque de texto plano, que además puntuúa
 * peor en los filtros de spam.
 *
 * **Todo el contenido se escapa.** El texto lleva el nombre de la persona y otros datos que
 * salen de la base, y nada de eso puede acabar interpretándose como marcado.
 *
 * Responsive sin depender de `<style>`: el ancho es fluido con un tope de 600 px y todos los
 * estilos que importan van en línea, porque muchos clientes de correo descartan la hoja de
 * estilos. La media query solo afina el relleno donde sí se respeta.
 *
 * Cuando se hagan plantillas HTML propias, bastará con que el mensaje traiga su `html` y
 * esta envoltura deja de aplicarse sola.
 */
export function htmlEnvelope(message: EmailMessage): string {
  const asunto = escapeHtml(message.subject);

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${asunto}</title>
<style>
  @media (max-width:620px) {
    .bp-pad { padding: 24px 18px !important; }
    .bp-cabecera { padding: 20px 18px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${MARCA.fondo};-webkit-font-smoothing:antialiased">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${asunto}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${MARCA.fondo}">
    <tr>
      <td align="center" style="padding:28px 12px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
               style="max-width:600px;background:${MARCA.panel};border:1px solid ${MARCA.linea};border-radius:14px;overflow:hidden">

          <tr>
            <td class="bp-cabecera" style="background:${MARCA.acento};padding:22px 32px">
              <div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                          font-size:22px;font-weight:700;letter-spacing:-0.4px;color:#FFFFFF">BusPerú</div>
              <div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                          font-size:12px;color:#FFE8D6;margin-top:2px">Pasajes interprovinciales</div>
            </td>
          </tr>

          <tr>
            <td class="bp-pad" style="padding:32px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                                      font-size:15px;line-height:1.62;color:${MARCA.tinta2}">
              <h1 style="margin:0 0 18px;font-size:20px;line-height:1.3;font-weight:700;color:${MARCA.tinta}">${asunto}</h1>
              ${bloques(message.text)}
            </td>
          </tr>

          <tr>
            <td style="padding:0 32px"><div style="height:1px;background:${MARCA.linea}"></div></td>
          </tr>

          <tr>
            <td class="bp-pad" style="padding:20px 32px 28px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                                      font-size:12px;line-height:1.6;color:${MARCA.tinta3}">
              <p style="margin:0 0 4px">Este es un mensaje automático de BusPerú. No respondas a esta dirección.</p>
              <p style="margin:0">© BusPerú · Pasajes interprovinciales en Perú</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Transporte de pruebas: retiene los mensajes en memoria en lugar de enviarlos, para
 * que la suite pueda comprobar destinatario y asunto sin depender de un servidor SMTP.
 */
export class MemoryTransport implements EmailTransport {
  readonly name = 'memory';
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }

  clear(): void {
    this.sent.length = 0;
  }
}

function createTransport(): EmailTransport {
  switch (env.mail.transport) {
    case 'smtp':
      return new SmtpTransport();
    case 'resend':
      return new ResendTransport();
    case 'memory':
      return new MemoryTransport();
    case 'log':
    default:
      if (env.isProduction) {
        throw new Error(
          'MAIL_TRANSPORT debe ser "resend" o "smtp" en producción: el transporte "log" no envía correo real',
        );
      }
      return new LogTransport();
  }
}

let transport: EmailTransport | null = null;

export function emailTransport(): EmailTransport {
  transport ??= createTransport();
  return transport;
}

/** Permite a la suite inyectar el transporte en memoria. */
export function setEmailTransport(custom: EmailTransport | null): void {
  transport = custom;
}

/**
 * Envía un correo. Un fallo de correo nunca debe revelar al cliente si la cuenta existe
 * ni tumbar la petición, así que se registra y se continúa.
 */
export async function sendEmail(message: EmailMessage): Promise<boolean> {
  try {
    await emailTransport().send(message);
    return true;
  } catch (error) {
    // H-31: sin el asunto (puede llevar datos del pasajero) ni el objeto de error del transporte.
    logError('No se pudo enviar un correo', error);
    return false;
  }
}
