import { ChevronLeft, ChevronRight, Expand, Images } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { Button, Modal } from '@/components/ui';
import { mediaUrl } from '@/services/api';
import type { PublicCompanyProfile } from '@/types/company-profile';
import { GALLERY_CATEGORY_LABELS } from '@/utils/company-profile';
import { wrapIndex } from '@/utils/company-site';
import { cn } from '@/utils/cn';
import { ImagePlaceholder, OwnImage } from './shared';

type Item = PublicCompanyProfile['gallery']['items'][number];

/** Hasta este número de fotos se pintan puntos; con más, un contador «3 / 20» (los puntos dejarían de ser útiles). */
const MAX_DOTS = 12;

/**
 * F18-20 · galería de Nosotros: carrusel con imagen grande (anterior/siguiente, indicadores y teclado ←/→),
 * miniaturas, visor ampliado y «Ver más fotos» paginado. Cada foto se identifica por su archivo (F18-19B, sin ids).
 */
export function CompanyGallery({ gallery, companyName, loadPage }: { gallery: PublicCompanyProfile['gallery']; companyName: string; loadPage: (page: number) => Promise<Item[]> }) {
  const [items, setItems] = useState<Item[]>(gallery.items);
  const [page, setPage] = useState(1);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [viewer, setViewer] = useState(false);

  useEffect(() => {
    setItems(gallery.items);
    setPage(1);
    setIndex(0);
  }, [gallery.items]);

  const count = items.length;
  const current = items[wrapIndex(index, count)];
  const go = (delta: number) => setIndex((value) => wrapIndex(value + delta, count));
  const more = count < gallery.total;
  const alt = (item: Item) => item.title ?? `${companyName}: ${GALLERY_CATEGORY_LABELS[item.category] ?? 'foto'}`;

  const loadMore = async () => {
    setLoading(true);
    setFailed(false);
    try {
      const next = await loadPage(page + 1);
      setItems((list) => [...list, ...next.filter((item) => !list.some((c) => c.image === item.image))]);
      setPage(page + 1);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      go(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      go(1);
    }
  };

  if (!current) return null;
  const position = wrapIndex(index, count);

  return (
    <div>
      <div
        role="region"
        aria-roledescription="carrusel"
        aria-label={`Galería de ${companyName}`}
        tabIndex={0}
        onKeyDown={onKey}
        className="group relative overflow-hidden rounded-3xl bg-slate-100 shadow-elevated ring-1 ring-black/5 focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-400"
      >
        <figure aria-roledescription="diapositiva" aria-label={`${position + 1} de ${count}`}>
          <button type="button" onClick={() => setViewer(true)} className="block w-full focus:outline-none" aria-label={`Ampliar foto: ${alt(current)}`}>
            <OwnImage
              key={current.image}
              src={mediaUrl(current.image) ?? ''}
              alt={alt(current)}
              width={current.width ?? undefined}
              height={current.height ?? undefined}
              className="aspect-[4/3] w-full animate-fade-in object-cover sm:aspect-[16/9]"
              decoding="async"
              fallback={<ImagePlaceholder className="aspect-[4/3] w-full sm:aspect-[16/9]" label={`Foto no disponible: ${alt(current)}`} />}
            />
          </button>
          {(current.title || current.description) && (
            <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/30 to-transparent px-5 pb-5 pt-16 text-white sm:px-8">
              {current.title && <p className="text-lg font-bold">{current.title}</p>}
              {current.description && <p className="mt-0.5 line-clamp-2 text-sm text-white/85">{current.description}</p>}
            </figcaption>
          )}
        </figure>
        <span className="pointer-events-none absolute right-4 top-4 inline-flex items-center gap-1 rounded-full bg-black/45 px-2.5 py-1 text-xs font-semibold text-white" aria-hidden>
          <Expand className="h-3.5 w-3.5" /> {position + 1} / {count}
        </span>
        {count > 1 && (
          <>
            <button type="button" onClick={() => go(-1)} aria-label="Foto anterior" className="absolute left-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-ink shadow-card transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
              <ChevronLeft className="h-5 w-5" aria-hidden />
            </button>
            <button type="button" onClick={() => go(1)} aria-label="Foto siguiente" className="absolute right-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-ink shadow-card transition hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
              <ChevronRight className="h-5 w-5" aria-hidden />
            </button>
          </>
        )}
      </div>

      {count > 1 && count <= MAX_DOTS && (
        <div className="mt-4 flex justify-center gap-2" role="group" aria-label="Elegir foto">
          {items.map((item, i) => (
            <button
              key={item.image}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={`Ver foto ${i + 1} de ${count}`}
              aria-current={i === position ? 'true' : undefined}
              className={cn('h-2.5 rounded-full transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2', i === position ? 'w-7 bg-brand-500' : 'w-2.5 bg-slate-300 hover:bg-slate-400')}
            />
          ))}
        </div>
      )}

      {count > 1 && (
        <ul className="scrollbar-none mt-4 flex gap-3 overflow-x-auto pb-1" aria-label="Miniaturas">
          {items.map((item, i) => (
            <li key={item.image} className="shrink-0">
              <button
                type="button"
                onClick={() => setIndex(i)}
                aria-label={`Ver foto ${i + 1}: ${alt(item)}`}
                className={cn('block overflow-hidden rounded-xl ring-2 transition focus:outline-none focus-visible:ring-brand-500', i === position ? 'ring-brand-500' : 'ring-transparent opacity-75 hover:opacity-100')}
              >
                <OwnImage src={mediaUrl(item.image) ?? ''} alt="" className="h-16 w-24 object-cover sm:h-20 sm:w-28" loading="lazy" decoding="async" fallback={<ImagePlaceholder className="h-16 w-24 sm:h-20 sm:w-28" />} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {more && (
        <div className="mt-6 text-center">
          <Button variant="outline" loading={loading} icon={<Images className="h-4 w-4" />} onClick={() => void loadMore()}>
            Ver más fotos
          </Button>
          {failed && <p className="mt-2 text-sm text-danger-600" role="alert">No se pudieron cargar más fotos. Inténtalo de nuevo.</p>}
        </div>
      )}

      <Modal open={viewer} onClose={() => setViewer(false)} title={current.title ?? `Galería de ${companyName}`} description={`Foto ${position + 1} de ${count}`} size="lg">
        <figure onKeyDown={onKey}>
          <OwnImage src={mediaUrl(current.image) ?? ''} alt={alt(current)} className="max-h-[68vh] w-full rounded-control object-contain" fallback={<ImagePlaceholder className="h-64 w-full rounded-control" label="Foto no disponible" />} />
          {current.description && <figcaption className="mt-3 text-sm text-slate-600">{current.description}</figcaption>}
        </figure>
        {count > 1 && (
          <div className="mt-4 flex justify-between gap-3">
            <Button variant="secondary" size="sm" icon={<ChevronLeft className="h-4 w-4" />} onClick={() => go(-1)}>Anterior</Button>
            <Button variant="secondary" size="sm" iconRight={<ChevronRight className="h-4 w-4" />} onClick={() => go(1)}>Siguiente</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
