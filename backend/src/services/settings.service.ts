import * as repository from '../repositories/setting.repository';
import type { SettingRow } from '../repositories/setting.repository';

/**
 * Lectura de la configuración global (auditoría BP-13).
 *
 * QUÉ ESTABA MAL. Había DOS lectores con semánticas distintas y ninguno reutilizable:
 *
 *   · `booking.service.ts` tenía un `readSetting` privado que solo devolvía números,
 *     ignoraba `setting_type` y convertía cualquier problema en el valor por defecto sin
 *     decir nada. Peor: una configuración existente con valor `NULL` devolvía **0**, porque
 *     `Number(null)` es 0 y `Number.isFinite(0)` es cierto. Un `booking.service_fee` a
 *     `NULL` se habría cobrado como comisión de servicio cero, en silencio.
 *   · `public.routes.ts` tenía otro `parseSetting` que sí respetaba `setting_type`, pero era
 *     una implementación paralela, con sus propias reglas y solo para el endpoint público.
 *
 * Resultado: dos interpretaciones del mismo dato y ningún sitio recomendado desde el que
 * leerlo. Esto es ese sitio.
 *
 * SEMÁNTICA, y son cuatro casos distintos a propósito:
 *
 *   1. **No existe** → se usa el valor por defecto que declare quien lee. Es lo normal en
 *      una instalación que aún no ha configurado esa clave.
 *   2. **Existe y es válido** → se devuelve, convertido al tipo pedido.
 *   3. **Existe y es inválido** (texto que no es número, JSON roto, tipo declarado que no
 *      encaja) → se usa el valor por defecto **dejando un aviso en el registro con la clave
 *      y el valor ofensivo**. Nunca en silencio: una mala configuración tiene que verse.
 *   4. **Error de base de datos** → se propaga. No se disfraza de valor por defecto, porque
 *      eso convertiría una caída en una decisión de negocio equivocada y sin rastro.
 *
 * SIN CACHÉ, deliberadamente. Un cambio del administrador debe surtir efecto en la petición
 * siguiente; guardar el valor en memoria lo retrasaría y, con varias instancias, lo
 * retrasaría de forma distinta en cada una. Es una lectura por clave única e indexada.
 */

/** Aviso de configuración incorrecta. Aislado para poder comprobarlo en las pruebas. */
function warnInvalid(key: string, reason: string, raw: string | null): void {
  console.warn(`Configuración inválida en system_settings.${key}: ${reason}. Valor guardado: ${JSON.stringify(raw)}`);
}

/**
 * Comprueba que el tipo declarado en la fila encaje con el que pide quien lee.
 *
 * `STRING` se acepta siempre: es el valor por defecto de la columna y muchas instalaciones
 * guardan números sin ajustar el enum. Lo que se rechaza es una incompatibilidad real, como
 * leer un `JSON` como número.
 */
function typeMatches(declared: SettingRow['setting_type'], expected: SettingRow['setting_type'][]): boolean {
  return declared === 'STRING' || expected.includes(declared);
}

/** Fila de la configuración, o `null` si no está definida. Los errores de BD se propagan. */
async function readRow(key: string): Promise<SettingRow | null> {
  return repository.findByKey(key);
}

export interface NumberSettingOptions {
  /** Valor a usar cuando la clave no existe o su contenido no sirve. */
  fallback: number;
  /** Rechaza valores fuera de rango, que también son una mala configuración. */
  min?: number;
  max?: number;
  /** Exige un entero, para ajustes como «asientos por reserva». */
  integer?: boolean;
}

