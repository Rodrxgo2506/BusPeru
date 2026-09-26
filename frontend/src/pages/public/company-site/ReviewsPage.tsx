import { MessageSquareQuote, Quote, Star } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { CompanyPageHero } from '@/components/company-site/CompanyPageHero';
import { multiline, SiteContainer, SiteEmpty, Stars, useCompanyPageMeta, useCompanySite } from '@/components/company-site/shared';
import type { PublicCompanyReview } from '@/types/company-profile';
import { ratingShare } from '@/utils/company-profile';
import { companySitePath, heroImagePath } from '@/utils/company-site';
import { formatDate } from '@/utils/format';
import { cn } from '@/utils/cn';

/**
 * F18-20 · Opiniones: media, total y distribución, y las reseñas PUBLICADAS del sistema existente (solo nombre de
 * pila), con la respuesta de la empresa. Sin opiniones: estado vacío; nunca se muestran opiniones de ejemplo.
 */
export function CompanyReviewsPage() {
  const { data, slug, loadReviews } = useCompanySite();
  useCompanyPageMeta('opiniones', data, slug);
  const { company, profile, reviews } = data;
  const [rows, setRows] = useState<PublicCompanyReview[]>([]);
  const [page, setPage] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const hasReviews = reviews.total > 0 && reviews.rating !== null;

  const load = async (next: number) => {
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

  useEffect(() => {
    if (hasReviews) void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasReviews, loadReviews]);

  return (
    <>
      <CompanyPageHero
        image={heroImagePath('opiniones', profile)}
        eyebrow={company.name}
        title="Opiniones"
        subtitle={hasReviews ? `${reviews.rating!.toFixed(1)} de 5 · ${reviews.total} ${reviews.total === 1 ? 'opinión' : 'opiniones'} de pasajeros.` : undefined}
        breadcrumb={[{ label: 'Inicio', to: companySitePath(slug) }, { label: 'Opiniones' }]}
      />
      <section aria-labelledby="opiniones-titulo" className="py-14 sm:py-20">
        <SiteContainer>
          <h2 id="opiniones-titulo" className="sr-only">Opiniones de pasajeros</h2>
          {!hasReviews ? (
            <SiteEmpty
              icon={<MessageSquareQuote className="h-7 w-7" />}
              title="Aún no hay opiniones"
              description={`Solo pueden opinar pasajeros que viajaron con ${company.name}. Las opiniones publicadas aparecerán aquí.`}
            />
          ) : (
            <div className="grid gap-8 lg:grid-cols-[320px_1fr]">
              <aside className="rounded-3xl bg-ink p-7 text-center text-white shadow-elevated lg:sticky lg:top-40 lg:self-start" aria-label="Resumen de valoraciones">
                <p className="text-6xl font-extrabold">{reviews.rating!.toFixed(1)}</p>
                <div className="mt-2 flex justify-center"><Stars value={reviews.rating!} size="h-5 w-5" /></div>
                <p className="mt-1 text-sm text-white/70">{reviews.total} {reviews.total === 1 ? 'opinión' : 'opiniones'}</p>
                <ul className="mt-6 space-y-2 text-left" aria-label="Distribución de valoraciones">
                  {[5, 4, 3, 2, 1].map((stars) => {
                    const count = reviews.distribution[String(stars)] ?? 0;
                    return (
                      <li key={stars} className="flex items-center gap-2 text-xs text-white/80">
                        <span className="w-3 text-right">{stars}</span>
                        <Star className="h-3 w-3 fill-amber-400 text-amber-400" aria-hidden />
                        <span className="h-2 flex-1 overflow-hidden rounded-full bg-white/15" aria-hidden>
                          <span className="block h-full rounded-full bg-amber-400" style={{ width: `${ratingShare(reviews.distribution, stars, reviews.total)}%` }} />
                        </span>
                        <span className="w-8 text-right">{count}</span>
                        <span className="sr-only">{`${count} ${count === 1 ? 'opinión' : 'opiniones'} de ${stars} ${stars === 1 ? 'estrella' : 'estrellas'}`}</span>
                      </li>
                    );
                  })}
                </ul>
              </aside>
              <div>
                {failed ? (
                  <p className="rounded-card bg-danger-50 p-4 text-sm text-danger-700" role="alert">
                    No se pudieron cargar las opiniones.{' '}
                    <button type="button" className="font-semibold underline" onClick={() => void load(page > 0 ? page + 1 : 1)}>Reintentar</button>
                  </p>
                ) : (
                  <ul className="space-y-5">
                    {rows.map((review, i) => (
                      <li key={`${review.created_at}-${i}`} className="rounded-3xl bg-white p-6 shadow-card ring-1 ring-black/5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-3">
                            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-100 font-bold text-brand-700" aria-hidden>
                              {review.first_name.slice(0, 1).toUpperCase()}
                            </span>
                            <div>
                              <p className="font-semibold text-ink">{review.first_name}</p>
                              <p className="text-xs text-muted"><time dateTime={review.created_at}>{formatDate(review.created_at)}</time></p>
                            </div>
                          </div>
                          <Stars value={review.rating} />
                        </div>
                        {review.title && <h3 className="mt-4 font-bold text-ink">{review.title}</h3>}
                        {review.comment && <p className={cn('mt-1 text-slate-600', multiline)}>{review.comment}</p>}
                        {review.company_response && (
                          <div className="mt-4 rounded-2xl border-l-4 border-brand-400 bg-brand-50/70 px-4 py-3 text-sm">
                            <p className="flex items-center gap-1.5 font-semibold text-brand-700"><Quote className="h-3.5 w-3.5" aria-hidden /> Respuesta de {company.name}</p>
                            <p className={cn('mt-1 text-slate-700', multiline)}>{review.company_response}</p>
                          </div>
                        )}
                      </li>
                    ))}
                    {loading && <li className="skeleton h-28 rounded-3xl" aria-hidden />}
                  </ul>
                )}
                {!failed && page > 0 && page < totalPages && (
                  <div className="mt-6 text-center">
                    <Button variant="outline" loading={loading} onClick={() => void load(page + 1)}>Ver más opiniones</Button>
                  </div>
                )}
              </div>
            </div>
          )}
        </SiteContainer>
      </section>
    </>
  );
}
