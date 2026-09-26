import { Building2 } from 'lucide-react';
import { useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { CompanyProfileView } from '@/components/company-profile/CompanyProfileView';
import { Button, EmptyState, ErrorState } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { usePageMeta } from '@/hooks/usePageMeta';
import { mediaUrl } from '@/services/api';
import { publicCompanyService } from '@/services/company-profile';
import { safeExternalUrl } from '@/utils/company-profile';
import { canonicalUrl } from '@/utils/seo';

/**
 * F18-19 · perfil público de una empresa (`/empresas/:slug`). Solo contenido aprobado por BusPerú: una
 * empresa sin perfil publicado, suspendida o no activa responde 404 y aquí se ve «no encontrada».
 */
export function CompanyProfilePage() {
  const { slug = '' } = useParams();
  const profile = useAsync(() => publicCompanyService.profile(slug), [slug]);
  const data = profile.data;

  usePageMeta(
    data
      ? {
          title: `${data.company.name} · Pasajes, agencias y destinos | BusPerú`,
          description: (data.profile.tagline ?? data.company.description ?? `Perfil de ${data.company.name} en BusPerú: servicios, agencias, destinos y opiniones.`).slice(0, 160),
          image: mediaUrl(data.profile.cover_image) ?? mediaUrl(data.company.logo_url),
          jsonLd: {
            '@context': 'https://schema.org',
            '@type': 'Organization',
            name: data.company.name,
            url: canonicalUrl(window.location.origin, window.location.pathname),
            ...(data.company.logo_url ? { logo: mediaUrl(data.company.logo_url) } : {}),
            ...(data.profile.tagline ? { description: data.profile.tagline } : {}),
            ...(data.profile.contact_phone ? { telephone: data.profile.contact_phone } : {}),
            ...(data.profile.contact_email ? { email: data.profile.contact_email } : {}),
            sameAs: [data.profile.website_url, ...Object.values(data.profile.social_links ?? {})].map((url) => safeExternalUrl(url)).filter(Boolean),
          },
        }
      : null,
  );

  const loadGalleryPage = useCallback(async (page: number) => (await publicCompanyService.gallery(slug, page)).data, [slug]);
  const loadReviews = useCallback(async (page: number) => {
    const result = await publicCompanyService.reviews(slug, page);
    return { rows: result.data, totalPages: result.pagination?.totalPages ?? 1 };
  }, [slug]);

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

  if (profile.loading || !data) {
    return (
      <div aria-busy="true" aria-label="Cargando perfil de la empresa">
        <div className="skeleton h-48 w-full sm:h-64 lg:h-72" />
        <div className="mx-auto max-w-6xl space-y-4 px-4 py-8 sm:px-6 lg:px-8">
          <div className="skeleton h-8 w-72" />
          <div className="skeleton h-4 w-96 max-w-full" />
          <div className="grid gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => <div key={index} className="skeleton h-20 rounded-card" />)}
          </div>
        </div>
      </div>
    );
  }

  return <CompanyProfileView data={data} loadGalleryPage={loadGalleryPage} loadReviews={loadReviews} />;
}

