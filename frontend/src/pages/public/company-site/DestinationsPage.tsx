import { MapPin, Route as RouteIcon, Search } from 'lucide-react';
import { Button } from '@/components/ui';
import { CompanyPageHero } from '@/components/company-site/CompanyPageHero';
import { DestinationCard } from '@/components/company-site/cards';
import { BlockHeading, SiteContainer, SiteEmpty, useCompanyPageMeta, useCompanySite } from '@/components/company-site/shared';
import { companySitePath, heroImagePath } from '@/utils/company-site';

/**
 * F18-20 · Destinos: todos los destinos de las rutas ACTIVAS de la empresa, con sus orígenes, viajes programados y
 * «Ver viajes» hacia el buscador real (origen con la salida más próxima y esa fecha).
 */
export function CompanyDestinationsPage() {
  const { data, slug, today, tripsUrl } = useCompanySite();
  useCompanyPageMeta('destinos', data, slug);
  const { company, profile, destinations } = data;
  const origins = [...new Set(destinations.flatMap((card) => card.origins.map((o) => o.city)))].sort((a, b) => a.localeCompare(b, 'es'));
  const routes = destinations.reduce((sum, card) => sum + card.origins.length, 0);

  return (
    <>
      <CompanyPageHero
        image={heroImagePath('destinos', profile)}
        eyebrow={company.name}
        title="Destinos"
        subtitle={destinations.length > 0 ? `${destinations.length} ${destinations.length === 1 ? 'destino' : 'destinos'} y ${routes} ${routes === 1 ? 'ruta' : 'rutas'} activas.` : undefined}
        breadcrumb={[{ label: 'Inicio', to: companySitePath(slug) }, { label: 'Destinos' }]}
      >
        <Button to={tripsUrl} size="lg" icon={<Search className="h-5 w-5" />}>Buscar viajes</Button>
      </CompanyPageHero>

      <section aria-labelledby="destinos-lista" className="py-14 sm:py-20">
        <SiteContainer>
          {destinations.length === 0 ? (
            <SiteEmpty icon={<MapPin className="h-7 w-7" />} title="Sin rutas activas por ahora" description={`${company.name} no tiene rutas activas publicadas en este momento.`} />
          ) : (
            <>
              <div className="flex flex-wrap items-end justify-between gap-4">
                <BlockHeading id="destinos-lista" eyebrow="A dónde viajamos" title="Elige tu destino" />
                {origins.length > 0 && (
                  <p className="flex items-center gap-2 text-sm text-slate-600">
                    <RouteIcon className="h-4 w-4 text-brand-500" aria-hidden /> Salidas desde {origins.join(', ')}
                  </p>
                )}
              </div>
              <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {destinations.map((card) => <DestinationCard key={card.city} card={card} companyId={company.id} today={today} headingLevel="h3" />)}
              </div>
            </>
          )}
        </SiteContainer>
      </section>
    </>
  );
}
