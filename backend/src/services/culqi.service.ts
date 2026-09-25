import { env } from '../config/env';

/**
 * Cliente de la API de Culqi (v2).
 *
 * CONTRATO OFICIAL, tomado de la documentación vigente y de los SDK oficiales:
 *
 *   · Base       `https://api.culqi.com/v2`  ← el host ya lleva «api»; la ruta NO lo repite
 *   · Auth       `Authorization: Bearer <llave privada>`
 *   · Cargo      `POST /charges`  con `amount` **en céntimos**, `currency_code` (PEN|USD),
 *                `email`, `source_id` (el `tkn_…` que produce el navegador), y opcionales
 *                `description`, `metadata`, `antifraud_details`, `installments`, `capture`.
 *   · Consulta   `GET /charges/{id}`
 *   · Devolución `POST /refunds` con `charge_id`, `amount` (céntimos) y `reason`.
 *
 * DOS COSAS QUE LA DOCUMENTACIÓN **NO** OFRECE, y que por tanto no se inventan aquí:
 *
 *   1. **Cabecera de idempotencia.** La API v2 no publica ninguna. La idempotencia se
 *      resuelve entera del lado de BusPerú (ver `payment.service.ts`): un cargo se intenta
 *      una sola vez por intención de pago, y esa intención se cierra con el cerrojo de la
 *      fila del pago antes de salir a la red.
 *   2. **Firma del webhook.** Culqi no documenta HMAC ni cabecera de firma. Por eso el
 *      webhook de BusPerú no valida ninguna firma inventada: releé el cargo contra esta
 *      misma API, que es la única fuente que sí podemos verificar.
 *
 * La llave privada solo vive aquí y en `env`. No se registra, no se devuelve y no entra en
 * ningún mensaje de error: lo único que se dice cuando falta es que falta.
 */

/** Un cargo tal como lo devuelve Culqi. Solo los campos que BusPerú usa o guarda. */
export interface CulqiCharge {
  id: string;
  amount: number;
  currency_code: string;
  /** Culqi lo llama `outcome`; su `type` distingue un cobro aceptado de uno rechazado. */
  outcome?: { type?: string; code?: string; merchant_message?: string; user_message?: string };
  reference_code?: string;
  creation_date?: number;
  capture?: boolean;
  source?: { iin?: { card_brand?: string }; card_number?: string };
}

export interface CulqiRefund {
  id: string;
  charge_id: string;
  amount: number;
  reason?: string;
}

/** Error devuelto por Culqi. `type` y `code` son suyos; no se inventan valores. */
export interface CulqiError {
  object?: string;
  type?: string;
  code?: string;
  merchant_message?: string;
  user_message?: string;
}

/**
 * Resultado de una llamada, como dato y no como excepción.
 *
 * Un cobro rechazado por el banco **no es un fallo del servidor**: es una respuesta
 * legítima que el usuario debe ver. Devolverlo como valor obliga a quien llama a decidir
 * qué hacer con cada caso en vez de dejar que un `throw` lo convierta todo en un 500.
 */
export type CulqiResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: CulqiFailure; code: string | null; userMessage: string; merchantMessage: string };

/**
 * Por qué falló:
 *   · `DECLINED`     el banco o el antifraude lo rechazó. Culpa del medio de pago.
 *   · `INVALID`      la petición no era válida (token usado, importe fuera de rango…).
 *   · `UNCONFIGURED` falta la llave privada en el entorno.
 *   · `TIMEOUT`      Culqi no respondió a tiempo. **El cobro puede haber ocurrido igual.**
 *   · `PROVIDER`     error del proveedor o de red.
 */
export type CulqiFailure = 'DECLINED' | 'INVALID' | 'UNCONFIGURED' | 'TIMEOUT' | 'PROVIDER';

export interface CreateChargeInput {
  /** En céntimos: 45.50 soles son 4550. Lo calcula el backend, nunca el cliente. */
  amountCents: number;
  currencyCode: string;
  email: string;
  /** El `tkn_…` que devolvió el navegador. Único dato del cliente que se reenvía. */
  sourceId: string;
  description: string;
  metadata?: Record<string, string>;
}

export interface CreateRefundInput {
  chargeId: string;
  amountCents: number;
  reason: string;
}

/** Superficie que BusPerú usa de Culqi. La suite inyecta un doble con esta forma. */
export interface CulqiApi {
  createCharge(input: CreateChargeInput): Promise<CulqiResult<CulqiCharge>>;
  getCharge(chargeId: string): Promise<CulqiResult<CulqiCharge>>;
  createRefund(input: CreateRefundInput): Promise<CulqiResult<CulqiRefund>>;
}

