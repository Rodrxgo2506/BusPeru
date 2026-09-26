import {
  ArrowRight,
  Building2,
  Bus,
  Check,
  Clock,
  Eye,
  Globe,
  Images,
  Mail,
  Map as MapIcon,
  MapPin,
  MessageCircle,
  Navigation,
  Phone,
  Quote,
  Search,
  Star,
  Target,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Modal } from '@/components/ui';
import { mediaUrl } from '@/services/api';
import type { PublicCompanyProfile, PublicCompanyReview, ReviewStatus } from '@/types/company-profile';
import {
  AGENCY_SERVICE_LABELS,
  capacityLabel,
  directionsUrl,
  formatDayHours,
  formatSpecialHours,
  GALLERY_CATEGORY_LABELS,
  groupByCity,
  hasAnyHours,
  isValidCoordinate,
  osmEmbedUrl,
  osmLinkUrl,
  ratingShare,
  REVIEW_STATUS_LABELS,
  safeExternalUrl,
  searchTripsUrl,
  SOCIAL_LABELS,
  telUrl,
  upcomingSpecialHours,
  WEEK_DAYS,
  whatsappUrl,
} from '@/utils/company-profile';
import { cn } from '@/utils/cn';
import { formatCurrency, formatDate, todayIso } from '@/utils/format';

/**
 * F18-19 · perfil de empresa: el MISMO componente pinta la página pública (`/empresas/:slug`, solo contenido
 * aprobado) y la vista previa del panel (copia de trabajo, marcada como tal). Todo el texto llega como texto
 * plano y React lo escapa; los enlaces externos pasan por `safeExternalUrl` (solo https).
 */

type SectionId = 'inicio' | 'nosotros' | 'servicios' | 'agencias' | 'destinos' | 'flota' | 'galeria' | 'opiniones' | 'contacto';

interface Props {
  data: PublicCompanyProfile;
  /** Carga más fotos de la galería (solo en la página pública). */
  loadGalleryPage?: (page: number) => Promise<PublicCompanyProfile['gallery']['items']>;
  /** Carga opiniones (solo en la página pública; la vista previa muestra el resumen). */
  loadReviews?: (page: number) => Promise<{ rows: PublicCompanyReview[]; totalPages: number }>;
}

const multiline = 'whitespace-pre-line break-words';

function StatusChip({ status }: { status?: ReviewStatus }) {
  if (!status) return null;
  const tone = status === 'APPROVED' ? 'success' : status === 'PENDING' ? 'warning' : status === 'REJECTED' ? 'danger' : 'neutral';
  return <Badge tone={tone}>{REVIEW_STATUS_LABELS[status]}</Badge>;
}

function Stars({ value, size = 'h-4 w-4' }: { value: number; size?: string }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${value} de 5 estrellas`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} className={cn(size, n <= Math.round(value) ? 'fill-amber-400 text-amber-400' : 'text-slate-300')} aria-hidden />
      ))}
    </span>
  );
}

function Section({ id, title, eyebrow, children }: { id: SectionId; title: string; eyebrow?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-titulo`} className="scroll-mt-32 border-t border-border py-10 first:border-t-0 sm:py-12">
      {eyebrow && <p className="text-xs font-semibold uppercase tracking-wider text-brand-600">{eyebrow}</p>}
      <h2 id={`${id}-titulo`} className="mt-1 text-2xl font-extrabold tracking-tight text-ink sm:text-3xl">
        {title}
      </h2>
      <div className="mt-6">{children}</div>
    </section>
  );
}

