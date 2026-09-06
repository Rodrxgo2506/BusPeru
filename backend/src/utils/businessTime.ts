/**
 * Semántica horaria de BusPerú (auditoría BP-12).
 *
 * QUÉ REPRESENTAN LAS FECHAS DE LA BASE. Todas las columnas de fecha guardan la **hora de
 * pared del negocio en Perú**, sin marca de zona:
 *
 *   · `trips.departure_datetime` = 08:00 significa que el bus sale a las 08:00 en Perú.
 *   · Los `DATETIME` que escribe la aplicación se escriben con `NOW()` de MySQL.
 *   · Los `TIMESTAMP` con `DEFAULT current_timestamp()` los escribe MySQL con ese mismo
 *     reloj, así que expresan el mismo cuando.
 *
 * No hay ni un valor en UTC, y por eso **no se convierte nada**: reinterpretar esos valores
 * como UTC movería cada viaje cinco horas.
 *
 * EL PROBLEMA QUE ESTO RESUELVE. Una cadena como `"2026-09-12 01:30:00"` no lleva zona, así
 * que `new Date(...)` la interpreta en la zona del PROCESO. El mismo dato producía tres
 * instantes distintos según dónde corriera Node:
 *
 *     TZ=America/Lima    -> 2026-09-12T06:30:00Z
 *     TZ=UTC             -> 2026-09-12T01:30:00Z
 *     TZ=Europe/Madrid   -> 2026-09-11T23:30:00Z
 *
 * Hoy coincidía por casualidad, porque la máquina corre en hora de Perú. En el despliegue
 * típico —contenedor en UTC— cada comparación se habría desplazado cinco horas: viajes que
 * ya salieron aceptando reservas, retenciones que expiran a destiempo, códigos de
 * recuperación caducados antes de tiempo.
 *
 * La regla de aquí en adelante: una fecha que viene de la base se convierte a instante con
 * `parseBusinessDateTime`, nunca con `new Date(cadena)`.
 */

/** Zona operativa del negocio, en identificador IANA. */
export const PERU_TIME_ZONE = 'America/Lima';

/**
 * Desfase de la zona en minutos para un instante dado, resuelto por `Intl`.
 *
 * Se deriva del identificador IANA en lugar de escribir `-300` a mano: si la zona cambiara
 * de regla algún día, el cálculo la sigue. Perú no aplica horario de verano, de modo que el
 * valor es constante, pero el origen del dato es la base de zonas del sistema, no una
 * constante de este archivo.
 */
function zoneOffsetMinutes(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PERU_TIME_ZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  // `hour` puede llegar como 24 a medianoche en algunos entornos; el módulo lo normaliza.
  const asIfUtc = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour') % 24, value('minute'), value('second'));

  // Se truncan los milisegundos porque las partes formateadas no los llevan. Sin mutar el
  // `Date` recibido: esta función solo consulta.
  const truncado = Math.floor(instant.getTime() / 1000) * 1000;
  return (asIfUtc - truncado) / 60_000;
}

/** Desfase actual en el formato que espera el conector de MySQL: `-05:00`. */
export function peruUtcOffset(at: Date = new Date()): string {
  const minutes = zoneOffsetMinutes(new Date(at.getTime()));
  const signo = minutes < 0 ? '-' : '+';
  const absoluto = Math.abs(minutes);
  const horas = String(Math.floor(absoluto / 60)).padStart(2, '0');
  const resto = String(absoluto % 60).padStart(2, '0');
  return `${signo}${horas}:${resto}`;
}

/**
 * Convierte una fecha de la base —`YYYY-MM-DD HH:mm:ss`, sin zona— en el instante real que
 * representa, leyéndola como hora de Perú.
 *
 * El resultado NO depende de la zona del proceso: es la corrección de BP-12.
 */
export function parseBusinessDateTime(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const texto = String(value).trim();
  if (texto === '') return null;

  // Si ya trae zona (una ISO con `Z` o con desfase), se respeta tal cual: no es una fecha
  // de pared, es un instante y alguien ya decidió su zona.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(texto)) {
    const conZona = new Date(texto);
    return Number.isNaN(conZona.getTime()) ? null : conZona;
  }

  const iso = texto.replace(' ', 'T');
  // Se lee primero como si fuera UTC para tener un instante de referencia con el que
  // preguntar el desfase, y después se corrige. Con una zona sin horario de verano, como
  // la peruana, una sola pasada es exacta.
  const provisional = new Date(`${iso.length === 10 ? `${iso}T00:00:00` : iso}Z`);
  if (Number.isNaN(provisional.getTime())) return null;

  const offset = zoneOffsetMinutes(new Date(provisional.getTime()));
  return new Date(provisional.getTime() - offset * 60_000);
}

/**
 * Instante actual expresado como hora de pared de Perú, en el formato de la base.
 *
 * Para las contadas escrituras que no pueden usar `NOW()` de MySQL. Lo natural sigue siendo
 * `NOW()`: se resuelve en el servidor y no depende de nada del proceso.
 */
export function businessNow(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: PERU_TIME_ZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(at);
  // El locale `sv-SE` formatea como `YYYY-MM-DD HH:mm:ss`, que es justo lo que espera MySQL.
  return parts.replace('T', ' ');
}

/**
 * Milisegundos del instante que representa una fecha de la base, o `NaN` si no es válida.
 * Atajo para las comparaciones, que es donde se usaba `new Date(...).getTime()`.
 */
export function businessTimeMs(value: string | Date | null | undefined): number {
  const parsed = parseBusinessDateTime(value);
  return parsed === null ? Number.NaN : parsed.getTime();
}
