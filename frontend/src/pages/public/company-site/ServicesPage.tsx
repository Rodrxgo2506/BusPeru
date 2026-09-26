import { Check, Search, Sparkles } from 'lucide-react';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui';
import { CompanyPageHero } from '@/components/company-site/CompanyPageHero';
import { multiline, OwnImage, SiteContainer, SiteEmpty, useCompanyPageMeta, useCompanySite } from '@/components/company-site/shared';
import { mediaUrl } from '@/services/api';
import { companySitePath, heroImagePath } from '@/utils/company-site';
import { cn } from '@/utils/cn';

/**
 * F18-20 · Servicios: una pestaña por cada servicio publicado (nada fijo en el código), pegadas a una tarjeta con
 * imagen (o ilustración si no hay) y el detalle. Pestañas accesibles: ←/→, Inicio y Fin mueven la selección.
 */
export function CompanyServicesPage() {
  const { data, slug, tripsUrl } = useCompanySite();
  useCompanyPageMeta('servicios', data, slug);
  const { company, profile, services } = data;
  const [active, setActive] = useState(0);
  const baseId = useId();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = active < services.length ? active : 0;
  const current = services[index];
  const image = mediaUrl(current?.image);

  const onKey = (event: KeyboardEvent) => {
    const last = services.length - 1;
    const next = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
        : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
    if (next === null) return;
    event.preventDefault();
    setActive(next);
    tabs.current[next]?.focus();
  };

  return (
    <>
      <CompanyPageHero
        image={heroImagePath('servicios', profile)}
        eyebrow={company.name}
        title="Servicios"
        subtitle={services.length > 0 ? 'Modalidades de viaje y comodidades a bordo.' : undefined}
        breadcrumb={[{ label: 'Inicio', to: companySitePath(slug) }, { label: 'Servicios' }]}
      />
      <section aria-label="Servicios de la empresa" className="py-14 sm:py-20">
        <SiteContainer>
          {!current ? (
            <SiteEmpty icon={<Sparkles className="h-7 w-7" />} title="Servicios en preparación" description={`${company.name} aún no ha publicado sus servicios.`} action={<Button to={tripsUrl} icon={<Search className="h-4 w-4" />}>Buscar viajes</Button>} />
          ) : (
            <>
              <div role="tablist" aria-label="Servicios" onKeyDown={onKey} className="scrollbar-none -mb-px flex gap-1 overflow-x-auto px-1 sm:px-4">
                {services.map((service, i) => (
                  <button
                    key={`${i}-${service.name}`}
                    ref={(el) => { tabs.current[i] = el; }}
                    id={`${baseId}-tab-${i}`}
                    type="button"
                    role="tab"
                    aria-selected={i === index}
                    aria-controls={`${baseId}-panel`}
                    tabIndex={i === index ? 0 : -1}
                    onClick={() => setActive(i)}
                    className={cn(
                      'shrink-0 whitespace-nowrap rounded-t-2xl px-5 py-3 text-sm font-bold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500',
                      i === index ? 'bg-white text-brand-600 shadow-[0_-4px_12px_-6px_rgba(15,23,42,0.18)] ring-1 ring-black/5' : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
                    )}
                  >
                    {service.name}
                  </button>
                ))}
              </div>
              <div
                id={`${baseId}-panel`}
                role="tabpanel"
                aria-labelledby={`${baseId}-tab-${index}`}
                tabIndex={0}
                className="relative z-10 grid gap-8 rounded-3xl bg-white p-5 shadow-elevated ring-1 ring-black/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 sm:p-8 lg:grid-cols-2 lg:items-center lg:gap-12"
              >
                <OwnImage
                  key={current.image ?? `sin-imagen-${index}`}
                  src={image ?? undefined}
                  alt={current.name}
                  className="aspect-[4/3] w-full animate-fade-in rounded-2xl object-cover"
                  loading="lazy"
                  decoding="async"
                  fallback={
                    <div className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-brand-500 via-brand-600 to-ink" aria-hidden>
                      <div className="absolute inset-0 opacity-[0.12] [background-image:radial-gradient(circle_at_1px_1px,white_1px,transparent_0)] [background-size:20px_20px]" />
                      <Sparkles className="h-16 w-16 text-white/85" />
                    </div>
                  }
                />
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-600">Servicio {index + 1} de {services.length}</p>
                  <h2 className="mt-2 text-2xl font-extrabold text-ink sm:text-3xl">{current.name}</h2>
                  {current.description && <p className={cn('mt-4 text-slate-600', multiline)}>{current.description}</p>}
                  {current.features && current.features.length > 0 && (
                    <>
                      <h3 className="mt-6 text-sm font-bold uppercase tracking-wide text-ink">Características</h3>
                      <ul className="mt-3 grid gap-2.5 sm:grid-cols-2">
                        {current.features.map((feature) => (
                          <li key={feature} className="flex items-start gap-2 text-sm text-slate-700">
                            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-500 text-white" aria-hidden><Check className="h-3.5 w-3.5" /></span>
                            {feature}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  <div className="mt-8">
                    <Button to={tripsUrl} icon={<Search className="h-4 w-4" />}>Buscar viajes</Button>
                  </div>
                </div>
              </div>
            </>
          )}
        </SiteContainer>
      </section>
    </>
  );
}
