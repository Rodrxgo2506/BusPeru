import { ArrowRight, CalendarDays, Check, MapPin, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui';
import { mediaUrl } from '@/services/api';
import type { CompanyDestinationCard, PublicCompanyProfile } from '@/types/company-profile';
import { searchTripsUrl } from '@/utils/company-profile';
import { bestOrigin, clip, tripDate } from '@/utils/company-site';
import { formatCurrency, formatDate } from '@/utils/format';
import { OwnImage } from './shared';

/** Enlace del buscador para un destino: el origen con la salida más próxima y esa fecha (o hoy si no hay). */
export function destinationTripsUrl(card: CompanyDestinationCard, companyId: number, today: string): string {
  const origin = bestOrigin(card.origins);
  return searchTripsUrl({ origin: origin?.city ?? null, destination: card.city, companyId, date: tripDate(origin?.next_departure_date ?? card.next_departure_date, today) });
}

/** F18-20 · tarjeta de destino (Inicio y Destinos). Imagen solo si el destino editorial tiene una propia. */
export function DestinationCard({ card, companyId, today, headingLevel = 'h3' }: { card: CompanyDestinationCard; companyId: number; today: string; headingLevel?: 'h2' | 'h3' }) {
  const image = mediaUrl(card.destination?.image);
  const Heading = headingLevel;
  const next = tripDate(card.next_departure_date, today) === card.next_departure_date ? card.next_departure_date : null;
  return (
    <article className="group flex flex-col overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-black/5 transition hover:-translate-y-0.5 hover:shadow-elevated">
      <div className="relative h-40 overflow-hidden bg-gradient-to-br from-brand-500 via-brand-600 to-ink">
        <OwnImage
          src={image ?? undefined}
          alt={card.city}
          className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
          loading="lazy"
          decoding="async"
          fallback={
            <div className="flex h-full items-center justify-center" aria-hidden>
              <div className="absolute inset-0 opacity-[0.12] [background-image:radial-gradient(circle_at_1px_1px,white_1px,transparent_0)] [background-size:18px_18px]" />
              <MapPin className="h-10 w-10 text-white/80" />
            </div>
          }
        />
        {card.min_price !== null && card.upcoming_trips > 0 && (
          <span className="absolute left-3 top-3 rounded-full bg-white/95 px-3 py-1 text-xs font-bold text-ink shadow-card">
            desde <span className="text-brand-600">{formatCurrency(card.min_price)}</span>
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col p-5">
        <Heading className="text-lg font-bold text-ink">{card.city}</Heading>
        {card.department && card.department !== card.city && <p className="text-sm text-muted">{card.department}</p>}
        <p className="mt-2 text-sm text-slate-600">Desde {card.origins.map((o) => o.city).join(', ')}</p>
        {card.destination?.subtitle && <p className="mt-1 text-sm text-slate-500">{card.destination.subtitle}</p>}
        <p className="mt-3 text-sm">
          {card.upcoming_trips > 0 ? (
            <>
              <strong className="text-ink">{card.upcoming_trips}</strong> {card.upcoming_trips === 1 ? 'viaje programado' : 'viajes programados'}
            </>
          ) : (
            <span className="text-muted">Sin viajes programados por ahora</span>
          )}
        </p>
        {next && (
          <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
            <CalendarDays className="h-3.5 w-3.5 text-brand-500" aria-hidden /> Próxima salida: {formatDate(next)}
          </p>
        )}
        <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 pt-5">
          <Button size="sm" to={destinationTripsUrl(card, companyId, today)} iconRight={<ArrowRight className="h-4 w-4" />} aria-label={`Ver viajes a ${card.city}`}>
            Ver viajes
          </Button>
          {card.destination && (
            <Link to={`/destinos/${card.destination.slug}`} className="text-sm font-semibold text-brand-600 hover:underline">
              Conoce {card.destination.name}
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}

/** F18-20 · resumen de un servicio (Inicio). El detalle completo está en Servicios. */
export function ServiceSummaryCard({ service }: { service: PublicCompanyProfile['services'][number] }) {
  const image = mediaUrl(service.image);
  return (
    <article className="flex flex-col overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-black/5">
      <OwnImage
        src={image ?? undefined}
        alt={service.name}
        className="aspect-[16/9] w-full object-cover"
        loading="lazy"
        decoding="async"
        fallback={
          <div className="flex aspect-[16/9] items-center justify-center bg-gradient-to-br from-brand-50 to-brand-100" aria-hidden>
            <Sparkles className="h-9 w-9 text-brand-500" />
          </div>
        }
      />
      <div className="flex flex-1 flex-col p-5">
        <h3 className="text-lg font-bold text-ink">{service.name}</h3>
        {service.description && <p className="mt-2 text-sm text-slate-600">{clip(service.description, 140)}</p>}
        {service.features && service.features.length > 0 && (
          <ul className="mt-4 space-y-1.5">
            {service.features.slice(0, 3).map((feature) => (
              <li key={feature} className="flex items-start gap-2 text-sm text-slate-700">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" aria-hidden /> {feature}
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}
