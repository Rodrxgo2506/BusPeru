/**
 * Precarga del panel ADMIN (F18-16): módulos (chunks) Y datos de las secciones principales.
 *
 * Por qué: el primer clic en una sección pagaba el chunk + el preflight CORS + la lectura de sus
 * datos, con esqueleto mientras tanto. Tras pintar el Dashboard, y con el navegador ocioso, se
 * descargan en segundo plano, una sección cada vez (sin competir con lo que el usuario pide), el
 * chunk y las MISMAS lecturas que hará la sección al abrirse. Van a la caché de lecturas (clave con
 * el token, invalidada en logout/401/escrituras): al hacer clic, la sección se pinta al instante.
 *
 * Las lecturas deben coincidir EXACTAMENTE con las de cada página (misma ruta y mismos parámetros,
 * en el mismo orden) para que la clave de caché sea la misma. `useList` pide `{ page, limit }`.
 * Solo se precarga lo que ya piden las páginas: nada de listados enormes nuevos.
 */
import {
  bookingService,
  busService,
  companyService,
  dashboardService,
  destinationService,
  locationService,
  paymentService,
  roleService,
  routeService,
  settingService,
  tripService,
  userService,
} from '@/services';
import { foregroundRequestsInFlight, isResponseCacheEnabled, msSinceForegroundRequest } from '@/services/api';
import { ADMIN_ROUTE_CHUNKS } from './admin-chunks';

const PRIMERA_PAGINA = { page: 1, limit: 10 };

/** Lecturas que hace cada sección al abrirse (copiadas de sus páginas). */
const ADMIN_SECTION_DATA: Readonly<Record<string, () => Array<Promise<unknown>>>> = {
  '/admin/dashboard': () => [dashboardService.admin()],
  '/admin/companies': () => [companyService.list(PRIMERA_PAGINA)],
  '/admin/users': () => [userService.list(PRIMERA_PAGINA), roleService.list(), companyService.list({ limit: 200 }), userService.stats()],
  '/admin/trips': () => [tripService.list(PRIMERA_PAGINA), routeService.list({ limit: 200 }), busService.list({ limit: 200 })],
  '/admin/bookings': () => [bookingService.list(PRIMERA_PAGINA)],
  '/admin/payments': () => [paymentService.summary(), paymentService.list(PRIMERA_PAGINA)],
  '/admin/destinations': () => [
    destinationService.list({ limit: 100, sort: 'd.display_order', order: 'ASC' }),
    locationService.list({ limit: 100, sort: 'l.city', order: 'ASC', type: 'TERMINAL' }),
  ],
  '/admin/settings': () => [settingService.list({ page: 1, limit: 100 })],
};

/** Orden de precarga: las secciones que más se visitan primero. */
const PRIORIDAD = ['/admin/companies', '/admin/users', '/admin/trips', '/admin/bookings', '/admin/payments', '/admin/destinations', '/admin/settings'];

const quiet = (promise: Promise<unknown>) => promise.catch(() => undefined);
const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * La precarga cede el paso a la pantalla: espera a que NINGUNA de sus lecturas siga en vuelo (p. ej.
 * el propio Dashboard al entrar) y a que no se haya lanzado otra en los últimos 600 ms (navegación).
 */
async function whileUserIsNavigating(isCancelled: () => boolean): Promise<void> {
  while (!isCancelled() && (foregroundRequestsInFlight() > 0 || msSinceForegroundRequest() < 600)) await sleep(200);
}

/** Precarga el chunk y los datos de una sección. Un fallo no importa: la sección lo pedirá al abrirse. */
export async function prefetchAdminRoute(path: string): Promise<void> {
  const chunk = ADMIN_ROUTE_CHUNKS[path];
  const data = isResponseCacheEnabled() ? ADMIN_SECTION_DATA[path] : undefined;
  await Promise.all([chunk ? quiet(chunk()) : undefined, ...(data ? data().map(quiet) : [])]);
}

/**
 * Tras pintar el Dashboard y con el navegador ocioso: primero las secciones principales (chunk y
 * datos, de una en una) y después el resto de chunks del menú. Devuelve la función que la cancela.
 */
export function scheduleAdminPrefetch(delayMs = 800): () => void {
  let cancelled = false;
  let idleId: number | undefined;
  const run = async () => {
    for (const path of PRIORIDAD) {
      await whileUserIsNavigating(() => cancelled);
      if (cancelled || !isResponseCacheEnabled()) return;
      await prefetchAdminRoute(path);
    }
    const resto = [...new Set(Object.values(ADMIN_ROUTE_CHUNKS))];
    for (const load of resto) {
      if (cancelled) return;
      await quiet(load());
    }
  };
  const timer = window.setTimeout(() => {
    if ('requestIdleCallback' in window) idleId = window.requestIdleCallback(() => void run(), { timeout: 2000 });
    else void run();
  }, delayMs);
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
    if (idleId !== undefined && 'cancelIdleCallback' in window) window.cancelIdleCallback(idleId);
  };
}
