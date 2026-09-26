import { Building2, Clock, Mail, Map as MapIcon, MapPin, MessageCircle, Navigation, Phone } from 'lucide-react';
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui';
import { CompanyPageHero } from '@/components/company-site/CompanyPageHero';
import { SiteContainer, SiteEmpty, useCompanyPageMeta, useCompanySite } from '@/components/company-site/shared';
import { mediaUrl } from '@/services/api';
import type { PublicCompanyProfile } from '@/types/company-profile';
import {
  AGENCY_SERVICE_LABELS,
  directionsUrl,
  formatDayHours,
  formatSpecialHours,
  groupByCity,
  hasAnyHours,
  isValidCoordinate,
  osmEmbedUrl,
  osmLinkUrl,
  telUrl,
  upcomingSpecialHours,
  WEEK_DAYS,
  whatsappUrl,
} from '@/utils/company-profile';
import { companySitePath, heroImagePath } from '@/utils/company-site';
import { formatDate } from '@/utils/format';
import { cn } from '@/utils/cn';

type Agency = PublicCompanyProfile['agencies'][number] & { key: number };

/**
 * F18-20 · Agencias: pestañas por ciudad y, por agencia, el mapa (izquierda) y los datos (derecha). El mapa es
 * OpenStreetMap y solo se descarga cuando el visitante lo pide y la agencia tiene coordenadas válidas; nunca se
 * inventan coordenadas.
 */
export function CompanyAgenciesPage() {
  const { data, slug, today } = useCompanySite();
  useCompanyPageMeta('agencias', data, slug);
  const { company, profile, agencies } = data;
  // F18-19B (F-06): cada agencia se identifica por su posición (la vista pública no trae ids).
  const groups = useMemo(() => groupByCity(agencies.map((agency, key) => ({ ...agency, key }))), [agencies]);
  const [city, setCity] = useState<string | null>(null);
  const current = groups.find((group) => group.city === city) ?? groups[0];
  const baseId = useId();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = current ? groups.indexOf(current) : 0;

  const onKey = (event: KeyboardEvent) => {
    const last = groups.length - 1;
    const next = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
        : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
    if (next === null) return;
    event.preventDefault();
    setCity(groups[next]!.city);
    tabs.current[next]?.focus();
  };

  return (
    <>
      <CompanyPageHero
        image={heroImagePath('agencias', profile)}
        eyebrow={company.name}
        title="Agencias"
        subtitle={groups.length > 0 ? `${agencies.length} ${agencies.length === 1 ? 'agencia' : 'agencias'} en ${groups.length} ${groups.length === 1 ? 'ciudad' : 'ciudades'}.` : undefined}
        breadcrumb={[{ label: 'Inicio', to: companySitePath(slug) }, { label: 'Agencias' }]}
      />
      <section aria-label="Agencias por ciudad" className="py-14 sm:py-20">
        <SiteContainer>
          {!current ? (
            <SiteEmpty icon={<Building2 className="h-7 w-7" />} title="Agencias en preparación" description={`${company.name} aún no ha publicado sus agencias.`} />
          ) : (
            <>
              <div role="tablist" aria-label="Ciudades" onKeyDown={onKey} className="scrollbar-none flex gap-2 overflow-x-auto rounded-2xl bg-slate-100 p-1.5">
                {groups.map((group, i) => (
                  <button
                    key={group.city}
                    ref={(el) => { tabs.current[i] = el; }}
                    id={`${baseId}-tab-${i}`}
                    type="button"
                    role="tab"
                    aria-selected={i === index}
                    aria-controls={`${baseId}-panel`}
                    tabIndex={i === index ? 0 : -1}
                    onClick={() => setCity(group.city)}
                    className={cn(
                      'flex-1 shrink-0 whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-bold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                      i === index ? 'bg-brand-500 text-white shadow-card' : 'text-slate-600 hover:bg-white',
                    )}
                  >
                    {group.city} <span className="font-medium opacity-80">({group.items.length})</span>
                  </button>
                ))}
              </div>
              <div id={`${baseId}-panel`} role="tabpanel" aria-labelledby={`${baseId}-tab-${index}`} className="mt-8 space-y-8">
                {current.items.map((agency) => <AgencyCard key={agency.key} agency={agency as Agency} today={today} />)}
              </div>
            </>
          )}
        </SiteContainer>
      </section>
    </>
  );
}

