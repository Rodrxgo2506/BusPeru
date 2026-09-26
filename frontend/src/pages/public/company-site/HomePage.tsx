import { ArrowRight, Building2, Bus, Mail, MapPin, MessageCircle, Phone, Search, Sparkles } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui';
import { CompanyContactForm, contactFormAvailable } from '@/components/company-site/CompanyContactForm';
import { CompanyPageHero } from '@/components/company-site/CompanyPageHero';
import { DestinationCard, ServiceSummaryCard } from '@/components/company-site/cards';
import { BlockHeading, companySocials, multiline, SiteContainer, SocialLinks, Stars, useCompanyPageMeta, useCompanySite } from '@/components/company-site/shared';
import { mediaUrl } from '@/services/api';
import { telUrl, whatsappUrl } from '@/utils/company-profile';
import { clip, companySitePath, heroImagePath, homeHighlights } from '@/utils/company-site';
import { cn } from '@/utils/cn';

/**
 * F18-20 · Inicio del sitio de la empresa: portada, presentación breve con contadores, destinos y servicios
 * DESTACADOS (con enlace a su página completa), llamada a reservar y «¿Necesitas ayuda?». No repite las páginas
 * completas de Servicios, Agencias ni Contacto.
 */
export function CompanyHomePage() {
  const { data, slug, today, tripsUrl } = useCompanySite();
  useCompanyPageMeta('inicio', data, slug);
  const { company, profile, reviews } = data;
  const logo = mediaUrl(company.logo_url);
  const highlights = homeHighlights(data.destinations, data.services);
  const intro = company.description ?? (profile.about_body ? clip(profile.about_body, 320) : null);
  const buses = data.fleet.reduce((sum, group) => sum + group.buses, 0);

  const stats: Array<{ label: string; value: number; icon: ReactNode; to: string }> = [
    { label: data.destinations.length === 1 ? 'Destino' : 'Destinos', value: data.destinations.length, icon: <MapPin className="h-5 w-5" />, to: companySitePath(slug, 'destinos') },
    { label: data.agencies.length === 1 ? 'Agencia' : 'Agencias', value: data.agencies.length, icon: <Building2 className="h-5 w-5" />, to: companySitePath(slug, 'agencias') },
    { label: data.services.length === 1 ? 'Servicio' : 'Servicios', value: data.services.length, icon: <Sparkles className="h-5 w-5" />, to: companySitePath(slug, 'servicios') },
    { label: buses === 1 ? 'Bus' : 'Buses', value: buses, icon: <Bus className="h-5 w-5" />, to: companySitePath(slug, 'flota') },
  ];

  return (
    <>
      <CompanyPageHero
        size="lg"
        image={heroImagePath('inicio', profile)}
        eyebrow="Empresa de transporte"
        title={company.name}
        leading={
          <span className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-2xl bg-white shadow-elevated ring-4 ring-white/20 sm:h-24 sm:w-24">
            {logo ? <img src={logo} alt={`Logotipo de ${company.name}`} className="max-h-full max-w-full object-contain p-2" /> : <Building2 className="h-10 w-10 text-brand-500" aria-hidden />}
          </span>
        }
        subtitle={
          <>
            {profile.tagline && <p>{profile.tagline}</p>}
            {reviews.total > 0 && reviews.rating !== null && (
              <Link to={companySitePath(slug, 'opiniones')} className="mt-3 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-sm hover:bg-white/20">
                <Stars value={reviews.rating} />
                <strong>{reviews.rating.toFixed(1)}</strong>
                <span className="text-white/80">· {reviews.total} {reviews.total === 1 ? 'opinión' : 'opiniones'}</span>
              </Link>
            )}
          </>
        }
      >
        <Button to={tripsUrl} size="lg" icon={<Search className="h-5 w-5" />}>Buscar viajes</Button>
        <Link
          to={companySitePath(slug, 'contacto')}
          className="inline-flex h-12 items-center rounded-control border border-white/60 px-6 text-base font-semibold text-white transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          Contacto
        </Link>
      </CompanyPageHero>

      {/* ---------------------------------------------------------------- presentación */}
      <section aria-labelledby="presentacion-titulo" className="py-14 sm:py-20">
        <SiteContainer className="grid gap-10 lg:grid-cols-[1.15fr_1fr] lg:items-center">
          <div>
            <BlockHeading id="presentacion-titulo" eyebrow="Bienvenido" title={`Viaja con ${company.name}`} />
            {intro ? <p className={cn('mt-4 max-w-2xl text-slate-600', multiline)}>{intro}</p> : <p className="mt-4 text-slate-600">Compra tus pasajes de {company.name} en BusPerú.</p>}
            <Link to={companySitePath(slug, 'nosotros')} className="mt-6 inline-flex items-center gap-1.5 font-semibold text-brand-600 hover:text-brand-700 hover:underline">
              Conoce más sobre nosotros <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
          <ul className="grid grid-cols-2 gap-4" aria-label="Resumen de la empresa">
            {stats.map((stat) => (
              <li key={stat.to}>
                <Link to={stat.to} className="block h-full rounded-2xl bg-slate-50 p-5 ring-1 ring-black/5 transition hover:bg-white hover:shadow-card hover:ring-brand-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-500 text-white" aria-hidden>{stat.icon}</span>
                  <span className="mt-3 block text-3xl font-extrabold text-ink">{stat.value}</span>
                  <span className="text-sm font-medium text-muted">{stat.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </SiteContainer>
      </section>

      {/* ---------------------------------------------------------------- destinos destacados */}
      {highlights.destinations.length > 0 && (
        <section aria-labelledby="destacados-destinos" className="bg-slate-50 py-14 sm:py-20">
          <SiteContainer>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <BlockHeading id="destacados-destinos" eyebrow="A dónde viajamos" title="Destinos destacados" />
              <Link to={companySitePath(slug, 'destinos')} className="inline-flex items-center gap-1.5 font-semibold text-brand-600 hover:underline">
                Ver todos los destinos <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </div>
            <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {highlights.destinations.map((card) => <DestinationCard key={card.city} card={card} companyId={company.id} today={today} />)}
            </div>
          </SiteContainer>
        </section>
      )}

      {/* ---------------------------------------------------------------- servicios destacados */}
      {highlights.services.length > 0 && (
        <section aria-labelledby="destacados-servicios" className="py-14 sm:py-20">
          <SiteContainer>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <BlockHeading id="destacados-servicios" eyebrow="Modalidades de viaje" title="Servicios destacados" />
              <Link to={companySitePath(slug, 'servicios')} className="inline-flex items-center gap-1.5 font-semibold text-brand-600 hover:underline">
                Ver servicios <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </div>
            <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {highlights.services.map((service, index) => <ServiceSummaryCard key={`${index}-${service.name}`} service={service} />)}
            </div>
          </SiteContainer>
        </section>
      )}

      {/* ---------------------------------------------------------------- llamada a reservar */}
      <section aria-labelledby="reserva-titulo" className="pb-14 sm:pb-20">
        <SiteContainer>
          <div className="relative isolate overflow-hidden rounded-3xl bg-gradient-to-r from-brand-500 to-brand-700 px-6 py-10 text-white shadow-elevated sm:px-10 lg:flex lg:items-center lg:justify-between lg:gap-8">
            <div className="absolute inset-0 -z-10 opacity-[0.12] [background-image:radial-gradient(circle_at_1px_1px,white_1px,transparent_0)] [background-size:22px_22px]" aria-hidden />
            <div>
              <h2 id="reserva-titulo" className="text-2xl font-extrabold sm:text-3xl">Reserva tu próximo viaje</h2>
              <p className="mt-2 max-w-xl text-white/90">Elige tu ruta, tu fecha y tu asiento, y compra tu pasaje de {company.name} en BusPerú.</p>
            </div>
            <div className="mt-6 flex flex-wrap gap-3 lg:mt-0 lg:shrink-0">
              <Link to={tripsUrl} className="inline-flex h-12 items-center gap-2 rounded-control bg-white px-6 font-semibold text-brand-700 shadow-card transition hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink">
                <Search className="h-5 w-5" aria-hidden /> Buscar viajes
              </Link>
              {data.destinations.length > 0 && (
                <Link to={companySitePath(slug, 'destinos')} className="inline-flex h-12 items-center rounded-control border border-white/70 px-6 font-semibold text-white transition hover:bg-white/10">
                  Ver destinos
                </Link>
              )}
            </div>
          </div>
        </SiteContainer>
      </section>

      <HelpSection />
    </>
  );
}

/** «¿Necesitas ayuda?»: formulario (izquierda) y canales y redes de la empresa (derecha); una columna en móvil. */
function HelpSection() {
  const { data, slug } = useCompanySite();
  const { company, profile } = data;
  const [broken, setBroken] = useState(false);
  const background = broken ? null : mediaUrl(profile.cover_image);
  const socials = companySocials(data);
  const tel = profile.contact_phone ? telUrl(profile.contact_phone) : null;
  const wa = profile.contact_whatsapp ? whatsappUrl(profile.contact_whatsapp) : null;
  const channels: Array<{ icon: ReactNode; label: string; value: ReactNode }> = [];
  if (tel) channels.push({ icon: <Phone className="h-5 w-5" />, label: 'Llámanos', value: <a href={tel} className="hover:underline">{profile.contact_phone}</a> });
  if (wa) channels.push({ icon: <MessageCircle className="h-5 w-5" />, label: 'WhatsApp', value: <a href={wa} target="_blank" rel="noopener noreferrer" className="hover:underline">{profile.contact_whatsapp}</a> });
  if (profile.contact_email) channels.push({ icon: <Mail className="h-5 w-5" />, label: 'Escríbenos', value: <a href={`mailto:${profile.contact_email}`} className="break-all hover:underline">{profile.contact_email}</a> });

  return (
    <section aria-labelledby="ayuda-titulo" className="relative isolate overflow-hidden bg-ink py-14 text-white sm:py-20">
      {background ? (
        <>
          <img src={background} alt="" aria-hidden className="absolute inset-0 -z-20 h-full w-full object-cover" loading="lazy" decoding="async" onError={() => setBroken(true)} />
          <div className="absolute inset-0 -z-10 bg-ink/80" aria-hidden />
        </>
      ) : (
        <div className="absolute inset-0 -z-10 bg-gradient-to-br from-ink via-ink to-brand-900" aria-hidden>
          <div className="absolute inset-0 opacity-[0.08] [background-image:radial-gradient(circle_at_1px_1px,white_1px,transparent_0)] [background-size:22px_22px]" />
        </div>
      )}
      <SiteContainer className="grid gap-8 lg:grid-cols-[1.3fr_1fr] lg:items-center lg:gap-12">
        <div className="rounded-3xl bg-white p-6 text-ink shadow-elevated sm:p-8">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-600">Atención al pasajero</p>
          <h2 id="ayuda-titulo" className="mt-2 text-2xl font-extrabold tracking-tight sm:text-3xl">¿Necesitas ayuda?</h2>
          <p className="mt-2 text-sm text-slate-600">Escríbenos tu consulta sobre horarios, equipaje o tu próximo viaje.</p>
          <div className="mt-6">
            {contactFormAvailable(data) ? (
              <CompanyContactForm data={data} subject="¿Necesitas ayuda?" idPrefix="ayuda" />
            ) : (
              <p className="rounded-control bg-slate-50 p-4 text-sm text-slate-600">
                {company.name} aún no ha publicado un correo ni un WhatsApp para recibir mensajes.{' '}
                {channels.length > 0 ? 'Usa los canales de la derecha.' : <>Consulta la <Link to="/ayuda" className="font-semibold text-brand-600 hover:underline">ayuda de BusPerú</Link>.</>}
              </p>
            )}
          </div>
        </div>
        <div>
          <h3 className="text-xl font-bold">Estamos para ayudarte</h3>
          {channels.length > 0 ? (
            <ul className="mt-5 space-y-4">
              {channels.map((channel) => (
                <li key={channel.label} className="flex items-start gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-500 text-white" aria-hidden>{channel.icon}</span>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-wide text-white/60">{channel.label}</p>
                    <p className="mt-0.5 font-semibold">{channel.value}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-white/75">La empresa aún no ha publicado canales de contacto.</p>
          )}
          {socials.length > 0 && (
            <div className="mt-8">
              <p className="text-xs font-semibold uppercase tracking-wide text-white/60">Síguenos</p>
              <SocialLinks socials={socials} tone="dark" className="mt-3" />
            </div>
          )}
          <Link to={companySitePath(slug, 'contacto')} className="mt-8 inline-flex items-center gap-1.5 font-semibold text-brand-300 hover:text-brand-200 hover:underline">
            Ir a la página de contacto <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </SiteContainer>
    </section>
  );
}

