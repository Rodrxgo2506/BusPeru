import { Building2, Check, Eye, Images, Target } from 'lucide-react';
import { CompanyGallery } from '@/components/company-site/CompanyGallery';
import { CompanyPageHero } from '@/components/company-site/CompanyPageHero';
import { BlockHeading, ImagePlaceholder, multiline, OwnImage, SiteContainer, SiteEmpty, useCompanyPageMeta, useCompanySite } from '@/components/company-site/shared';
import { mediaUrl } from '@/services/api';
import { companySitePath, heroImagePath } from '@/utils/company-site';
import { cn } from '@/utils/cn';

/**
 * F18-20 · Nosotros: quiénes somos (imagen + texto), misión, visión, valores y la GALERÍA (que no tiene ruta propia).
 * Solo lo que la empresa publicó; los bloques sin contenido no se pintan.
 */
export function CompanyAboutPage() {
  const { data, slug, loadGalleryPage } = useCompanySite();
  useCompanyPageMeta('nosotros', data, slug);
  const { company, profile } = data;
  const image = mediaUrl(profile.about_image);
  const values = profile.values_list ?? [];
  const hasWho = Boolean(profile.about_body || profile.history);
  const hasAnything = hasWho || Boolean(profile.mission || profile.vision || values.length);

  return (
    <>
      <CompanyPageHero
        image={heroImagePath('nosotros', profile)}
        eyebrow={company.name}
        title="Nosotros"
        breadcrumb={[{ label: 'Inicio', to: companySitePath(slug) }, { label: 'Nosotros' }]}
      />

      {!hasAnything && (
        <SiteContainer className="py-14">
          <SiteEmpty icon={<Building2 className="h-7 w-7" />} title="Presentación en preparación" description={`${company.name} aún no ha publicado su historia, misión ni valores.`} />
        </SiteContainer>
      )}

      {hasWho && (
        <section aria-labelledby="quienes-somos" className="py-14 sm:py-20">
          <SiteContainer className={cn('grid gap-10', image && 'lg:grid-cols-2 lg:items-center lg:gap-14')}>
            {image && (
              <div className="relative">
                <div className="absolute -bottom-4 -left-4 hidden h-full w-full rounded-3xl bg-brand-100 sm:block" aria-hidden />
                <OwnImage src={image} alt={`${company.name}: quiénes somos`} className="relative aspect-[4/3] w-full rounded-3xl object-cover shadow-elevated" loading="lazy" decoding="async" fallback={<ImagePlaceholder className="relative aspect-[4/3] w-full rounded-3xl" />} />
              </div>
            )}
            <div className={cn(!image && 'mx-auto max-w-3xl')}>
              <BlockHeading id="quienes-somos" eyebrow="Quiénes somos" title={profile.about_title || `Conoce a ${company.name}`} />
              {profile.about_body && <p className={cn('mt-5 text-slate-700', multiline)}>{profile.about_body}</p>}
              {profile.history && (
                <div className="mt-8 border-l-4 border-brand-500 pl-5">
                  <h3 className="text-lg font-bold text-ink">Nuestra historia</h3>
                  <p className={cn('mt-2 text-slate-600', multiline)}>{profile.history}</p>
                </div>
              )}
            </div>
          </SiteContainer>
        </section>
      )}

      {(profile.mission || profile.vision) && (
        <section aria-label="Misión y visión" className="bg-slate-50 py-14 sm:py-20">
          <SiteContainer className={cn('grid gap-6', profile.mission && profile.vision && 'md:grid-cols-2')}>
            {profile.mission && (
              <article className="rounded-3xl bg-white p-7 shadow-card ring-1 ring-black/5 sm:p-9">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-500 text-white" aria-hidden><Target className="h-6 w-6" /></span>
                <h2 className="mt-5 text-2xl font-extrabold text-ink">Misión</h2>
                <p className={cn('mt-3 text-slate-700', multiline)}>{profile.mission}</p>
              </article>
            )}
            {profile.vision && (
              <article className="rounded-3xl bg-ink p-7 text-white shadow-card sm:p-9">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10 text-brand-300" aria-hidden><Eye className="h-6 w-6" /></span>
                <h2 className="mt-5 text-2xl font-extrabold">Visión</h2>
                <p className={cn('mt-3 text-white/85', multiline)}>{profile.vision}</p>
              </article>
            )}
          </SiteContainer>
        </section>
      )}

      {values.length > 0 && (
        <section aria-labelledby="valores" className="py-14 sm:py-20">
          <SiteContainer>
            <BlockHeading id="valores" eyebrow="Lo que nos guía" title="Nuestros valores" align="center" />
            <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {values.map((value) => (
                <li key={value} className="flex items-start gap-3 rounded-2xl bg-white p-5 shadow-card ring-1 ring-black/5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600" aria-hidden><Check className="h-5 w-5" /></span>
                  <span className="pt-1.5 font-semibold text-ink">{value}</span>
                </li>
              ))}
            </ul>
          </SiteContainer>
        </section>
      )}

      <section aria-labelledby="galeria" className="border-t border-border bg-slate-50 py-14 sm:py-20">
        <SiteContainer>
          <BlockHeading id="galeria" eyebrow="Conócenos" title="Galería" align="center" />
          <div className="mt-10">
            {data.gallery.total > 0 && data.gallery.items.length > 0 ? (
              <CompanyGallery gallery={data.gallery} companyName={company.name} loadPage={loadGalleryPage} />
            ) : (
              <SiteEmpty icon={<Images className="h-7 w-7" />} title="Aún no hay fotos en la galería" description={`Cuando ${company.name} publique fotos de sus buses, agencias o instalaciones, las verás aquí.`} />
            )}
          </div>
        </SiteContainer>
      </section>
    </>
  );
}
