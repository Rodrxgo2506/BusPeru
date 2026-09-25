import { BusFront, Clock3, Headphones, Lock, MapPin, Route, ShieldCheck, Users } from 'lucide-react';
import { TripSearchForm } from '@/components/common/TripSearchForm';
import { DiscoverDestinationsSection } from '@/components/destinations/DiscoverDestinations';
import {
  BenefitCard,
  DestinationCard,
  DestinationCardSkeleton,
  EmptyOffers,
  HomeHero,
  OfferCard,
  SectionHeading,
  StatCard,
} from '@/components/home/HomeSections';
import { Reveal } from '@/components/home/Reveal';
import { Card, ErrorState } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { publicService } from '@/services';
import { formatCurrency, formatNumber, todayIso } from '@/utils/format';

/**
 * Portada pública.
 *
 * Los cuatro `useAsync` y los datos que muestran son los mismos de siempre: ciudades para el
 * buscador, destinos, promociones y estadísticas, todos del backend. El rediseño es visual;
 * ningún valor se ha fijado a mano ni se ha inventado.
 */
export function HomePage() {
  const cities = useAsync(() => publicService.cities(), []);
  const destinations = useAsync(() => publicService.destinations(), []);
  const promotions = useAsync(() => publicService.promotions(), []);
  const stats = useAsync(() => publicService.stats(), []);

  const cityOptions = cities.data ?? [];
  const destinationList = destinations.data ?? [];
  const promotionList = promotions.data ?? [];

  return (
    <>
      <HomeHero>
        <Card className="mx-auto max-w-5xl p-4 shadow-elevated ring-1 ring-black/5 sm:p-6">
          <TripSearchForm cities={cityOptions.map((city) => city.city)} />
        </Card>
      </HomeHero>

      {/* Destinos populares ------------------------------------------------- */}
      <section className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-12">
        <Reveal>
          <SectionHeading title="Destinos populares" action={{ label: 'Ver todos los destinos', to: '/destinos' }} />

          {destinations.error ? (
            <Card padded={false}>
              <ErrorState error={destinations.error} onRetry={destinations.reload} />
            </Card>
          ) : destinations.loading ? (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, index) => (
                <DestinationCardSkeleton key={index} />
              ))}
            </div>
          ) : destinationList.length === 0 ? (
            <Card className="text-center text-sm text-muted">Aún no hay destinos con viajes programados.</Card>
          ) : (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {destinationList.slice(0, 4).map((item) => (
                <DestinationCard
                  key={item.city}
                  city={item.city}
                  minPrice={item.min_price}
                  to={`/buscar?destination=${encodeURIComponent(item.city)}&date=${todayIso()}`}
                />
              ))}
            </div>
          )}
        </Reveal>
      </section>

      {/* Descubre más destinos (FASE 17): fichas editoriales del CMS ----------- */}
      <DiscoverDestinationsSection />

      {/* Ofertas ------------------------------------------------------------- */}
      <section className="mx-auto max-w-7xl px-4 pb-10 sm:px-6 lg:px-8 lg:pb-12">
        <Reveal>
          <SectionHeading title="Ofertas especiales para ti" action={{ label: 'Ver todas las ofertas', to: '/ofertas' }} />

          {promotions.error ? (
            <Card padded={false}>
              <ErrorState error={promotions.error} onRetry={promotions.reload} />
            </Card>
          ) : promotions.loading ? (
            <div className="grid gap-5 md:grid-cols-2">
              <div className="skeleton h-[168px] rounded-card" />
              <div className="skeleton h-[168px] rounded-card" />
            </div>
          ) : promotionList.length === 0 ? (
            <EmptyOffers />
          ) : (
            <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              {promotionList.slice(0, 3).map((promotion, index) => (
                <OfferCard
                  key={promotion.id}
                  name={promotion.name}
                  featured={index === 0}
                  description={
                    promotion.description ??
                    (promotion.discount_type === 'PERCENTAGE'
                      ? `Hasta ${promotion.discount_value}% de descuento`
                      : `Descuento de ${formatCurrency(promotion.discount_value)}`)
                  }
                />
              ))}
            </div>
          )}
        </Reveal>
      </section>

      {/* Estadísticas -------------------------------------------------------- */}
      <section className="border-y border-border bg-gradient-to-b from-brand-50/70 to-brand-50/30">
        <div className="mx-auto grid max-w-7xl gap-x-6 gap-y-6 px-4 py-7 sm:grid-cols-2 sm:px-6 lg:grid-cols-4 lg:divide-x lg:divide-brand-100 lg:px-8 lg:py-8">
          {[
            { icon: BusFront, value: stats.data?.companies, label: 'Empresas de transporte', singular: 'Empresa de transporte' },
            { icon: Route, value: stats.data?.routes, label: 'Rutas disponibles', singular: 'Ruta disponible' },
            { icon: Users, value: stats.data?.bookings, label: 'Reservas realizadas', singular: 'Reserva realizada' },
            { icon: MapPin, value: stats.data?.terminals, label: 'Terminales conectados', singular: 'Terminal conectado' },
          ].map((item, index) => (
            <Reveal key={item.label} delay={index * 70}>
              <StatCard
                icon={item.icon}
                // Con una sola empresa el rótulo en plural desafinaba («1 Empresas de transporte»).
                label={item.value === 1 ? item.singular : item.label}
                // El «+» de los mockups sólo es honesto sobre una cifra redondeada hacia abajo, y
                // estas son cuentas EXACTAS de la base: con dos empresas anunciaba «+2», y con la
                // plataforma recién abierta llegaba a decir «+0 Reservas realizadas». Se muestra el
                // número tal cual; cuando la cifra crezca seguirá siendo cierta sin prometer de más.
                value={stats.loading ? '—' : formatNumber(item.value ?? 0)}
              />
            </Reveal>
          ))}
        </div>
      </section>

      {/* Beneficios ----------------------------------------------------------- */}
      <section className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
        <div className="grid gap-x-6 gap-y-6 sm:grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-border">
          {[
            { icon: Lock, title: 'Pago 100% seguro', description: 'Tus datos protegidos' },
            { icon: Clock3, title: 'Cancelación flexible', description: 'Hasta 24h antes del viaje' },
            { icon: Headphones, title: 'Atención 24/7', description: 'Siempre para ayudarte' },
            { icon: ShieldCheck, title: 'Empresas verificadas', description: 'Viaja con confianza' },
          ].map((item, index) => (
            <Reveal key={item.title} delay={index * 70}>
              <BenefitCard icon={item.icon} title={item.title} description={item.description} />
            </Reveal>
          ))}
        </div>
      </section>
    </>
  );
}
