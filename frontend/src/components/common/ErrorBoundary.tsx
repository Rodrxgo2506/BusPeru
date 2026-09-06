import { RefreshCw, ServerCrash } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Sin esto, cualquier excepción durante el render desmonta toda la aplicación y el usuario
 * se queda con una pantalla en blanco. Aquí se muestra un estado de error recuperable.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Error no controlado en la interfaz:', error, info.componentStack);
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-danger-50 text-danger-600">
          <ServerCrash className="h-8 w-8" />
        </span>
        <div>
          <h1 className="text-2xl font-bold text-ink">Algo salió mal en la aplicación</h1>
          <p className="mx-auto mt-2 max-w-md text-muted">
            Ocurrió un error inesperado al mostrar esta pantalla. Puedes reintentar o volver al inicio.
          </p>
          {import.meta.env.DEV && (
            <pre className="mx-auto mt-4 max-w-xl overflow-auto rounded-card bg-slate-900 p-4 text-left text-xs text-slate-100">
              {error.message}
            </pre>
          )}
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          <Button icon={<RefreshCw className="h-4 w-4" />} onClick={this.reset}>
            Reintentar
          </Button>
          <Button variant="outline" onClick={() => { window.location.href = '/'; }}>
            Volver al inicio
          </Button>
        </div>
      </div>
    );
  }
}
