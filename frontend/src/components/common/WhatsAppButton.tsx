/**
 * Botón flotante de WhatsApp (F17C-UI-05).
 *
 * Vive en el armazón público, no en cada página, así que basta con montarlo una vez. El panel de
 * ayuda se posiciona en absoluto sobre el botón: aparece al pasar el ratón o al enfocar con el
 * teclado y nunca desplaza el contenido de la página.
 *
 * La visibilidad del panel se lleva con estado y no con `group-hover`, para que el ratón y el
 * teclado compartan exactamente el mismo camino y el comportamiento sea comprobable.
 *
 * El icono va en línea: `lucide-react` no trae marcas comerciales y no merece la pena añadir una
 * dependencia entera por un solo glifo.
 */

import { useState } from 'react';
import { cn } from '@/utils/cn';

/** Número de pruebas. Sin espacios ni signos: `wa.me` solo admite dígitos. */
const PHONE = '51971458658';
const PHONE_LABEL = '971 458 658';
const MESSAGE = 'Hola, quisiera información sobre los pasajes de BusPerú.';

const HREF = `https://wa.me/${PHONE}?text=${encodeURIComponent(MESSAGE)}`;

export function WhatsAppButton() {
  const [open, setOpen] = useState(false);

  return (
    /* En móvil sube por encima de la barra de navegación inferior para no taparla. */
    <div
      className="group fixed bottom-[5.5rem] right-4 z-40 lg:bottom-5 lg:right-5"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {/* Panel de ayuda: decorativo para lectores de pantalla, que ya leen el nombre del enlace. */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute bottom-full right-0 mb-3 w-max max-w-[calc(100vw-2rem)] rounded-card bg-white p-3 shadow-elevated ring-1 ring-black/5 transition-opacity duration-150',
          // El estado cubre el ratón; `focus-within` cubre el teclado sin depender de eventos.
          'group-focus-within:opacity-100',
          open ? 'opacity-100' : 'opacity-0',
        )}
      >
        <p className="text-sm font-bold text-ink">¿Necesitas ayuda?</p>
        <p className="mt-0.5 text-xs text-muted">Escríbenos por WhatsApp</p>
        <p className="mt-1 text-sm font-semibold text-brand-600">{PHONE_LABEL}</p>
      </div>

      <a
        href={HREF}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Contactar por WhatsApp al ${PHONE_LABEL}`}
        className="flex h-14 w-14 items-center justify-center rounded-full bg-[#25D366] text-white shadow-elevated ring-1 ring-black/5 transition duration-200 hover:bg-[#1ebe5b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 motion-safe:hover:scale-105"
      >
        <WhatsAppGlyph />
      </a>
    </div>
  );
}

/** Glifo oficial de WhatsApp, en línea para no depender de una librería de marcas. */
function WhatsAppGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="h-7 w-7">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 0 0-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884a9.82 9.82 0 0 1 6.988 2.896 9.83 9.83 0 0 1 2.893 6.994c-.003 5.45-4.437 9.885-9.885 9.885M20.52 3.449C18.24 1.245 15.24 0 12.045 0 5.463 0 .104 5.359.101 11.945c0 2.096.549 4.142 1.595 5.945L0 24l6.305-1.654a11.9 11.9 0 0 0 5.683 1.448h.005c6.585 0 11.946-5.359 11.949-11.945a11.87 11.87 0 0 0-3.421-8.4" />
    </svg>
  );
}
