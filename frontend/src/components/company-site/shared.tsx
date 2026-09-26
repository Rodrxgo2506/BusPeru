import { Facebook, Globe, ImageOff, Instagram, Linkedin, Music2, Star, Twitter, Youtube } from 'lucide-react';
import { useEffect, useState, type ImgHTMLAttributes, type ReactNode } from 'react';
import { useOutletContext } from 'react-router-dom';
import { usePageMeta } from '@/hooks/usePageMeta';
import { mediaUrl } from '@/services/api';
import type { PublicCompanyProfile, PublicCompanyReview, SocialNetwork } from '@/types/company-profile';
import { safeExternalUrl, SOCIAL_LABELS } from '@/utils/company-profile';
import { breadcrumbJsonLd, companyPageMeta, companySitePath, companyTripsUrl, type CompanySection } from '@/utils/company-site';
import { canonicalUrl } from '@/utils/seo';
import { cn } from '@/utils/cn';

/**
 * F18-20 · piezas compartidas del sitio público de cada empresa. El perfil se carga UNA vez en el layout
 * (`CompanySiteLayout`) y cada página lo recibe por el contexto del `Outlet`: cambiar de sección no repite la petición.
 */
export interface CompanySiteContext {
  data: PublicCompanyProfile;
  slug: string;
  today: string;
  /** Buscador de viajes de la empresa en la fecha de su próxima salida (o hoy). */
  tripsUrl: string;
  loadGalleryPage: (page: number) => Promise<PublicCompanyProfile['gallery']['items']>;
  loadReviews: (page: number) => Promise<{ rows: PublicCompanyReview[]; totalPages: number }>;
}

export function useCompanySite(): CompanySiteContext {
  return useOutletContext<CompanySiteContext>();
}

export function buildTripsUrl(data: PublicCompanyProfile, today: string): string {
  return companyTripsUrl(data.company.id, data.next_departure_date, today);
}

export const multiline = 'whitespace-pre-line break-words';

/** Redes sociales configuradas, solo con URL https válida. */
export function companySocials(data: PublicCompanyProfile): Array<[SocialNetwork, string]> {
  return Object.entries(data.profile.social_links ?? {})
    .map(([network, url]) => [network as SocialNetwork, safeExternalUrl(url)] as const)
    .filter((entry): entry is readonly [SocialNetwork, string] => Boolean(entry[1]))
    .map(([network, url]) => [network, url]);
}

const SOCIAL_ICONS: Record<SocialNetwork, typeof Globe> = {
  facebook: Facebook,
  instagram: Instagram,
  tiktok: Music2,
  youtube: Youtube,
  x: Twitter,
  linkedin: Linkedin,
};

export function SocialLinks({ socials, tone = 'light', className }: { socials: Array<[SocialNetwork, string]>; tone?: 'light' | 'dark'; className?: string }) {
  if (!socials.length) return null;
  return (
    <ul className={cn('flex flex-wrap gap-2', className)} aria-label="Redes sociales">
      {socials.map(([network, url]) => {
        const Icon = SOCIAL_ICONS[network] ?? Globe;
        return (
          <li key={network}>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${SOCIAL_LABELS[network]} (se abre en otra pestaña)`}
              title={SOCIAL_LABELS[network]}
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400',
                tone === 'dark' ? 'bg-white/10 text-white hover:bg-brand-500' : 'bg-brand-50 text-brand-600 hover:bg-brand-500 hover:text-white',
              )}
            >
              <Icon className="h-[18px] w-[18px]" aria-hidden />
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export function Stars({ value, size = 'h-4 w-4' }: { value: number; size?: string }) {
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={`${value.toFixed(1)} de 5 estrellas`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} className={cn(size, n <= Math.round(value) ? 'fill-amber-400 text-amber-400' : 'text-slate-300')} aria-hidden />
      ))}
    </span>
  );
}

/** Encabezado de bloque: antetítulo naranja, título y, opcionalmente, entradilla. */
export function BlockHeading({ id, eyebrow, title, intro, align = 'left', as: Tag = 'h2' }: { id?: string; eyebrow?: string; title: string; intro?: ReactNode; align?: 'left' | 'center'; as?: 'h2' | 'h3' }) {
  return (
    <div className={cn(align === 'center' && 'mx-auto max-w-2xl text-center')}>
      {eyebrow && <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-600">{eyebrow}</p>}
      <Tag id={id} className="mt-2 text-2xl font-extrabold tracking-tight text-ink sm:text-3xl">{title}</Tag>
      {align === 'center' && <span className="mx-auto mt-3 block h-1 w-12 rounded-full bg-brand-500" aria-hidden />}
      {intro && <p className="mt-3 text-slate-600">{intro}</p>}
    </div>
  );
}

/** Contenedor de página con el ancho del sitio. */
export function SiteContainer({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8', className)}>{children}</div>;
}

/** Estado vacío del sitio de empresa: sobrio, con ícono y, si procede, una acción. */
export function SiteEmpty({ icon, title, description, action }: { icon: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center rounded-2xl border border-dashed border-slate-300 bg-slate-50/70 px-6 py-12 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-brand-500 shadow-card ring-1 ring-black/5" aria-hidden>
        {icon}
      </span>
      <p className="mt-4 text-lg font-bold text-ink">{title}</p>
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/**
 * SEO de cada ruta del sitio: título, descripción, og:* (la URL canónica la pone `PublicLayout`) y JSON-LD
 * (`Organization` en Inicio; `BreadcrumbList` en las subpáginas).
 */
export function useCompanyPageMeta(section: CompanySection, data: PublicCompanyProfile | null, slug: string): void {
  const meta = data
    ? companyPageMeta(section, {
        name: data.company.name,
        tagline: data.profile.tagline,
        description: data.company.description,
        aboutBody: data.profile.about_body,
      })
    : null;
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  usePageMeta(
    data && meta
      ? {
          title: meta.title,
          description: meta.description,
          image: mediaUrl(data.profile.cover_image) ?? mediaUrl(data.company.logo_url),
          jsonLd:
            section === 'inicio'
              ? {
                  '@context': 'https://schema.org',
                  '@type': 'Organization',
                  name: data.company.name,
                  url: canonicalUrl(origin, companySitePath(slug)),
                  ...(mediaUrl(data.company.logo_url) ? { logo: mediaUrl(data.company.logo_url) } : {}),
                  ...(data.profile.tagline ? { description: data.profile.tagline } : {}),
                  ...(data.profile.contact_phone ? { telephone: data.profile.contact_phone } : {}),
                  ...(data.profile.contact_email ? { email: data.profile.contact_email } : {}),
                  sameAs: [data.profile.website_url, ...Object.values(data.profile.social_links ?? {})].map((url) => safeExternalUrl(url)).filter(Boolean),
                }
              : breadcrumbJsonLd(origin, slug, data.company.name, section),
        }
      : null,
  );
}

/**
 * Imagen propia de la empresa (medio subido y validado). Si el archivo no carga, se pinta `fallback` en su lugar:
 * nunca el ícono de imagen rota del navegador.
 */
export function OwnImage({ fallback, ...props }: ImgHTMLAttributes<HTMLImageElement> & { fallback: ReactNode }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [props.src]);
  if (broken || !props.src) return <>{fallback}</>;
  return <img {...props} onError={() => setBroken(true)} />;
}

/** Relleno neutro para una imagen que no está disponible. */
export function ImagePlaceholder({ className, label }: { className?: string; label?: string }) {
  return (
    <div className={cn('flex items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200 text-slate-400', className)} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <ImageOff className="h-8 w-8" aria-hidden />
    </div>
  );
}
