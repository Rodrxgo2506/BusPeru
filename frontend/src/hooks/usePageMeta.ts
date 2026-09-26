import { useEffect } from 'react';
import { canonicalUrl } from '@/utils/seo';

/**
 * F18-19 · SEO básico de una página del SPA: título, descripción, Open Graph y, opcionalmente, datos
 * estructurados (JSON-LD). Al salir de la página se restaura lo que había, así una ruta nunca hereda
 * el título o la descripción de otra.
 *
 * El JSON-LD va en un `<script type="application/ld+json">`: es un bloque de DATOS que el navegador no
 * ejecuta, y su contenido se serializa con `JSON.stringify` escapando `<`, así que un texto de empresa
 * no puede cerrar la etiqueta.
 */
export interface PageMeta {
  title: string;
  description?: string | null;
  image?: string | null;
  jsonLd?: Record<string, unknown> | null;
}

const JSON_LD_ID = 'page-json-ld';

function upsertMeta(attribute: 'name' | 'property', key: string, content: string | null): () => void {
  let element = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  const created = !element;
  const previous = element?.getAttribute('content') ?? null;
  if (content === null) return () => undefined;
  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(attribute, key);
    document.head.appendChild(element);
  }
  element.setAttribute('content', content);
  return () => {
    if (created) element?.remove();
    else if (previous !== null) element?.setAttribute('content', previous);
  };
}

export function serializeJsonLd(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

export function usePageMeta(meta: PageMeta | null): void {
  const title = meta?.title ?? null;
  const description = meta?.description ?? null;
  const image = meta?.image ?? null;
  const jsonLd = meta?.jsonLd ? serializeJsonLd(meta.jsonLd) : null;

  useEffect(() => {
    if (!title) return undefined;
    const previousTitle = document.title;
    document.title = title;
    const restore = [
      upsertMeta('name', 'description', description),
      upsertMeta('property', 'og:title', title),
      upsertMeta('property', 'og:description', description),
      upsertMeta('property', 'og:type', 'website'),
      // F18-19B (F-05): la URL canónica (sin query ni #), no la de la barra de direcciones.
      upsertMeta('property', 'og:url', canonicalUrl(window.location.origin, window.location.pathname)),
      upsertMeta('property', 'og:image', image),
    ];
    let script: HTMLScriptElement | null = null;
    if (jsonLd) {
      document.getElementById(JSON_LD_ID)?.remove();
      script = document.createElement('script');
      script.type = 'application/ld+json';
      script.id = JSON_LD_ID;
      script.text = jsonLd;
      document.head.appendChild(script);
    }
    return () => {
      document.title = previousTitle;
      for (const undo of restore.reverse()) undo();
      script?.remove();
    };
  }, [title, description, image, jsonLd]);
}

/**
 * F18-19B (F-05) · `<link rel="canonical">` de la página pública actual. Se recalcula al cambiar de ruta y, al
 * salir, se deja como estaba (el panel no lo necesita). El origen es el real: en staging, staging.
 */
export function useCanonicalLink(pathname: string): void {
  useEffect(() => {
    let link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    const created = !link;
    const previous = link?.getAttribute('href') ?? null;
    if (!link) {
      link = document.createElement('link');
      link.rel = 'canonical';
      document.head.appendChild(link);
    }
    link.href = canonicalUrl(window.location.origin, pathname);
    return () => {
      if (created) link?.remove();
      else if (previous !== null) link?.setAttribute('href', previous);
    };
  }, [pathname]);
}