/** Convierte soles a céntimos sin arrastrar el error binario de los flotantes. */
export const toCents = (amount: number | string): number => Math.round(Number(amount) * 100);

/** Y al revés, para comparar lo que dice Culqi con lo que dice BusPerú. */
export const fromCents = (cents: number): number => Number((cents / 100).toFixed(2));

/**
 * Un cargo se considera cobrado cuando su `outcome.type` es de éxito.
 *
 * Culqi usa `venta_exitosa` para la venta aceptada. Se compara de forma tolerante porque el
 * proveedor puede añadir variantes, pero **nunca al revés**: lo que no se reconoce como
 * éxito se trata como no cobrado, que es el lado seguro del error.
 */
export function isSuccessfulCharge(charge: CulqiCharge): boolean {
  const tipo = charge.outcome?.type?.toLowerCase() ?? '';
  return tipo.includes('exito') || tipo === 'venta_exitosa';
}

const SIN_LLAVE: Extract<CulqiResult<never>, { ok: false }> = {
  ok: false,
  kind: 'UNCONFIGURED',
  code: null,
  userMessage: 'El pago con tarjeta no está disponible en este momento.',
  merchantMessage: 'Falta CULQI_PRIVATE_KEY en el entorno del backend.',
};

/** Cliente real. Usa `fetch` de Node: sin dependencias nuevas. */
export class CulqiHttpApi implements CulqiApi {
  createCharge(input: CreateChargeInput): Promise<CulqiResult<CulqiCharge>> {
    return this.post<CulqiCharge>('/charges', {
      amount: input.amountCents,
      currency_code: input.currencyCode,
      email: input.email,
      source_id: input.sourceId,
      description: input.description,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
  }

  getCharge(chargeId: string): Promise<CulqiResult<CulqiCharge>> {
    return this.request<CulqiCharge>('GET', `/charges/${encodeURIComponent(chargeId)}`);
  }

  createRefund(input: CreateRefundInput): Promise<CulqiResult<CulqiRefund>> {
    return this.post<CulqiRefund>('/refunds', {
      charge_id: input.chargeId,
      amount: input.amountCents,
      reason: input.reason,
    });
  }

  private post<T>(path: string, body: Record<string, unknown>): Promise<CulqiResult<T>> {
    return this.request<T>('POST', path, body);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<CulqiResult<T>> {
    if (!env.culqi.privateKey) return SIN_LLAVE;

    const corte = AbortSignal.timeout(env.culqi.timeoutMs);

    let respuesta: Response;
    try {
      respuesta = await fetch(`${env.culqi.apiUrl}${path}`, {
        method,
        headers: {
          // La llave privada viaja solo aquí, en la cabecera, hacia Culqi.
          Authorization: `Bearer ${env.culqi.privateKey}`,
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: corte,
      });
    } catch (error) {
      // Ni la URL ni las cabeceras se copian al mensaje: la cabecera lleva la llave.
      const agotado = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return {
        ok: false,
        kind: agotado ? 'TIMEOUT' : 'PROVIDER',
        code: null,
        userMessage: 'No pudimos completar el pago. Vuelve a intentarlo en unos minutos.',
        merchantMessage: agotado ? 'Culqi no respondió dentro del tiempo límite' : 'No se pudo contactar con Culqi',
      };
    }

    let cuerpo: unknown = null;
    try {
      cuerpo = await respuesta.json();
    } catch {
      cuerpo = null;
    }

    if (respuesta.ok) return { ok: true, data: cuerpo as T };

    const fallo = (cuerpo ?? {}) as CulqiError;
    return {
      ok: false,
      // Culqi distingue el rechazo del banco con `card_error`; el resto son de la petición.
      kind: fallo.type === 'card_error' ? 'DECLINED' : 'INVALID',
      code: fallo.code ?? null,
      userMessage: fallo.user_message || 'No se pudo procesar el pago con esa tarjeta.',
      merchantMessage: fallo.merchant_message || `Culqi respondió ${respuesta.status}`,
    };
  }
}

let api: CulqiApi | null = null;

export function culqi(): CulqiApi {
  api ??= new CulqiHttpApi();
  return api;
}

/** Permite a la suite inyectar un doble. Nunca se llama desde código de producción. */
export function setCulqiApi(custom: CulqiApi | null): void {
  api = custom;
}

/** ¿Se puede cobrar con tarjeta ahora mismo? Lo consulta el endpoint de configuración. */
export const isCulqiConfigured = (): boolean => Boolean(env.culqi.privateKey && env.culqi.publicKey);
