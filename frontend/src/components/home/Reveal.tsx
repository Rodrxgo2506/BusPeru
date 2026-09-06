import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/utils/cn';

/**
 * Aparición suave de una sección al entrar en pantalla.
 *
 * A PRUEBA DE FALLOS, y esto es lo importante: la animación esconde contenido, así que si
 * algo impide que se dispare, el contenido quedaría invisible para siempre. Por eso hay tres
 * caminos que llevan a mostrarlo:
 *
 *   1. `IntersectionObserver` cuando la sección entra en pantalla, que es el caso normal;
 *   2. una comprobación síncrona al montar, porque lo que ya está visible no debe esperar;
 *   3. un temporizador de seguridad que revela pase lo que pase.
 *
 * El tercero no es teórico: si la pestaña no está pintando —ventana detrás de otra, por
 * ejemplo— el observador no emite y la página se queda en blanco.
 *
 * Con `prefers-reduced-motion` no hay desplazamiento ni desvanecido: solo aparece.
 */
const SAFETY_TIMEOUT_MS = 900;

export function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // 2. Ya está en pantalla al montar: se muestra sin esperar al observador.
    const rect = node.getBoundingClientRect();
    if (rect.top < window.innerHeight && rect.bottom > 0) {
      setVisible(true);
      return;
    }

    // 3. Red de seguridad.
    const timer = window.setTimeout(() => setVisible(true), SAFETY_TIMEOUT_MS + delay);

    if (typeof IntersectionObserver === 'undefined') {
      return () => window.clearTimeout(timer);
    }

    // 1. Camino normal.
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.05 },
    );
    observer.observe(node);

    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [delay]);

  return (
    <div
      ref={ref}
      style={visible && delay ? { transitionDelay: `${delay}ms` } : undefined}
      className={cn(
        'motion-safe:transition-all motion-safe:duration-700 motion-safe:ease-out',
        visible ? 'opacity-100 motion-safe:translate-y-0' : 'opacity-0 motion-safe:translate-y-4',
        className,
      )}
    >
      {children}
    </div>
  );
}
