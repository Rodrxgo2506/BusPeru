import { Bus, Check, Search, Users } from 'lucide-react';
import { Button } from '@/components/ui';
import { CompanyPageHero } from '@/components/company-site/CompanyPageHero';
import { BlockHeading, SiteContainer, SiteEmpty, useCompanyPageMeta, useCompanySite } from '@/components/company-site/shared';
import { capacityLabel } from '@/utils/company-profile';
import { companySitePath, heroImagePath } from '@/utils/company-site';

/**
 * F18-20 · Flota: buses ACTIVOS agrupados por tipo (capacidad y comodidades). El backend nunca envía placa, código,
 * marca ni ids; el modelo no tiene fotos de flota, así que cada tipo lleva una ilustración.
 */
export function CompanyFleetPage() {
  const { data, slug, tripsUrl } = useCompanySite();
  useCompanyPageMeta('flota', data, slug);
  const { company, profile, fleet } = data;
  const total = fleet.reduce((sum, group) => sum + group.buses, 0);

  return (
    <>
      <CompanyPageHero
        image={heroImagePath('flota', profile)}
        eyebrow={company.name}
        title="Flota"
        subtitle={total > 0 ? `${total} ${total === 1 ? 'bus activo' : 'buses activos'} en ${fleet.length} ${fleet.length === 1 ? 'tipo' : 'tipos'} de servicio.` : undefined}
        breadcrumb={[{ label: 'Inicio', to: companySitePath(slug) }, { label: 'Flota' }]}
      />
      <section aria-labelledby="flota-lista" className="py-14 sm:py-20">
        <SiteContainer>
          {fleet.length === 0 ? (
            <SiteEmpty icon={<Bus className="h-7 w-7" />} title="Flota en preparación" description={`${company.name} aún no tiene buses activos publicados.`} />
          ) : (
            <>
              <BlockHeading id="flota-lista" eyebrow="Nuestros buses" title="Viaja cómodo" align="center" />
              <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {fleet.map((group) => (
                  <article key={group.type} className="flex flex-col overflow-hidden rounded-3xl bg-white shadow-card ring-1 ring-black/5">
                    <div className="relative flex h-36 items-center justify-center overflow-hidden bg-gradient-to-br from-ink via-slate-800 to-brand-900" aria-hidden>
                      <div className="absolute inset-0 opacity-[0.1] [background-image:radial-gradient(circle_at_1px_1px,white_1px,transparent_0)] [background-size:18px_18px]" />
                      <Bus className="relative h-14 w-14 text-brand-400" />
                      <span className="absolute bottom-3 right-3 rounded-full bg-white/15 px-3 py-1 text-xs font-bold text-white">
                        {group.buses} {group.buses === 1 ? 'bus' : 'buses'}
                      </span>
                    </div>
                    <div className="flex flex-1 flex-col p-6">
                      <h3 className="text-xl font-bold text-ink">{group.type}</h3>
                      {group.description && <p className="mt-1 text-sm text-slate-600">{group.description}</p>}
                      <p className="mt-4 flex items-center gap-2 text-sm font-semibold text-slate-800">
                        <Users className="h-4 w-4 text-brand-500" aria-hidden /> Capacidad: {capacityLabel(group.min_capacity, group.max_capacity)}
                      </p>
                      {group.amenities.length > 0 && (
                        <>
                          <h4 className="mt-5 text-xs font-bold uppercase tracking-wide text-muted">Comodidades</h4>
                          <ul className="mt-2 grid grid-cols-2 gap-2">
                            {group.amenities.map((amenity) => (
                              <li key={amenity} className="flex items-center gap-1.5 text-sm text-slate-700">
                                <Check className="h-4 w-4 shrink-0 text-brand-500" aria-hidden /> {amenity}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  </article>
                ))}
              </div>
              <div className="mt-10 text-center">
                <Button to={tripsUrl} icon={<Search className="h-4 w-4" />}>Buscar viajes</Button>
              </div>
            </>
          )}
        </SiteContainer>
      </section>
    </>
  );
}
