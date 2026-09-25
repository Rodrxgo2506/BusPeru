import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { publicService } from '@/services';
import { mediaUrl } from '@/services/api';
import type { BrandingReferences } from '@/types';

/**
 * Identidad visual administrable (FASE 17).
 *
 * Carga una vez `GET /public/branding` y reparte las URLs. Si no hay nada configurado —o la API no
 * responde— la app usa la marca de siempre: la identidad visual nunca bloquea la carga.
 *
 * El favicon también se declara en `index.html` apuntando a `/public/branding/favicon`, una URL
 * estable que funciona sin JavaScript; aquí solo se actualiza en caliente cuando el ADMIN lo cambia.
 */

const EMPTY: BrandingReferences = { logo: null, favicon: null, logo_mobile: null, og_image: null };

interface BrandingContextValue {
  logoUrl: string | null;
  logoMobileUrl: string | null;
  faviconUrl: string | null;
  ogImageUrl: string | null;
  /** Aplica referencias recién guardadas desde el panel, sin recargar la página. */
  apply: (references: BrandingReferences) => void;
}

const BrandingContext = createContext<BrandingContextValue | null>(null);

function setHeadLink(rel: string, href: string) {
  let link = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!link) {
    link = document.createElement('link');
    link.rel = rel;
    document.head.appendChild(link);
  }
  link.href = href;
}

function setMetaProperty(property: string, content: string) {
  let meta = document.head.querySelector<HTMLMetaElement>(`meta[property="${property}"]`);
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('property', property);
    document.head.appendChild(meta);
  }
  meta.content = content;
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  const [references, setReferences] = useState<BrandingReferences>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    publicService
      .branding()
      .then((data) => {
        if (!cancelled) setReferences({ ...EMPTY, ...data });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<BrandingContextValue>(
    () => ({
      logoUrl: mediaUrl(references.logo),
      logoMobileUrl: mediaUrl(references.logo_mobile),
      faviconUrl: mediaUrl(references.favicon),
      ogImageUrl: mediaUrl(references.og_image),
      apply: (next) => setReferences({ ...EMPTY, ...next }),
    }),
    [references],
  );

  const applyHead = useCallback(() => {
    if (value.faviconUrl) setHeadLink('icon', value.faviconUrl);
    // Útil para quien comparte desde la app; los rastreadores que no ejecutan JavaScript no lo ven
    // (limitación de una SPA, documentada).
    if (value.ogImageUrl) setMetaProperty('og:image', value.ogImageUrl);
  }, [value.faviconUrl, value.ogImageUrl]);

  useEffect(applyHead, [applyHead]);

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

/** Fuera del proveedor devuelve la marca por defecto, para que ningún componente dependa de él. */
export function useBranding(): BrandingContextValue {
  return (
    useContext(BrandingContext) ?? { logoUrl: null, logoMobileUrl: null, faviconUrl: null, ogImageUrl: null, apply: () => undefined }
  );
}
