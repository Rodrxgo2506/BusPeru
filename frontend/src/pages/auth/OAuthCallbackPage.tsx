import { AlertCircle, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Logo } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { ApiError } from '@/services/api';
import { oauthService } from '@/services';

/**
 * Retorno del proveedor (PENDIENTES.md §2).
 *
 * El backend redirige aquí con un ticket de un solo uso —nunca con el JWT en la URL— o con
 * un código de error. Esta pantalla canjea el ticket por la sesión y lleva al usuario a su
 * portal, o explica en castellano qué ha pasado.
 */

/** Cada código del backend tiene un mensaje que dice qué hacer, no solo qué falló. */
const ERROR_MESSAGES: Record<string, { title: string; description: string }> = {
  email_taken: {
    title: 'Ese correo ya tiene una cuenta',
    description:
      'Tu correo ya está registrado con contraseña. Inicia sesión con ella y, si quieres, vincula el proveedor desde tu perfil.',
  },
  account_not_found: {
    title: 'No encontramos tu cuenta',
    description:
      'No hay ninguna cuenta con ese correo en este portal. Las cuentas de empresa y de administración las crea el equipo de BusPerú.',
  },
  already_linked: {
    title: 'Tu cuenta ya tiene un proveedor',
    description: 'Solo puedes tener un proveedor vinculado. Desvincula el actual desde tu perfil antes de añadir otro.',
  },
  identity_taken: {
    title: 'Esa cuenta ya está en uso',
    description: 'Esa identidad ya está vinculada a otro usuario de BusPerú.',
  },
  account_blocked: {
    title: 'Tu cuenta no está activa',
    description: 'Tu cuenta está pendiente, inactiva o suspendida. Contacta con soporte para reactivarla.',
  },
  invalid_state: {
    title: 'La sesión de acceso caducó',
    description: 'Ha pasado demasiado tiempo o el enlace ya se usó. Vuelve a intentarlo desde el inicio de sesión.',
  },
  not_configured: {
    title: 'Proveedor no disponible',
    description: 'Este servidor no tiene configurado el acceso con ese proveedor.',
  },
  provider_error: {
    title: 'No pudimos verificar tu identidad',
    description: 'El proveedor no completó la autenticación. Vuelve a intentarlo o entra con tu correo y contraseña.',
  },
};

/** A dónde va cada rol después de entrar. */
const HOME_BY_ROLE: Record<string, string> = {
  ADMIN: '/admin/dashboard',
  COMPANY_ADMIN: '/company/dashboard',
  OPERATOR: '/company/dashboard',
  CUSTOMER: '/customer/trips',
};

export function OAuthCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { adoptSession } = useAuth();

  const [error, setError] = useState<string | null>(params.get('error'));
  // El ticket es de un solo uso: en desarrollo React monta dos veces y el segundo canje
  // fallaría, así que se canjea una sola vez por montaje.
  const exchanged = useRef(false);

  const ticket = params.get('ticket');

  useEffect(() => {
    if (exchanged.current) return;
    exchanged.current = true;

    // Llegar aquí sin ticket ni error significa que alguien abrió la URL a mano.
    if (!ticket) {
      setError((current) => current ?? 'invalid_state');
      return;
    }

    void (async () => {
      try {
        const result = await oauthService.session(ticket);
        adoptSession(result.token, result.user);
        toast.success(`¡Bienvenido, ${result.user.first_name}!`);
        navigate(HOME_BY_ROLE[result.user.role] ?? '/', { replace: true });
      } catch (caught) {
        setError(caught instanceof ApiError && caught.status === 401 ? 'invalid_state' : 'provider_error');
      }
    })();
  }, [ticket, adoptSession, navigate, toast]);

  const detail = error ? (ERROR_MESSAGES[error] ?? ERROR_MESSAGES.provider_error!) : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4">
      <div className="w-full max-w-md rounded-card border border-border bg-white p-8 text-center shadow-card">
        <div className="mb-6 flex justify-center">
          <Logo />
        </div>

        {detail ? (
          <>
            <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-danger-100 text-danger-600">
              <AlertCircle className="h-6 w-6" />
            </span>
            <h1 className="text-lg font-bold text-ink">{detail.title}</h1>
            <p className="mt-2 text-sm text-muted">{detail.description}</p>

            <div className="mt-6 grid gap-2">
              <Button onClick={() => navigate('/login', { replace: true })} fullWidth>
                Volver al inicio de sesión
              </Button>
              <Link to="/" className="text-sm font-medium text-brand-600 hover:text-brand-700">
                Ir al inicio
              </Link>
            </div>
          </>
        ) : (
          <>
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-brand-600" />
            <h1 className="mt-4 text-lg font-bold text-ink">Completando tu acceso…</h1>
            <p className="mt-2 text-sm text-muted">Estamos verificando tu identidad con el proveedor.</p>
          </>
        )}
      </div>
    </div>
  );
}
