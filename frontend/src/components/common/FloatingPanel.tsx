import { useLayoutEffect, useState, type CSSProperties, type KeyboardEventHandler, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/utils/cn';

/**
 * Panel flotante anclado a un disparador (FASE 17): lo usan los selectores del buscador.
 *
 * Se pinta en un portal con posición fija, así que ningún contenedor con `overflow-hidden` —la
 * portada lo necesita para su imagen— lo recorta. Se coloca debajo del disparador y, si no cabe,
 * encima; nunca se sale del viewport en horizontal. Se recoloca al hacer scroll o redimensionar.
 */

const GAP = 8;
const MARGIN = 16;

export function FloatingPanel({
  anchorRef,
  panelRef,
  open,
  minWidth = 240,
  width,
  preferredHeight = 320,
  className,
  children,
  role,
  ariaLabel,
  onKeyDown,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLDivElement>;
  open: boolean;
  minWidth?: number;
  /** Ancho fijo; sin él, el del disparador (con `minWidth`). */
  width?: number;
  preferredHeight?: number;
  className?: string;
  children: ReactNode;
  role?: string;
  ariaLabel?: string;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
}) {
  const [style, setStyle] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      const panelWidth = Math.min(width ?? Math.max(rect.width, minWidth), viewportWidth - MARGIN * 2);
      const left = Math.min(Math.max(MARGIN, rect.left), viewportWidth - MARGIN - panelWidth);

      const spaceBelow = viewportHeight - rect.bottom - GAP - MARGIN;
      const spaceAbove = rect.top - GAP - MARGIN;
      const openUp = spaceBelow < Math.min(preferredHeight, 220) && spaceAbove > spaceBelow;
      const maxHeight = Math.max(160, Math.min(preferredHeight, openUp ? spaceAbove : spaceBelow));

      setStyle(
        openUp
          ? { position: 'fixed', left, width: panelWidth, bottom: viewportHeight - rect.top + GAP, maxHeight }
          : { position: 'fixed', left, width: panelWidth, top: rect.bottom + GAP, maxHeight },
      );
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchorRef, minWidth, width, preferredHeight]);

  if (!open || !style) return null;

  return createPortal(
    <div
      ref={panelRef}
      role={role}
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      style={style}
      className={cn('z-[60] flex flex-col overflow-hidden rounded-xl border border-border bg-white shadow-elevated', className)}
    >
      {children}
    </div>,
    document.body,
  );
}
