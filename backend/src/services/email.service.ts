import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env';

/**
 * Envío de correo desacoplado del resto de la aplicación.
 *
 * Los casos de uso solo llaman a `sendPasswordResetCode` / `sendPasswordResetConfirmation`:
 * no conocen SMTP ni credenciales. El transporte se elige con `MAIL_TRANSPORT`:
 *
 *   · `log`  (por defecto en desarrollo) escribe el correo en consola. Nunca envía nada.
 *   · `smtp` usa nodemailer con las variables MAIL_*. Es el único válido en producción.
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
    case 'memory':
      return new MemoryTransport();
    case 'log':
    default:
      if (env.isProduction) {
        throw new Error('MAIL_TRANSPORT debe ser "smtp" en producción: el transporte "log" no envía correo real');
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
    console.error(`No se pudo enviar el correo "${message.subject}":`, error);
    return false;
  }
}