export function CompanyProfileView({ data, loadGalleryPage, loadReviews }: Props) {
  const { company, profile, reviews } = data;
  const preview = Boolean(data.preview);
  const logo = mediaUrl(company.logo_url);
  const cover = mediaUrl(profile.cover_image);
  const today = todayIso();
  const searchAll = `/buscar?company_id=${company.id}&date=${today}`;

  const hasAbout = Boolean(profile.about_body || profile.history || profile.mission || profile.vision || profile.values_list?.length);
  const socials = Object.entries(profile.social_links ?? {}).filter(([, url]) => safeExternalUrl(url));
  const website = safeExternalUrl(profile.website_url);
  const hasContact = Boolean(profile.contact_phone || profile.contact_whatsapp || profile.contact_email || website || socials.length || profile.main_address);

  const sections = useMemo(
    () =>
      ([
        ['inicio', 'Inicio', true],
        ['nosotros', 'Nosotros', hasAbout],
        ['servicios', 'Servicios', data.services.length > 0],
        ['agencias', 'Agencias', data.agencies.length > 0],
        ['destinos', 'Destinos', data.destinations.length > 0],
        ['flota', 'Flota', data.fleet.length > 0],
        ['galeria', 'Galería', data.gallery.total > 0],
        ['opiniones', 'Opiniones', true],
        ['contacto', 'Contacto', hasContact],
      ] as Array<[SectionId, string, boolean]>).filter(([, , visible]) => visible),
    [hasAbout, hasContact, data],
  );

  return (
    <div className="bg-white">
      {preview && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-center text-sm text-amber-900" role="status">
          <Eye className="mr-1.5 inline h-4 w-4" aria-hidden />
          <strong>Vista previa.</strong> Muestra tu copia de trabajo, incluido el contenido pendiente de aprobación. El público solo ve lo aprobado.
          {data.profile_status && <span className="ml-2 inline-block align-middle"><StatusChip status={data.profile_status} /></span>}
        </div>
      )}

      {/* ------------------------------------------------------------------ cabecera */}
      <header className="relative">
        <div className="relative h-48 overflow-hidden bg-gradient-to-br from-brand-500 via-brand-600 to-ink sm:h-64 lg:h-72">
          {cover && <img src={cover} alt="" aria-hidden className="h-full w-full object-cover" decoding="async" />}
          <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/10 to-transparent" aria-hidden />
        </div>
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
          {/* F18-19B (F-02): la portada es un elemento posicionado; este bloque también debe serlo (z-10, por debajo de
              la barra del sitio y de la navegación de secciones) o la portada se pinta encima. Solo el logo sube sobre
              la portada; el nombre y el lema quedan debajo, sobre fondo claro. */}
          <div className="relative z-10 flex flex-col items-center gap-4 text-center sm:flex-row sm:items-end sm:text-left">
            <span className="-mt-14 flex h-28 w-28 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-white shadow-elevated ring-4 ring-white sm:-mt-16 sm:h-32 sm:w-32">
              {logo ? (
                <img src={logo} alt={`Logotipo de ${company.name}`} className="max-h-full max-w-full object-contain p-2" />
              ) : (
                <Building2 className="h-12 w-12 text-brand-500" aria-hidden />
              )}
            </span>
            <div className="min-w-0 flex-1 pb-1 sm:pt-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-brand-600">Empresa de transporte</p>
              <h1 className="mt-1 text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">{company.name}</h1>
              {profile.tagline && <p className="mt-2 max-w-2xl text-base text-slate-600">{profile.tagline}</p>}
              {reviews.total > 0 && reviews.rating !== null && (
                <a href="#opiniones" className="mt-2 inline-flex items-center gap-2 text-sm text-slate-600 hover:text-brand-600">
                  <Stars value={reviews.rating} />
                  <strong className="text-ink">{reviews.rating.toFixed(1)}</strong>
                  <span>
                    · {reviews.total} {reviews.total === 1 ? 'opinión' : 'opiniones'}
                  </span>
                </a>
              )}
            </div>
            <div className="flex flex-wrap justify-center gap-2 pb-1">
              <Button to={searchAll} icon={<Search className="h-4 w-4" />}>
                Buscar viajes
              </Button>
              {hasContact && (
                <Button variant="outline" onClick={() => document.getElementById('contacto')?.scrollIntoView({ behavior: 'smooth' })}>
                  Contacto
                </Button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* ------------------------------------------------------------------ navegación interna */}
      <nav aria-label="Secciones del perfil" className="sticky top-16 z-20 mt-6 border-y border-border bg-white/95 backdrop-blur">
        <div className="scrollbar-none mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 sm:px-6 lg:px-8">
          {sections.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="whitespace-nowrap px-3 py-3 text-sm font-medium text-slate-600 transition hover:text-brand-600">
              {label}
            </a>
          ))}
        </div>
      </nav>

      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        {/* ------------------------------------------------------------------ inicio */}
        <Section id="inicio" title={`Viaja con ${company.name}`} eyebrow="Inicio">
          {company.description && <p className={cn('max-w-3xl text-slate-600', multiline)}>{company.description}</p>}
          <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'Destinos', value: data.destinations.length, icon: <MapPin className="h-5 w-5" /> },
              { label: 'Agencias', value: data.agencies.length, icon: <Building2 className="h-5 w-5" /> },
              { label: 'Servicios', value: data.services.length, icon: <Star className="h-5 w-5" /> },
              { label: 'Buses', value: data.fleet.reduce((sum, group) => sum + group.buses, 0), icon: <Bus className="h-5 w-5" /> },
            ].map((stat) => (
              <div key={stat.label} className="rounded-card bg-slate-50 p-4 ring-1 ring-black/5">
                <dt className="flex items-center gap-2 text-sm text-muted">
                  <span className="text-brand-500" aria-hidden>{stat.icon}</span>
                  {stat.label}
                </dt>
                <dd className="mt-1 text-2xl font-extrabold text-ink">{stat.value}</dd>
              </div>
            ))}
          </dl>
        </Section>

        {hasAbout && <AboutSection data={data} />}
        {data.services.length > 0 && <ServicesSection services={data.services} />}
        {data.agencies.length > 0 && <AgenciesSection agencies={data.agencies} today={today} />}
        {data.destinations.length > 0 && <DestinationsSection data={data} today={today} />}
        {data.fleet.length > 0 && <FleetSection data={data} />}
        {data.gallery.total > 0 && <GallerySection data={data} loadPage={loadGalleryPage} />}
        <ReviewsSection data={data} loadReviews={loadReviews} />
        {hasContact && <ContactSection data={data} website={website} socials={socials as Array<[keyof typeof SOCIAL_LABELS, string]>} />}
      </div>
    </div>
  );
}

