import { Bus, MapPin } from 'lucide-react';
import { cn } from '@/utils/cn';

/**
 * Carga de la búsqueda de viajes.
 *
 * NO HAY ESPERA ARTIFICIAL: este componente se muestra exactamente mientras la petición real
 * (`GET /public/trips`) está en curso y se desmonta en cuanto responde. Si la API contesta en
 * 300 ms, se ve 300 ms. La animación (el bus recorriendo la ruta) es solo CSS y con movimiento
 * reducido queda quieta.
 *
 * Debajo, tarjetas esqueleto con la misma forma que las reales: al llegar los resultados no hay
 * salto de diseño.
 */
export function SearchLoading({ origin, destination, className }: { origin?: string; destination?: string; className?: string }) {
  const desde = origin || 'Todos los orígenes';
  const hasta = destination || 'Todos los destinos';
  return (
    <div className={cn('space-y-4', className)} role="status" aria-live="polite" aria-busy="true">
      <div className="overflow-hidden rounded-2xl bg-white px-5 py-7 text-center shadow-card ring-1 ring-black/5 sm:px-10 sm:py-9">
        <p className="text-lg font-bold text-ink sm:text-xl">Buscando tus viajes</p>
        <p className="mt-1 text-sm font-medium text-slate-500">
          {desde} <span className="text-brand-500">→</span> {hasta}
        </p>

        {/* Ruta: origen · línea discontinua en movimiento · destino, con el bus recorriéndola. */}
        <div className="relative mx-auto mt-7 flex max-w-md items-center gap-3" aria-hidden>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 ring-1 ring-brand-200">
            <span className="h-2.5 w-2.5 rounded-full bg-brand-500" />
          </span>
          <div className="relative h-8 flex-1">
            <span
              className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 animate-route-dash rounded-full"
              style={{ backgroundImage: 'linear-gradient(90deg, #F97316 0 12px, transparent 12px 24px)', backgroundSize: '24px 3px' }}
            />
            {/* La pista entera se desplaza con `transform` (0 % → 100 % de su propio ancho): el bus
                recorre la línea sin animar propiedades de maquetación. */}
            <span className="absolute inset-0 animate-bus-drive">
              <span className="absolute left-0 top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-brand-500 text-white shadow-panel ring-4 ring-white">
                <Bus className="h-[18px] w-[18px]" />
              </span>
            </span>
          </div>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-white">
            <MapPin className="h-4 w-4" />
          </span>
        </div>

        <p className="mt-6 animate-soft-pulse text-xs font-medium text-muted">Comparando horarios, precios y asientos disponibles…</p>
        <span className="sr-only">Buscando viajes de {desde} a {hasta}. Los resultados aparecerán en cuanto estén listos.</span>
      </div>

      {Array.from({ length: 2 }).map((_, index) => (
        <TripCardSkeleton key={index} />
      ))}
    </div>
  );
}

/** Esqueleto con la misma estructura y alturas que `TripCard`. */
export function TripCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-black/5" aria-hidden>
      <div className="grid lg:grid-cols-[1fr_224px]">
        <div className="p-5 sm:p-6">
          <div className="flex items-center gap-3">
            <div className="skeleton h-11 w-11 rounded-xl" />
            <div className="space-y-2">
              <div className="skeleton h-4 w-40" />
              <div className="skeleton h-3 w-24" />
            </div>
          </div>
          <div className="mt-5 flex items-center gap-4">
            <div className="skeleton h-12 w-24" />
            <div className="skeleton h-2 flex-1" />
            <div className="skeleton h-12 w-24" />
          </div>
          <div className="mt-5 flex gap-2">
            <div className="skeleton h-6 w-16 rounded-full" />
            <div className="skeleton h-6 w-16 rounded-full" />
            <div className="skeleton h-6 w-20 rounded-full" />
          </div>
        </div>
        <div className="flex flex-col items-center justify-center gap-2 border-t border-border p-5 lg:border-l lg:border-t-0">
          <div className="skeleton h-3 w-12" />
          <div className="skeleton h-7 w-24" />
          <div className="skeleton h-10 w-full rounded-control" />
        </div>
      </div>
    </div>
  );
}
