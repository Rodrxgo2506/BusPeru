import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

/**
 * Cabecera compartida de las páginas públicas de catálogo (destinos, empresas).
 *
 * Se extrajo al detectar que ambas necesitaban exactamente la misma estructura: antetítulo,
 * titular, descripción, una banda fotográfica decorativa arriba a la derecha y, debajo, el
 * contenido de la página sobre el mismo degradado.
 *
 * Dos decisiones que conviene no perder de vista:
 *
 *   · La fotografía es **decorativa** (`alt=""`, `aria-hidden`). El texto descansa sobre el
 *     degradado, no sobre la imagen, así que la página se lee igual si la foto no carga.
 *   · La foto es una BANDA SUPERIOR, no un fondo de altura completa. A altura completa el
 *     recorte cae en zonas sin interés y compite con las tarjetas.
 *
 * `minHeight` evita la franja blanca entre el contenido y el pie: `main` es un `flex-1` que
 * se estira cuando la página es corta. Es una altura MÍNIMA, así que si el backend devuelve
 * más elementos la sección crece con ellos.
 */
export function PublicHero({
  eyebrow,
  title,
  description,
  image,
  imagePosition = '50% 50%',
  aside,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  image: string;
  /** `object-position` de la foto, para encuadrar la parte que interesa de cada imagen. */
  imagePosition?: string;
  /** Remate tipográfico opcional de la derecha. Decorativo: sin enlaces ni acciones. */
  aside?: [string, string];
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        'relative isolate overflow-hidden bg-gradient-to-b from-brand-50/80 via-brand-50/40 to-white',
        'lg:min-h-[calc(100vh-320px)]',
      )}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[340px] lg:left-[45%] lg:h-[460px]">
        {/*
          La máscara disuelve el borde izquierdo de la foto en lugar de taparlo con un bloque
          de color: con un velo opaco quedaba una costura vertical donde el color del velo
          dejaba de coincidir con el degradado de la sección. Solo desde `lg`, porque en móvil
          la imagen ocupa todo el ancho y no hay borde que disolver.
        */}
        <img
          src={image}
          alt=""
          aria-hidden
          style={{ objectPosition: imagePosition }}
          className="h-full w-full object-cover lg:[-webkit-mask-image:linear-gradient(to_right,transparent_0%,black_40%)] lg:[mask-image:linear-gradient(to_right,transparent_0%,black_40%)]"
          loading="eager"
          decoding="async"
        />

        {/* Velos: casi opaco en móvil —ahí el texto va encima— y abierto hacia la derecha en
            escritorio, que es donde las referencias dejan ver el paisaje. */}
        <div className="absolute inset-0 bg-brand-50/90 lg:hidden" aria-hidden />
        {/* Lavado uniforme, sin degradado de color: la foto ya se atenúa sola por la máscara,
            así que aquí basta con bajarle el contraste para que nada compita con el texto. */}
        <div className="absolute inset-0 hidden bg-white/45 lg:block" aria-hidden />
        {/* Fundido inferior generoso: disuelve el borde de la banda contra el degradado. */}
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-[#FFF9F2] via-[#FFF9F2]/80 to-transparent" aria-hidden />
      </div>

      <div className="mx-auto max-w-7xl px-4 pb-10 pt-9 sm:px-6 lg:px-8 lg:pb-12 lg:pt-12">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="min-w-0 max-w-2xl">
            <p className="mb-3 flex items-center gap-3 text-sm font-semibold text-brand-600">
              <span className="h-px w-7 bg-brand-500" aria-hidden />
              {eyebrow}
            </p>
            <h1 className="text-4xl font-extrabold tracking-tight text-ink sm:text-5xl">{title}</h1>
            <p className="mt-3 max-w-lg text-base leading-relaxed text-slate-600 lg:text-lg">{description}</p>
          </div>

          {aside && (
            <p className="hidden max-w-[13rem] text-right text-lg italic leading-snug text-slate-500 xl:block" aria-hidden>
              {aside[0]}
              <br />
              {aside[1]}
              <span className="mt-3 block h-px w-16 bg-brand-300" />
            </p>
          )}
        </div>

        <div className="mt-8 lg:mt-10">{children}</div>
      </div>
    </section>
  );
}
