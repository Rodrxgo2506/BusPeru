import { ArrowRight, Building2, CalendarClock, Headphones, HelpCircle, Percent, Wallet } from 'lucide-react';
import { Button, Card, EmptyState, ErrorState } from '@/components/ui';
import { CompanyCard, CompanyCardSkeleton } from '@/components/companies/CompanyCard';
import { PublicHero } from '@/components/common/PublicHero';
import { companiesHeroImage, helpHeroImage, offersHeroImage } from '@/constants/images';
import { useAsync } from '@/hooks/useAsync';
import { usePageMeta } from '@/hooks/usePageMeta';
import { publicService } from '@/services';
import { formatCurrency, formatDate, todayIso } from '@/utils/format';

export function CompaniesPage() {
  const companies = useAsync(() => publicService.companies(), []);
  // F18-19B (F-05): título y descripción propios (antes heredaba el genérico del sitio).
  usePageMeta({ title: 'Empresas de transporte interprovincial | BusPerú', description: 'Empresas de transporte verificadas que venden pasajes de bus interprovincial en BusPerú: rutas, agencias y opiniones.' });

  const list = companies.data ?? [];

  return (
    <PublicHero
      eyebrow="Transporte que conecta el Perú"
      title="Empresas de transporte"
      description="Empresas verificadas que operan en la plataforma BusPerú."
      image={companiesHeroImage}
      imagePosition="50% 55%"
    >
      {companies.error ? (
        <Card padded={false}>
          <ErrorState error={companies.error} onRetry={companies.reload} />
        </Card>
      ) : companies.loading ? (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 2 }).map((_, index) => (
            <CompanyCardSkeleton key={index} />
          ))}
        </div>
      ) : list.length === 0 ? (
        <Card padded={false}>
          <EmptyState
            title="No hay empresas activas todavía"
            description="Las empresas aparecen aquí una vez que su registro ha sido verificado."
            icon={<Building2 className="h-7 w-7" />}
          />
        </Card>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {list.map((company) => (
            <CompanyCard
              key={company.id}
              name={company.name}
              description={company.tagline ?? company.description}
              logoUrl={company.logo_url}
              rating={company.rating}
              reviewsCount={company.reviews_count}
              routesCount={company.routes_count}
              // F18-19: con perfil público aprobado, la tarjeta lleva al perfil; si no, al buscador como antes.
              to={company.slug ? `/empresas/${company.slug}` : `/buscar?company_id=${company.id}&date=${todayIso()}`}
            />
          ))}
        </div>
      )}
    </PublicHero>
  );
}

export function OffersPage() {
  const promotions = useAsync(() => publicService.promotions(), []);

  const list = promotions.data ?? [];

  return (
    <PublicHero
      eyebrow="Promociones para tu viaje"
      title="Ofertas y promociones"
      description="Descuentos vigentes publicados por BusPerú y sus empresas."
      image={offersHeroImage}
      imagePosition="50% 45%"
    >
      {promotions.error ? (
        <Card padded={false}>
          <ErrorState error={promotions.error} onRetry={promotions.reload} />
        </Card>
      ) : promotions.loading ? (
        <Card padded={false}>
          <div className="space-y-3 px-6 py-14 text-center">
            <div className="skeleton mx-auto h-14 w-14 rounded-full" />
            <div className="skeleton mx-auto h-5 w-56" />
            <div className="skeleton mx-auto h-4 w-72" />
          </div>
        </Card>
      ) : list.length === 0 ? (
        // Estado vacío REAL: si el backend no devuelve promociones, no se inventa ninguna.
        <Card padded={false}>
          <EmptyState
            title="No hay promociones activas"
            description="Vuelve pronto: publicamos nuevas ofertas constantemente."
            icon={<Percent className="h-7 w-7" />}
          />
        </Card>
      ) : (
        // Cuando el backend sí devuelve promociones, se pintan todas con sus datos reales.
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {list.map((promotion) => (
            <article
              key={promotion.id}
              className="flex flex-col rounded-card bg-white p-5 shadow-card ring-1 ring-black/5 transition duration-300 hover:-translate-y-1 hover:shadow-elevated sm:p-6"
            >
              <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-brand-500 px-3 py-1.5 text-sm font-bold text-white">
                <Percent className="h-4 w-4" aria-hidden />
                {promotion.discount_type === 'PERCENTAGE'
                  ? `${promotion.discount_value}% dscto.`
                  : `${formatCurrency(promotion.discount_value)} dscto.`}
              </span>

              <h2 className="mt-4 text-lg font-bold leading-snug text-ink">{promotion.name}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">
                {promotion.description ?? 'Promoción disponible por tiempo limitado.'}
              </p>

              <dl className="mt-4 space-y-1.5 border-t border-border pt-3 text-xs text-muted">
                <div className="flex items-center gap-2">
                  <dt className="sr-only">Vigencia</dt>
                  <CalendarClock className="h-4 w-4 shrink-0 text-brand-500" aria-hidden />
                  <dd>
                    {promotion.company_name ? `${promotion.company_name} · ` : ''}
                    Válida hasta {formatDate(promotion.end_at)}
                  </dd>
                </div>
                {promotion.minimum_amount !== null && (
                  <div className="flex items-center gap-2">
                    <dt className="sr-only">Compra mínima</dt>
                    <Wallet className="h-4 w-4 shrink-0 text-brand-500" aria-hidden />
                    <dd>Compra mínima: {formatCurrency(promotion.minimum_amount)}</dd>
                  </div>
                )}
              </dl>

              <Button variant="outline" size="sm" className="mt-5 w-fit" to="/">
                Buscar pasajes
              </Button>
            </article>
          ))}
        </div>
      )}
    </PublicHero>
  );
}