// ================================================================================ Nosotros
function AboutSection({ data }: { data: PublicCompanyProfile }) {
  const { profile, company } = data;
  const image = mediaUrl(profile.about_image);
  return (
    <Section id="nosotros" title={profile.about_title || 'Nosotros'} eyebrow="Nosotros">
      <div className={cn('grid gap-8', image && 'lg:grid-cols-2 lg:items-start')}>
        {image && <img src={image} alt={`${company.name}: nosotros`} className="aspect-[4/3] w-full rounded-card object-cover shadow-card" loading="lazy" decoding="async" />}
        <div className="space-y-6">
          {profile.about_body && <p className={cn('text-slate-700', multiline)}>{profile.about_body}</p>}
          {profile.history && (
            <div>
              <h3 className="text-lg font-bold text-ink">Nuestra historia</h3>
              <p className={cn('mt-2 text-slate-600', multiline)}>{profile.history}</p>
            </div>
          )}
        </div>
      </div>
      {(profile.mission || profile.vision) && (
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {profile.mission && (
            <article className="rounded-card bg-brand-50 p-6 ring-1 ring-brand-100">
              <h3 className="flex items-center gap-2 text-lg font-bold text-ink">
                <Target className="h-5 w-5 text-brand-500" aria-hidden /> Misión
              </h3>
              <p className={cn('mt-2 text-slate-700', multiline)}>{profile.mission}</p>
            </article>
          )}
          {profile.vision && (
            <article className="rounded-card bg-slate-50 p-6 ring-1 ring-black/5">
              <h3 className="flex items-center gap-2 text-lg font-bold text-ink">
                <Eye className="h-5 w-5 text-brand-500" aria-hidden /> Visión
              </h3>
              <p className={cn('mt-2 text-slate-700', multiline)}>{profile.vision}</p>
            </article>
          )}
        </div>
      )}
      {profile.values_list && profile.values_list.length > 0 && (
        <div className="mt-8">
          <h3 className="text-lg font-bold text-ink">Nuestros valores</h3>
          <ul className="mt-3 flex flex-wrap gap-2">
            {profile.values_list.map((value) => (
              <li key={value} className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-sm font-semibold text-ink shadow-card ring-1 ring-black/5">
                <Check className="h-4 w-4 text-brand-500" aria-hidden />
                {value}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

// ================================================================================ Servicios
function ServicesSection({ services }: { services: PublicCompanyProfile['services'] }) {
  // F18-19B (F-06): la pestaña activa se recuerda por posición; la vista pública ya no trae ids internos.
  const [active, setActive] = useState(0);
  const index = active < services.length ? active : 0;
  const current = services[index]!;
  const image = mediaUrl(current.image);
  return (
    <Section id="servicios" title="Servicios" eyebrow="Modalidades de viaje">
      <div className="scrollbar-none -mx-1 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Servicios">
        {services.map((service, i) => (
          <button
            key={`${i}-${service.name}`}
            type="button"
            role="tab"
            aria-selected={i === index}
            onClick={() => setActive(i)}
            className={cn(
              'whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold transition',
              i === index ? 'bg-brand-500 text-white shadow-card' : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
            )}
          >
            {service.name}
          </button>
        ))}
      </div>
      <div role="tabpanel" className={cn('mt-6 grid gap-8', image && 'lg:grid-cols-2 lg:items-center')}>
        {image && <img src={image} alt={current.name} className="aspect-[4/3] w-full rounded-card object-cover shadow-card" loading="lazy" decoding="async" />}
        <div>
          <h3 className="flex flex-wrap items-center gap-2 text-2xl font-bold text-ink">
            {current.name} <StatusChip status={current.review_status} />
          </h3>
          {current.description && <p className={cn('mt-3 text-slate-600', multiline)}>{current.description}</p>}
          {current.features && current.features.length > 0 && (
            <ul className="mt-5 grid gap-2 sm:grid-cols-2">
              {current.features.map((feature) => (
                <li key={feature} className="flex items-start gap-2 text-sm text-slate-700">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" aria-hidden />
                  {feature}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Section>
  );
}

// ================================================================================ Agencias
function AgenciesSection({ agencies, today }: { agencies: PublicCompanyProfile['agencies']; today: string }) {
  // F18-19B (F-06): cada agencia se identifica por su posición en la lista (la vista pública no trae ids).
  const groups = useMemo(() => groupByCity(agencies.map((agency, key) => ({ ...agency, key }))), [agencies]);
  const [city, setCity] = useState(groups[0]!.city);
  const current = groups.find((group) => group.city === city) ?? groups[0]!;
  const [mapFor, setMapFor] = useState<number | null>(null);

  return (
    <Section id="agencias" title="Agencias" eyebrow="Dónde encontrarnos">
      {groups.length > 1 && (
        <div className="scrollbar-none -mx-1 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Ciudades">
          {groups.map((group) => (
            <button
              key={group.city}
              type="button"
              role="tab"
              aria-selected={group.city === current.city}
              onClick={() => {
                setCity(group.city);
                setMapFor(null);
              }}
              className={cn(
                'whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold transition',
                group.city === current.city ? 'bg-brand-500 text-white shadow-card' : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
              )}
            >
              {group.city} <span className="opacity-75">({group.items.length})</span>
            </button>
          ))}
        </div>
      )}

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        {current.items.map((agency) => {
          const hasMap = isValidCoordinate(agency.latitude, agency.longitude);
          const image = mediaUrl(agency.image);
          const wa = agency.whatsapp ? whatsappUrl(agency.whatsapp) : null;
          const tel = agency.phone ? telUrl(agency.phone) : null;
          const special = upcomingSpecialHours(agency.special_hours, today);
          return (
            <article key={agency.key} className="overflow-hidden rounded-card bg-white shadow-card ring-1 ring-black/5">
              {image && <img src={image} alt={agency.name} className="aspect-[16/7] w-full object-cover" loading="lazy" decoding="async" />}
              <div className="p-5">
                <h3 className="flex flex-wrap items-center gap-2 text-lg font-bold text-ink">
                  {agency.name} <StatusChip status={agency.review_status} />
                </h3>
                <p className="mt-2 flex items-start gap-2 text-sm text-slate-600">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" aria-hidden />
                  <span>
                    {agency.address}, {agency.city}
                    {agency.department && agency.department !== agency.city ? ` (${agency.department})` : ''}
                    {agency.reference && <span className="block text-xs text-muted">Referencia: {agency.reference}</span>}
                  </span>
                </p>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {tel && (
                    <a href={tel} className="inline-flex items-center gap-1.5 text-brand-600 hover:underline">
                      <Phone className="h-4 w-4" aria-hidden /> {agency.phone}
                    </a>
                  )}
                  {wa && (
                    <a href={wa} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-emerald-700 hover:underline">
                      <MessageCircle className="h-4 w-4" aria-hidden /> WhatsApp
                    </a>
                  )}
                  {agency.email && (
                    <a href={`mailto:${agency.email}`} className="inline-flex items-center gap-1.5 text-brand-600 hover:underline">
                      <Mail className="h-4 w-4" aria-hidden /> {agency.email}
                    </a>
                  )}
                </div>

                {agency.services && agency.services.length > 0 && (
                  <ul className="mt-4 flex flex-wrap gap-1.5" aria-label="Servicios de la agencia">
                    {agency.services.map((code) => (
                      <li key={code} className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700">
                        {AGENCY_SERVICE_LABELS[code]}
                      </li>
                    ))}
                  </ul>
                )}

                {hasAnyHours(agency.weekly_hours) && (
                  <details className="group mt-4 rounded-control bg-slate-50 px-3 py-2">
                    <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-ink marker:content-['']">
                      <Clock className="h-4 w-4 text-brand-500" aria-hidden /> Horario de atención
                    </summary>
                    <table className="mt-2 w-full text-sm">
                      <tbody>
                        {WEEK_DAYS.map((day) => (
                          <tr key={day.key} className="border-t border-border/60 first:border-t-0">
                            <th scope="row" className="py-1 pr-3 text-left font-medium text-slate-600">{day.label}</th>
                            <td className="py-1 text-right text-slate-700">{formatDayHours(agency.weekly_hours?.[day.key])}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )}
                {special.length > 0 && (
                  <ul className="mt-3 space-y-1 text-xs text-amber-900">
                    {special.map((day) => (
                      <li key={day.date} className="rounded bg-amber-50 px-2 py-1">
                        <strong>{formatDate(day.date)}</strong>: {formatSpecialHours(day)}
                        {day.note ? ` · ${day.note}` : ''}
                      </li>
                    ))}
                  </ul>
                )}

                {hasMap && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" icon={<MapIcon className="h-4 w-4" />} onClick={() => setMapFor(mapFor === agency.key ? null : agency.key)} aria-expanded={mapFor === agency.key}>
                      {mapFor === agency.key ? 'Ocultar mapa' : 'Ver en mapa'}
                    </Button>
                    <a
                      href={directionsUrl(agency.latitude!, agency.longitude!)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-control px-3 py-1.5 text-sm font-semibold text-brand-600 hover:bg-brand-50"
                    >
                      <Navigation className="h-4 w-4" aria-hidden /> Cómo llegar
                    </a>
                  </div>
                )}
                {hasMap && mapFor === agency.key && (
                  <div className="mt-3 overflow-hidden rounded-control ring-1 ring-black/10">
                    {/* El mapa (OpenStreetMap, sin clave ni coste) solo se descarga cuando se pide. */}
                    <iframe
                      title={`Mapa de ${agency.name}`}
                      src={osmEmbedUrl(agency.latitude!, agency.longitude!)}
                      className="h-64 w-full border-0"
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      sandbox="allow-scripts allow-same-origin allow-popups"
                    />
                    <a href={osmLinkUrl(agency.latitude!, agency.longitude!)} target="_blank" rel="noopener noreferrer" className="block bg-slate-50 px-3 py-1.5 text-right text-xs text-muted hover:text-brand-600">
                      Ver mapa más grande · © colaboradores de OpenStreetMap
                    </a>
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </Section>
  );
}

// ================================================================================ Destinos
function DestinationsSection({ data, today }: { data: PublicCompanyProfile; today: string }) {
  return (
    <Section id="destinos" title="Destinos" eyebrow="A dónde viajamos">
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {data.destinations.map((card) => {
          const image = mediaUrl(card.destination?.image);
          const origin = card.origins[0]?.city ?? null;
          return (
            <article key={card.city} className="flex flex-col overflow-hidden rounded-card bg-white shadow-card ring-1 ring-black/5">
              <div className="relative h-36 bg-gradient-to-br from-brand-100 to-brand-50">
                {image && <img src={image} alt={card.city} className="h-full w-full object-cover" loading="lazy" decoding="async" />}
              </div>
              <div className="flex flex-1 flex-col p-5">
                <h3 className="text-lg font-bold text-ink">{card.city}</h3>
                {card.department && card.department !== card.city && <p className="text-sm text-muted">{card.department}</p>}
                <p className="mt-2 text-sm text-slate-600">Desde {card.origins.map((o) => o.city).join(', ')}</p>
                {card.destination?.subtitle && <p className="mt-1 text-sm text-slate-500">{card.destination.subtitle}</p>}
                <p className="mt-3 text-sm">
                  {card.upcoming_trips > 0 ? (
                    <>
                      <strong className="text-ink">{card.upcoming_trips}</strong> {card.upcoming_trips === 1 ? 'viaje programado' : 'viajes programados'}
                      {card.min_price !== null && <> · desde <strong className="text-brand-600">{formatCurrency(card.min_price)}</strong></>}
                    </>
                  ) : (
                    <span className="text-muted">Sin viajes programados por ahora</span>
                  )}
                </p>
                <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
                  <Button size="sm" to={searchTripsUrl({ origin, destination: card.city, companyId: data.company.id, date: today })} iconRight={<ArrowRight className="h-4 w-4" />}>
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
        })}
      </div>
    </Section>
  );
}

// ================================================================================ Flota
function FleetSection({ data }: { data: PublicCompanyProfile }) {
  return (
    <Section id="flota" title="Flota" eyebrow="Nuestros buses">
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {data.fleet.map((group) => (
          <article key={group.type} className="rounded-card bg-white p-5 shadow-card ring-1 ring-black/5">
            <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
              <Bus className="h-5 w-5" aria-hidden />
            </span>
            <h3 className="mt-3 text-lg font-bold text-ink">{group.type}</h3>
            {group.description && <p className="mt-1 text-sm text-slate-600">{group.description}</p>}
            <p className="mt-3 flex items-center gap-2 text-sm text-slate-700">
              <Users className="h-4 w-4 text-brand-500" aria-hidden />
              {group.buses} {group.buses === 1 ? 'bus' : 'buses'} · {capacityLabel(group.min_capacity, group.max_capacity)}
            </p>
            {group.amenities.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {group.amenities.map((amenity) => (
                  <li key={amenity} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">{amenity}</li>
                ))}
              </ul>
            )}
          </article>
        ))}
      </div>
    </Section>
  );
}

// ================================================================================ Galería
function GallerySection({ data, loadPage }: { data: PublicCompanyProfile; loadPage?: Props['loadGalleryPage'] }) {
  const [items, setItems] = useState(data.gallery.items);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  // F18-19B (F-06): cada foto se identifica por su archivo (nombre aleatorio y único), no por un id interno.
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    setItems(data.gallery.items);
    setPage(1);
  }, [data.gallery.items]);
  const more = loadPage && items.length < data.gallery.total;
  const selected = items.find((item) => item.image === open) ?? null;

  const loadMore = async () => {
    if (!loadPage) return;
    setLoading(true);
    try {
      const next = await loadPage(page + 1);
      setItems((current) => [...current, ...next.filter((item) => !current.some((c) => c.image === item.image))]);
      setPage(page + 1);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Section id="galeria" title="Galería" eyebrow="Conócenos">
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((item) => (
          <li key={item.image}>
            <button type="button" onClick={() => setOpen(item.image)} className="group relative block w-full overflow-hidden rounded-card ring-1 ring-black/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
              <img
                src={mediaUrl(item.image) ?? ''}
                alt={item.title ?? GALLERY_CATEGORY_LABELS[item.category]}
                className="aspect-square w-full object-cover transition duration-300 group-hover:scale-105"
                loading="lazy"
                decoding="async"
                width={item.width ?? undefined}
                height={item.height ?? undefined}
              />
              {'review_status' in item && item.review_status && (
                <span className="absolute left-2 top-2"><StatusChip status={item.review_status} /></span>
              )}
              {item.title && <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-3 pb-2 pt-6 text-left text-xs font-semibold text-white">{item.title}</span>}
            </button>
          </li>
        ))}
      </ul>
      {more && (
        <div className="mt-6 text-center">
          <Button variant="outline" loading={loading} icon={<Images className="h-4 w-4" />} onClick={() => void loadMore()}>
            Ver más fotos
          </Button>
        </div>
      )}
      <Modal open={selected !== null} onClose={() => setOpen(null)} title={selected?.title ?? 'Galería'} size="lg">
        {selected && (
          <figure>
            <img src={mediaUrl(selected.image) ?? ''} alt={selected.title ?? ''} className="max-h-[70vh] w-full rounded-control object-contain" />
            {selected.description && <figcaption className="mt-3 text-sm text-slate-600">{selected.description}</figcaption>}
          </figure>
        )}
      </Modal>
    </Section>
  );
}

// ================================================================================ Opiniones
function ReviewsSection({ data, loadReviews }: { data: PublicCompanyProfile; loadReviews?: Props['loadReviews'] }) {
  const { reviews } = data;
  const ref = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<PublicCompanyReview[]>([]);
  const [page, setPage] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = async (next: number) => {
    if (!loadReviews) return;
    setLoading(true);
    setFailed(false);
    try {
      const result = await loadReviews(next);
      setRows((current) => (next === 1 ? result.rows : [...current, ...result.rows]));
      setTotalPages(result.totalPages);
      setPage(next);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  // Las opiniones se piden cuando la sección se acerca a la pantalla: la página no paga una petición
  // que el visitante quizá nunca vea.
  useEffect(() => {
    if (!loadReviews || reviews.total === 0 || !ref.current) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        void load(1);
      }
    }, { rootMargin: '400px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadReviews, reviews.total]);

  return (
    <Section id="opiniones" title="Opiniones" eyebrow="Lo que dicen los pasajeros">
      <div ref={ref}>
        {reviews.total === 0 || reviews.rating === null ? (
          <p className="rounded-card bg-slate-50 p-6 text-center text-sm text-muted">
            Aún no hay opiniones publicadas. Solo pueden opinar pasajeros con un viaje realizado con la empresa.
          </p>
        ) : (
          <div className="grid gap-8 lg:grid-cols-[280px_1fr]">
            <div className="rounded-card bg-slate-50 p-6 text-center ring-1 ring-black/5 lg:self-start">
              <p className="text-5xl font-extrabold text-ink">{reviews.rating.toFixed(1)}</p>
              <div className="mt-2 flex justify-center"><Stars value={reviews.rating} size="h-5 w-5" /></div>
              <p className="mt-1 text-sm text-muted">{reviews.total} {reviews.total === 1 ? 'opinión' : 'opiniones'}</p>
              <ul className="mt-4 space-y-1.5 text-left">
                {[5, 4, 3, 2, 1].map((stars) => (
                  <li key={stars} className="flex items-center gap-2 text-xs text-slate-600">
                    <span className="w-3">{stars}</span>
                    <Star className="h-3 w-3 fill-amber-400 text-amber-400" aria-hidden />
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200">
                      <span className="block h-full rounded-full bg-amber-400" style={{ width: `${ratingShare(reviews.distribution, stars, reviews.total)}%` }} />
                    </span>
                    <span className="w-8 text-right">{reviews.distribution[String(stars)] ?? 0}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              {!loadReviews ? (
                <p className="text-sm text-muted">Las opiniones se muestran en la página pública.</p>
              ) : failed ? (
                <p className="text-sm text-danger-600">No se pudieron cargar las opiniones. <button type="button" className="underline" onClick={() => void load(1)}>Reintentar</button></p>
              ) : (
                <ul className="space-y-4">
                  {rows.map((review, i) => (
                    <li key={i} className="rounded-card bg-white p-5 shadow-card ring-1 ring-black/5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Stars value={review.rating} />
                        <span className="text-xs text-muted">{review.first_name} · {formatDate(review.created_at)}</span>
                      </div>
                      {review.title && <h3 className="mt-2 font-bold text-ink">{review.title}</h3>}
                      {review.comment && <p className={cn('mt-1 text-sm text-slate-600', multiline)}>{review.comment}</p>}
                      {review.company_response && (
                        <div className="mt-3 rounded-control border-l-4 border-brand-300 bg-brand-50/60 px-4 py-3 text-sm">
                          <p className="flex items-center gap-1.5 font-semibold text-brand-700"><Quote className="h-3.5 w-3.5" aria-hidden /> Respuesta de {data.company.name}</p>
                          <p className={cn('mt-1 text-slate-700', multiline)}>{review.company_response}</p>
                        </div>
                      )}
                    </li>
                  ))}
                  {loading && <li className="skeleton h-24 rounded-card" aria-hidden />}
                </ul>
              )}
              {loadReviews && !failed && page > 0 && page < totalPages && (
                <div className="mt-4">
                  <Button variant="outline" size="sm" loading={loading} onClick={() => void load(page + 1)}>Ver más opiniones</Button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}

// ================================================================================ Contacto
function ContactSection({ data, website, socials }: { data: PublicCompanyProfile; website: string | null; socials: Array<[keyof typeof SOCIAL_LABELS, string]> }) {
  const { profile } = data;
  const tel = profile.contact_phone ? telUrl(profile.contact_phone) : null;
  const wa = profile.contact_whatsapp ? whatsappUrl(profile.contact_whatsapp) : null;
  const rows: Array<{ icon: ReactNode; label: string; value: ReactNode }> = [];
  if (profile.contact_phone) rows.push({ icon: <Phone className="h-5 w-5" />, label: 'Teléfono', value: tel ? <a href={tel} className="hover:underline">{profile.contact_phone}</a> : profile.contact_phone });
  if (profile.contact_whatsapp && wa) rows.push({ icon: <MessageCircle className="h-5 w-5" />, label: 'WhatsApp', value: <a href={wa} target="_blank" rel="noopener noreferrer" className="hover:underline">{profile.contact_whatsapp}</a> });
  if (profile.contact_email) rows.push({ icon: <Mail className="h-5 w-5" />, label: 'Correo', value: <a href={`mailto:${profile.contact_email}`} className="break-all hover:underline">{profile.contact_email}</a> });
  if (website) rows.push({ icon: <Globe className="h-5 w-5" />, label: 'Sitio web', value: <a href={website} target="_blank" rel="noopener noreferrer" className="break-all hover:underline">{new URL(website).host}</a> });
  if (profile.main_address) rows.push({ icon: <MapPin className="h-5 w-5" />, label: 'Dirección principal', value: profile.main_address });

  return (
    <Section id="contacto" title="Contacto" eyebrow="Escríbenos o llámanos">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => (
          <div key={row.label} className="flex items-start gap-3 rounded-card bg-slate-50 p-4 ring-1 ring-black/5">
            <span className="text-brand-500" aria-hidden>{row.icon}</span>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">{row.label}</p>
              <p className="mt-0.5 text-sm font-medium text-ink">{row.value}</p>
            </div>
          </div>
        ))}
      </div>
      {socials.length > 0 && (
        <ul className="mt-5 flex flex-wrap gap-2" aria-label="Redes sociales">
          {socials.map(([network, url]) => (
            <li key={network}>
              <a href={safeExternalUrl(url)!} target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-full bg-white px-4 py-2 text-sm font-semibold text-ink shadow-card ring-1 ring-black/5 hover:text-brand-600">
                {SOCIAL_LABELS[network]}
              </a>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