/** Lee una configuración numérica. */
export async function readNumberSetting(key: string, options: NumberSettingOptions): Promise<number> {
  const row = await readRow(key);
  if (!row) return options.fallback;

  if (!typeMatches(row.setting_type, ['INTEGER', 'DECIMAL'])) {
    warnInvalid(key, `se esperaba un número y está declarada como ${row.setting_type}`, row.setting_value);
    return options.fallback;
  }
  // `Number(null)` vale 0, así que el nulo se descarta ANTES de convertir. Ese era el fallo.
  if (row.setting_value === null || row.setting_value.trim() === '') {
    warnInvalid(key, 'está vacía', row.setting_value);
    return options.fallback;
  }

  const parsed = Number(row.setting_value);
  if (!Number.isFinite(parsed)) {
    warnInvalid(key, 'no es un número', row.setting_value);
    return options.fallback;
  }
  if (options.integer && !Number.isInteger(parsed)) {
    warnInvalid(key, 'debía ser un número entero', row.setting_value);
    return options.fallback;
  }
  if (options.min !== undefined && parsed < options.min) {
    warnInvalid(key, `es menor que el mínimo admitido (${options.min})`, row.setting_value);
    return options.fallback;
  }
  if (options.max !== undefined && parsed > options.max) {
    warnInvalid(key, `supera el máximo admitido (${options.max})`, row.setting_value);
    return options.fallback;
  }

  return parsed;
}

/** Lee una configuración de sí/no. Admite `true`, `1`, `false` y `0`. */
export async function readBooleanSetting(key: string, options: { fallback: boolean }): Promise<boolean> {
  const row = await readRow(key);
  if (!row) return options.fallback;

  if (!typeMatches(row.setting_type, ['BOOLEAN'])) {
    warnInvalid(key, `se esperaba un booleano y está declarada como ${row.setting_type}`, row.setting_value);
    return options.fallback;
  }

  const value = row.setting_value?.trim().toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;

  warnInvalid(key, 'no es un booleano reconocible', row.setting_value);
  return options.fallback;
}

/** Lee una configuración de texto. Una cadena vacía se considera sin configurar. */
export async function readStringSetting(key: string, options: { fallback: string }): Promise<string> {
  const row = await readRow(key);
  if (!row) return options.fallback;

  if (row.setting_value === null || row.setting_value.trim() === '') {
    warnInvalid(key, 'está vacía', row.setting_value);
    return options.fallback;
  }
  return row.setting_value;
}

/**
 * Lee una configuración con estructura. El validador decide si el contenido sirve, de modo
 * que quien lee nunca recibe un `any`.
 */
export async function readJsonSetting<T>(
  key: string,
  options: { fallback: T; validate: (value: unknown) => value is T },
): Promise<T> {
  const row = await readRow(key);
  if (!row) return options.fallback;

  if (!typeMatches(row.setting_type, ['JSON'])) {
    warnInvalid(key, `se esperaba JSON y está declarada como ${row.setting_type}`, row.setting_value);
    return options.fallback;
  }
  if (row.setting_value === null || row.setting_value.trim() === '') {
    warnInvalid(key, 'está vacía', row.setting_value);
    return options.fallback;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.setting_value);
  } catch {
    warnInvalid(key, 'no es JSON válido', row.setting_value);
    return options.fallback;
  }

  if (!options.validate(parsed)) {
    warnInvalid(key, 'el JSON no tiene la forma esperada', row.setting_value);
    return options.fallback;
  }
  return parsed;
}

/**
 * Convierte una fila al tipo que declara, para publicarla tal cual.
 *
 * Lo usa el endpoint público, que no sabe de antemano qué claves va a encontrar y por tanto
 * no puede pedir un tipo concreto. Es la misma interpretación que aplican los lectores de
 * arriba, no una segunda implementación.
 */
export function coerceByDeclaredType(row: SettingRow): unknown {
  if (row.setting_value === null) return null;

  switch (row.setting_type) {
    case 'INTEGER': {
      const parsed = Number.parseInt(row.setting_value, 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
    case 'DECIMAL': {
      const parsed = Number.parseFloat(row.setting_value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    case 'BOOLEAN':
      return row.setting_value === 'true' || row.setting_value === '1';
    case 'JSON':
      try {
        return JSON.parse(row.setting_value);
      } catch {
        return null;
      }
    default:
      return row.setting_value;
  }
}

/** Configuraciones marcadas como públicas, ya convertidas. */
export async function readPublicSettings(): Promise<Record<string, unknown>> {
  const rows = await repository.findPublic();
  const settings: Record<string, unknown> = {};
  for (const row of rows) settings[row.setting_key] = coerceByDeclaredType(row);
  return settings;
}