const FAQS = [
  { question: '¿Cómo compro un pasaje?', answer: 'Busca tu ruta y fecha en la página principal, elige el viaje, selecciona tus asientos, completa los datos del pasajero y realiza el pago.' },
  { question: '¿Puedo cancelar mi pasaje?', answer: 'Sí. Desde "Mis viajes" puedes solicitar la cancelación. Según la política de la plataforma, las cancelaciones con anticipación pueden generar un reembolso.' },
  { question: '¿Qué métodos de pago aceptan?', answer: 'Tarjeta de crédito o débito, Yape, Plin, transferencia bancaria y pago en efectivo en puntos autorizados.' },
  { question: '¿Cómo recibo mi pasaje?', answer: 'Al confirmar el pago recibes un código de reserva que puedes mostrar al abordar, y también lo enviamos a tu correo.' },
  { question: 'Soy una empresa de transporte, ¿cómo me registro?', answer: 'Ingresa a "Registrar mi empresa" desde el Portal Empresa. Nuestro equipo verificará tus datos antes de activar tu cuenta.' },
];

export function HelpPage() {
  usePageMeta({ title: 'Centro de ayuda y preguntas frecuentes | BusPerú', description: 'Respuestas sobre compras, pagos, cancelaciones y viajes en BusPerú, y cómo contactar con soporte.' });
  return (
    <PublicHero
      eyebrow="Estamos para ayudarte"
      title="Centro de ayuda"
      description="Resuelve tus dudas sobre BusPerú."
      image={helpHeroImage}
      imagePosition="50% 60%"
    >
      {/* Columna centrada y más estrecha que el ancho del titular, como en la referencia. */}
      <div className="mx-auto max-w-4xl">
        <div className="space-y-3.5">
          {FAQS.map((faq) => (
            /*
             * Se conserva `<details>`: el acordeón sigue siendo nativo, sin JavaScript, así
             * que abre y cierra igual que antes y funciona incluso sin hidratar.
             */
            <details
              key={faq.question}
              className="group overflow-hidden rounded-card bg-white shadow-card ring-1 ring-black/5 transition duration-300 open:shadow-panel hover:shadow-panel"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-5 marker:content-[''] sm:px-6">
                <span className="text-[15px] font-bold text-ink sm:text-base">{faq.question}</span>
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-500 transition group-open:bg-brand-500 group-open:text-white">
                  <HelpCircle className="h-[18px] w-[18px]" aria-hidden />
                </span>
              </summary>
              <p className="border-t border-border px-5 pb-5 pt-4 text-sm leading-relaxed text-muted sm:px-6">
                {faq.answer}
              </p>
            </details>
          ))}
        </div>

        {/* Bloque de soporte: mismo texto y mismo destino que ya tenía la página. */}
        <div className="mt-5 flex flex-col items-start gap-4 rounded-card bg-slate-50 p-5 ring-1 ring-black/5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="flex items-center gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-500">
              <Headphones className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="font-bold text-ink">¿No encuentras lo que buscas?</p>
              <p className="mt-0.5 text-sm text-muted">Crea un ticket de soporte y nuestro equipo te responderá.</p>
            </div>
          </div>

          <Button to="/customer/support" iconRight={<ArrowRight className="h-4 w-4" />} className="shrink-0">
            Contactar soporte
          </Button>
        </div>
      </div>
    </PublicHero>
  );
}

export function NotFoundPage() {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-lg flex-col items-center justify-center px-4 text-center">
      <p className="text-7xl font-extrabold text-brand-500">404</p>
      <h1 className="mt-4 text-2xl font-bold text-ink">Página no encontrada</h1>
      <p className="mt-2 text-muted">La página que buscas no existe o fue movida. Verifica la dirección o vuelve al inicio.</p>
      <Button className="mt-6" to="/">
        Volver al inicio
      </Button>
    </div>
  );
}
