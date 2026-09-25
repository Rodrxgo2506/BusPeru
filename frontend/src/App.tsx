import { BrowserRouter } from 'react-router-dom';
import { ErrorBoundary } from '@/components/common/ErrorBoundary';
import { AuthProvider } from '@/context/AuthContext';
import { BrandingProvider } from '@/context/BrandingContext';
import { ToastProvider } from '@/context/ToastContext';
import { AppRoutes } from '@/routes';

export default function App() {
  return (
    <ErrorBoundary>
      {/* v7_startTransition (F17C-NAV-01): React Router envuelve la navegación en una
          transición, así la pantalla actual sigue visible mientras llega el fragmento
          perezoso de la ruta destino en lugar de dar paso al indicador de carga. */}
      <BrowserRouter future={{ v7_startTransition: true }}>
        <ToastProvider>
          <AuthProvider>
            <BrandingProvider>
              <AppRoutes />
            </BrandingProvider>
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
