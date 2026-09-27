import { ArrowRight, BadgeCheck, BedDouble, Bus, Heart, Snowflake, Star, Tv, Usb, Wifi, type LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { CompanyIdentity } from '@/components/companies/CompanyCard';
import type { PublicTrip } from '@/types';
import { durationBetween, formatCurrency, formatTime, parseJsonArray } from '@/utils/format';
import { arrivalDayOffset, availabilityLabel, availabilityLevel } from '@/utils/trip-results';
import { cn } from '@/utils/cn';

/** Iconos de las comodidades que ya declara cada bus (`buses.amenities`). Las desconocidas llevan uno neutro. */
const AMENITY_ICONS: Record<string, LucideIcon> = {
  WiFi: Wifi,
  'Aire acondicionado': Snowflake,
  USB: Usb,
  TV: Tv,
};

/**
 * Tarjeta de un viaje en los resultados.
 *
 * TODO LO QUE MUESTRA VIENE DEL BACKEND (`GET /public/trips`): empresa, logotipo, valoración real
 * (solo si hay opiniones publicadas), tipo de servicio, horas, terminales, comodidades del bus,
 * precio base y asientos libres. La duración se calcula con las horas reales de salida y llegada.
 * No se muestra «Directo» ni ninguna otra afirmación que el sistema no respalde.
 */
export function TripCard({
  trip,
  favourite,
  onToggleFavourite,
  style,
  className,
}: {
  trip: PublicTrip;
  favourite?: boolean;
  onToggleFavourite?: () => void;
  style?: CSSProperties;
  className?: string;
}) {
  const amenities = parseJsonArray(trip.amenities);
  const available = Number(trip.seats_available ?? 0);
  const level = availabilityLevel(available);
  const plusDays = arrivalDayOffset(trip.departure_datetime, trip.arrival_datetime);
  const duration = durationBetween(trip.departure_datetime, trip.arrival_datetime);

  return (
    <article
      style={style}
      className={cn(
        'group relative overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-black/5 transition duration-200 hover:shadow-elevated hover:ring-brand-200',
        className,
      )}
      aria-label={`${trip.company_name}, sale ${formatTime(trip.departure_datetime)} de ${trip.origin_city}, llega ${formatTime(trip.arrival_datetime)} a ${trip.destination_city}, desde ${formatCurrency(trip.base_price)}`}
    >
      <div className="grid lg:grid-cols-[1fr_224px]">
        <div className="p-5 sm:p-6">
          {/* Empresa, valoración y servicio */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <CompanyIdentity name={trip.company_name ?? 'Empresa'} logoUrl={trip.company_logo} size="sm" />
              <div className="min-w-0">
                <p className="truncate text-[15px] font-extrabold uppercase leading-tight tracking-tight text-ink">{trip.company_name}</p>
                <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
                  {trip.company_rating !== null && (
                    <span className="inline-flex items-center gap-1 font-semibold text-ink">
                      <Star className="h-3.5 w-3.5 fill-warning-500 text-warning-500" aria-hidden />
                      {trip.company_rating}
                      {trip.company_reviews > 0 && <span className="font-normal text-muted">({trip.company_reviews})</span>}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1 text-success-700">
                    <BadgeCheck className="h-3.5 w-3.5" aria-hidden /> Verificada
                  </span>
                  {/* En móvil el servicio va aquí, bajo el nombre, para no recortarlo. */}
                  {trip.bus_type_name && (
                    <span className="inline-flex items-center gap-1 font-semibold text-brand-700 sm:hidden">
                      <BedDouble className="h-3.5 w-3.5" aria-hidden />
                      {trip.bus_type_name}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {trip.bus_type_name && (
                <span className="hidden items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700 ring-1 ring-brand-100 sm:inline-flex">
                  <BedDouble className="h-3.5 w-3.5" aria-hidden />
                  {trip.bus_type_name}
                </span>
              )}
              {onToggleFavourite && (
                <button
                  type="button"
                  onClick={onToggleFavourite}
                  aria-label={favourite ? 'Quitar de favoritos' : 'Guardar en favoritos'}
                  aria-pressed={favourite}
                  className="rounded-full p-1.5 text-slate-300 transition hover:bg-slate-50 hover:text-brand-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <Heart className={cn('h-[18px] w-[18px]', favourite && 'fill-brand-500 text-brand-500')} />
                </button>
              )}
            </div>
          </div>

          {/* Línea de tiempo del viaje */}
          <div className="mt-5 grid grid-cols-[auto_1fr_auto] items-start gap-3 sm:gap-5">
            <div>
              <p className="text-2xl font-extrabold tabular-nums leading-none text-ink sm:text-[28px]">{formatTime(trip.departure_datetime)}</p>
              <p className="mt-1.5 text-sm font-semibold text-slate-700">{trip.origin_city}</p>
              <p className="max-w-[10rem] truncate text-xs text-muted" title={trip.origin_terminal ?? undefined}>{trip.origin_terminal}</p>
            </div>
            <div className="flex flex-col items-center pt-1.5">
              <span className="text-xs font-medium text-slate-500">{duration}</span>
              <span className="relative my-2 flex h-px w-full items-center bg-slate-200" aria-hidden>
                <span className="absolute left-0 h-2 w-2 -translate-x-1/2 rounded-full border-2 border-brand-500 bg-white" />
                <span className="absolute left-1/2 flex h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full bg-white text-brand-500 ring-1 ring-slate-200 transition group-hover:bg-brand-500 group-hover:text-white group-hover:ring-brand-500">
                  <Bus className="h-3.5 w-3.5" />
                </span>
                <span className="absolute right-0 h-2 w-2 translate-x-1/2 rounded-full bg-brand-500" />
              </span>
            </div>
            <div className="text-right">
              <p className="text-2xl font-extrabold tabular-nums leading-none text-ink sm:text-[28px]">
                {formatTime(trip.arrival_datetime)}
                {plusDays > 0 && (
                  <sup className="ml-0.5 text-xs font-bold text-brand-600" title={`Llega ${plusDays === 1 ? 'al día siguiente' : `${plusDays} días después`}`}>
                    +{plusDays}
                  </sup>
                )}
              </p>
              <p className="mt-1.5 text-sm font-semibold text-slate-700">{trip.destination_city}</p>
              <p className="ml-auto max-w-[10rem] truncate text-xs text-muted" title={trip.destination_terminal ?? undefined}>{trip.destination_terminal}</p>
            </div>
          </div>

          {/* Comodidades reales del bus */}
          {amenities.length > 0 && (
            <ul className="mt-5 flex flex-wrap gap-1.5 border-t border-border pt-4" aria-label="Comodidades del bus">
              {amenities.slice(0, 6).map((amenity) => {
                const Icon = AMENITY_ICONS[amenity] ?? BadgeCheck;
                return (
                  <li key={amenity} className="inline-flex items-center gap-1.5 rounded-full bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200/70">
                    <Icon className="h-3.5 w-3.5 text-slate-400" aria-hidden />
                    {amenity}
                  </li>
                );
              })}
              {amenities.length > 6 && <li className="px-1 py-1 text-xs font-medium text-muted">+{amenities.length - 6}</li>}
            </ul>
          )}
        </div>

        {/* Precio y acción */}
        <div className="flex items-center justify-between gap-4 border-t border-border bg-slate-50/70 p-5 lg:flex-col lg:justify-center lg:gap-2 lg:border-l lg:border-t-0 lg:text-center">
          <div>
            <p className="text-xs font-medium text-muted">Desde</p>
            <p className="text-2xl font-extrabold tabular-nums text-brand-600 sm:text-[28px] sm:leading-tight">{formatCurrency(trip.base_price)}</p>
            <p
              className={cn(
                'text-xs font-semibold',
                level === 'ok' ? 'text-success-700' : level === 'few' ? 'text-warning-600' : 'text-danger-600',
              )}
            >
              {availabilityLabel(available)}
            </p>
          </div>
          {available > 0 ? (
            <Link
              to={`/viaje/${trip.id}/asientos`}
              className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-control bg-brand-500 px-5 text-sm font-bold text-white shadow-sm transition hover:bg-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 active:scale-[0.98] lg:mt-2 lg:w-full"
            >
              Ver asientos
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </Link>
          ) : (
            <span className="inline-flex h-11 shrink-0 items-center justify-center rounded-control bg-slate-200 px-5 text-sm font-semibold text-slate-500 lg:mt-2 lg:w-full" aria-disabled>
              Agotado
            </span>
          )}
        </div>
      </div>
    </article>
  );
}
