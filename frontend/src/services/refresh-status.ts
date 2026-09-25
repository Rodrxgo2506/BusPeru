/**
 * Estado global de las actualizaciones en segundo plano (F18-16).
 *
 * Con stale-while-revalidate una pantalla puede estar enseñando datos VIEJOS mientras los
 * revalida: eso no debe presentarse como si fuera el dato confirmado. Los hooks (`useList`,
 * `useAsync`) avisan aquí cuando empiezan y terminan de actualizar datos que ya están a la vista, y
 * cuando una actualización falla; la cabecera del portal lo muestra («Actualizando…» o «No se pudo
 * actualizar») sin bloquear nada ni quitar el contenido.
 *
 * Sin dependencias de React ni del navegador: se prueba con `node --test`.
 */

export interface RefreshSnapshot {
  /** Hay al menos una actualización en curso de datos que ya están en pantalla. */
  refreshing: boolean;
  /** La última actualización falló y se siguen mostrando los datos anteriores. */
  failed: boolean;
}

/** Cuánto tiempo se mantiene el aviso de fallo si no llega otra actualización correcta. */
export const FAILURE_NOTICE_MS = 8000;

let active = 0;
let failedUntil = 0;
let snapshot: RefreshSnapshot = { refreshing: false, failed: false };
const listeners = new Set<() => void>();
let now: () => number = () => Date.now();
let failureTimer: ReturnType<typeof setTimeout> | undefined;

function emit(): void {
  const next = { refreshing: active > 0, failed: failedUntil > now() };
  if (next.refreshing === snapshot.refreshing && next.failed === snapshot.failed) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

/** Marca el inicio de una actualización; devuelve la función que la da por terminada (idempotente). */
export function beginRefresh(): () => void {
  active += 1;
  emit();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    active -= 1;
    emit();
  };
}

/** Una actualización de datos ya visibles falló: se conserva lo mostrado y se avisa un momento. */
export function reportRefreshFailure(): void {
  failedUntil = now() + FAILURE_NOTICE_MS;
  emit();
  if (failureTimer !== undefined) clearTimeout(failureTimer);
  failureTimer = setTimeout(emit, FAILURE_NOTICE_MS + 10);
}

/** Una actualización terminó bien: retira el aviso de fallo. */
export function reportRefreshSuccess(): void {
  if (failedUntil === 0) return;
  failedUntil = 0;
  emit();
}

export function subscribeRefresh(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRefreshSnapshot(): RefreshSnapshot {
  return snapshot;
}

/** Solo para tests: reloj controlado y estado inicial. */
export function __resetRefreshStatusForTests(clock: () => number = () => Date.now()): void {
  active = 0;
  failedUntil = 0;
  snapshot = { refreshing: false, failed: false };
  now = clock;
  listeners.clear();
  if (failureTimer !== undefined) clearTimeout(failureTimer);
  failureTimer = undefined;
}
