import { Building2 } from 'lucide-react';
import { Suspense, useCallback, useMemo } from 'react';
import { Outlet, useParams } from 'react-router-dom';
import { Button, EmptyState, ErrorState } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { usePageMeta } from '@/hooks/usePageMeta';
import { publicCompanyService } from '@/services/company-profile';
import { todayIso } from '@/utils/format';
import { CompanySiteFooter } from './CompanySiteFooter';
import { CompanySiteHeader } from './CompanySiteHeader';
import { buildTripsUrl, type CompanySiteContext } from './shared';

/**
 * F18-20 · armazón del sitio público de cada empresa (`/empresas/:slug/*`). Carga el perfil publicado UNA vez y lo
 * reparte a cada sección por el contexto del `Outlet`. Solo contenido aprobado: una empresa sin perfil publicado,
 * suspendida o no activa responde 404 en la API y aquí se ve «Empresa no encontrada» en cualquiera de sus rutas.
 */
export function CompanySiteLayout() {
  const { slug = '' } = useParams();
  const profile = useAsync(() => publicCompanyService.profile(slug), [slug]);
  const data = profile.data;
  const today = todayIso();

  const loadGalleryPage = useCallback(async (page: number) => (await publicCompanyService.gallery(slug, page)).data, [slug]);
  const loadReviews = useCallback(async (page: number) => {
    const result = await publicCompanyService.reviews(slug, page);
    return { rows: result.data, totalPages: result.pagination?.totalPages ?? 1 };
  }, [slug]);

  const context = useMemo<CompanySiteContext | null>(
    () => (data ? { data, slug: data.slug, today, tripsUrl: buildTripsUrl(data, today), loadGalleryPage, loadReviews } : null),
    [data, today, loadGalleryPage, loadReviews],
  );

  usePageMeta(profile.error?.status === 404 ? { title: 'Empresa no encontrada | BusPerú', description: 'Esta empresa no tiene un sitio público disponible en BusPerú.' } : null);

  if (profile.error) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16">
        {profile.error.status === 404 ? (
          <EmptyState
            title="Empresa no encontrada"
            description="Esta empresa no tiene un perfil público disponible o la dirección no es correcta."
            icon={<Building2 className="h-7 w-7" />}
            action={<Button to="/empresas">Ver empresas</Button>}
          />
        ) : (
          <ErrorState error={profile.error} onRetry={profile.reload} />
        )}
      </div>
    );
  }

  if (profile.loading || !context) return <CompanySiteSkeleton />;

  return (
    <div className="bg-white">
      <CompanySiteHeader slug={context.slug} name={context.data.company.name} logo={context.data.company.logo_url} tripsUrl={context.tripsUrl} />
      {/* Las páginas del sitio se cargan en un único fragmento: el límite de carga va aquí para que la cabecera y el
          pie de la empresa no parpadeen al cambiar de sección. */}
      <Suspense fallback={<SectionSkeleton />}>
        <Outlet context={context} />
      </Suspense>
      <CompanySiteFooter data={context.data} slug={context.slug} />
    </div>
  );
}

function CompanySiteSkeleton() {
  return (
    <div aria-busy="true" aria-label="Cargando el sitio de la empresa">
      <div className="h-14 bg-ink" />
      <SectionSkeleton />
    </div>
  );
}

function SectionSkeleton() {
  return (
    <div aria-busy="true">
      <div className="skeleton h-64 w-full rounded-none sm:h-72" />
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-10 sm:px-6 lg:px-8">
        <div className="skeleton h-8 w-72 max-w-full" />
        <div className="skeleton h-4 w-96 max-w-full" />
        <div className="grid gap-3 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => <div key={index} className="skeleton h-40 rounded-card" />)}
        </div>
      </div>
    </div>
  );
}