function AgencyCard({ agency, today }: { agency: Agency; today: string }) {
  const [showMap, setShowMap] = useState(false);
  const [imageBroken, setImageBroken] = useState(false);
  const hasMap = isValidCoordinate(agency.latitude, agency.longitude);
  const image = imageBroken ? null : mediaUrl(agency.image);
  const tel = agency.phone ? telUrl(agency.phone) : null;
  const wa = agency.whatsapp ? whatsappUrl(agency.whatsapp) : null;
  const special = upcomingSpecialHours(agency.special_hours, today);

  return (
    <article className="grid overflow-hidden rounded-3xl bg-white shadow-elevated ring-1 ring-black/5 lg:grid-cols-[1fr_1.15fr]">
      {/* ------------------------------------------------ mapa */}
      <div className="relative min-h-[260px] bg-slate-100">
        {hasMap && showMap ? (
          <div className="flex h-full flex-col">
            <iframe
              title={`Mapa de ${agency.name}`}
              src={osmEmbedUrl(agency.latitude!, agency.longitude!)}
              className="h-full min-h-[300px] w-full flex-1 border-0"
              loading="lazy"
              referrerPolicy="no-referrer"
              sandbox="allow-scripts allow-same-origin allow-popups"
            />
            <a href={osmLinkUrl(agency.latitude!, agency.longitude!)} target="_blank" rel="noopener noreferrer" className="block bg-slate-50 px-3 py-1.5 text-right text-xs text-muted hover:text-brand-600">
              Ver mapa más grande · © colaboradores de OpenStreetMap
            </a>
          </div>
        ) : (
          <div className="relative flex h-full min-h-[260px] flex-col items-center justify-center gap-3 overflow-hidden p-6 text-center">
            {image ? (
              <>
                <img src={image} alt={agency.name} className="absolute inset-0 h-full w-full object-cover" loading="lazy" decoding="async" onError={() => setImageBroken(true)} />
                <div className="absolute inset-0 bg-ink/55" aria-hidden />
              </>
            ) : (
              <div className="absolute inset-0 bg-gradient-to-br from-slate-100 to-slate-200 [background-image:linear-gradient(rgba(15,23,42,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,0.06)_1px,transparent_1px)] [background-size:28px_28px]" aria-hidden />
            )}
            <span className={cn('relative flex h-14 w-14 items-center justify-center rounded-2xl shadow-card', image ? 'bg-white/90 text-brand-600' : 'bg-white text-brand-500')} aria-hidden>
              <MapIcon className="h-7 w-7" />
            </span>
            {hasMap ? (
              <div className="relative flex flex-wrap justify-center gap-2">
                <Button size="sm" icon={<MapIcon className="h-4 w-4" />} onClick={() => setShowMap(true)} aria-label={`Ver en el mapa la agencia ${agency.name}`}>
                  Ver en mapa
                </Button>
                <a href={directionsUrl(agency.latitude!, agency.longitude!)} target="_blank" rel="noopener noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-control bg-white px-3 text-sm font-semibold text-brand-600 shadow-card hover:bg-brand-50">
                  <Navigation className="h-4 w-4" aria-hidden /> Cómo llegar
                </a>
              </div>
            ) : (
              <p className={cn('relative max-w-xs text-sm font-medium', image ? 'text-white' : 'text-slate-600')}>No hay ubicación disponible para mostrar en el mapa.</p>
            )}
          </div>
        )}
      </div>

      {/* ------------------------------------------------ datos */}
      <div className="p-6 sm:p-8">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-600">{agency.city}{agency.department && agency.department !== agency.city ? ` · ${agency.department}` : ''}</p>
        <h2 className="mt-1 text-2xl font-extrabold text-ink">{agency.name}</h2>
        <p className="mt-4 flex items-start gap-2.5 text-slate-700">
          <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-brand-500" aria-hidden />
          <span>
            {agency.address}
            {agency.reference && <span className="block text-sm text-muted">Referencia: {agency.reference}</span>}
          </span>
        </p>
        {(tel || wa || agency.email) && (
          <ul className="mt-4 space-y-2 text-sm">
            {tel && <li><a href={tel} className="inline-flex items-center gap-2.5 font-semibold text-ink hover:text-brand-600"><Phone className="h-4 w-4 text-brand-500" aria-hidden /> {agency.phone}</a></li>}
            {wa && <li><a href={wa} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2.5 font-semibold text-ink hover:text-brand-600"><MessageCircle className="h-4 w-4 text-brand-500" aria-hidden /> WhatsApp {agency.whatsapp}</a></li>}
            {agency.email && <li><a href={`mailto:${agency.email}`} className="inline-flex items-center gap-2.5 break-all font-semibold text-ink hover:text-brand-600"><Mail className="h-4 w-4 text-brand-500" aria-hidden /> {agency.email}</a></li>}
          </ul>
        )}

        {agency.services && agency.services.length > 0 && (
          <div className="mt-5">
            <h3 className="text-sm font-bold text-ink">Servicios en esta agencia</h3>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {agency.services.map((code) => (
                <li key={code} className="rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">{AGENCY_SERVICE_LABELS[code]}</li>
              ))}
            </ul>
          </div>
        )}

        {hasAnyHours(agency.weekly_hours) && (
          <div className="mt-5">
            <h3 className="flex items-center gap-2 text-sm font-bold text-ink"><Clock className="h-4 w-4 text-brand-500" aria-hidden /> Horario de atención</h3>
            <table className="mt-2 w-full text-sm">
              <caption className="sr-only">Horario de atención de {agency.name}</caption>
              <tbody>
                {WEEK_DAYS.map((day) => (
                  <tr key={day.key} className="border-t border-border/70 first:border-t-0">
                    <th scope="row" className="py-1.5 pr-3 text-left font-medium text-slate-600">{day.label}</th>
                    <td className="py-1.5 text-right text-slate-800">{formatDayHours(agency.weekly_hours?.[day.key])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {special.length > 0 && (
          <ul className="mt-3 space-y-1 text-xs text-amber-900" aria-label="Horarios especiales">
            {special.map((day) => (
              <li key={day.date} className="rounded bg-amber-50 px-2 py-1">
                <strong>{formatDate(day.date)}</strong>: {formatSpecialHours(day)}{day.note ? ` · ${day.note}` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}
