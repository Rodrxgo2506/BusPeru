import { useEffect, useRef, type RefObject } from 'react';

/**
 * Llama a `onOutside` cuando se pulsa fuera de TODOS los `refs` (ratón o toque): el disparador y,
 * si el panel vive en un portal, también el panel. Solo escucha mientras `active` es verdadero.
 */
export function useClickOutside(refs: Array<RefObject<HTMLElement | null>>, onOutside: () => void, active: boolean): void {
  const callback = useRef(onOutside);
  callback.current = onOutside;

  useEffect(() => {
    if (!active) return;
    const handler = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      if (refs.every((ref) => !ref.current || !ref.current.contains(target))) callback.current();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
    // `refs` es un array literal en cada render; los objetos ref que contiene son estables.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
