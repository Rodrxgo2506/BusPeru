import { Suspense, type ReactNode } from 'react';
import { LoadingState } from '@/components/ui';

/**
 * Límite de carga para las rutas perezosas (`React.lazy`), corrección F17C-NAV-01.
 *
 * Se coloca *dentro* de cada armazón, pegado a su `<Outlet/>`: mientras llega el fragmento de la
 * página, la cabecera, la barra lateral y el resto de la estructura siguen pintados y el indicador
 * ocupa únicamente el área de contenido. Antes había un único límite por encima de `<Routes>`, así
 * que React despintaba el árbol entero y la pantalla quedaba en blanco.
 */
export function RouteSuspense({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="py-20">
          <LoadingState />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}
