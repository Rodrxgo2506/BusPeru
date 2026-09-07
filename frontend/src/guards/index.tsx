import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { LoadingState, PermissionDenied } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import type { RoleName } from '@/types';

function FullPageLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <LoadingState label="Verificando tu sesión..." />
    </div>
  );
}

/** Requires a session; sends anonymous visitors to the login that matches the area. */
export function ProtectedRoute({ children, loginPath = '/login' }: { children: ReactNode; loginPath?: string }) {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageLoader />;
  if (!isAuthenticated) return <Navigate to={loginPath} state={{ from: location.pathname }} replace />;
  return <>{children}</>;
}

/**
 * Restringe un área por rol.
 *
 * `requiresCompany` cubre el Portal Empresa (auditoría BP-25d). Ese portal admite también al
 * rol ADMIN —legítimo cuando el administrador está asociado a una empresa—, pero un ADMIN
 * sin ninguna empresa entraba igual y se encontraba un panel roto: cada pantalla llamaba a
 * su endpoint y el backend respondía 403 «Tu usuario no está asociado a ninguna empresa» o
 * 400 «Indica la empresa con el parámetro company_id». El backend hacía lo correcto; lo que
 * fallaba era dejar pasar a una pantalla que no podía funcionar. Se comprueba lo mismo que
 * comprueba el servidor —tener empresa— y se muestra el aviso que ya existe.
 */
export function RoleRoute({
  children,
  roles,
  loginPath = '/login',
  requiresCompany = false,
}: {
  children: ReactNode;
  roles: RoleName[];
  loginPath?: string;
  requiresCompany?: boolean;
}) {
  const { user, loading, isAuthenticated } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageLoader />;
  if (!isAuthenticated) return <Navigate to={loginPath} state={{ from: location.pathname }} replace />;
  if (!user || !roles.includes(user.role)) return <PermissionDenied />;
  if (requiresCompany && user.companyIds.length === 0) return <PermissionDenied />;
  return <>{children}</>;
}

export function PermissionRoute({ children, permission }: { children: ReactNode; permission: string | string[] }) {
  const { hasPermission, loading } = useAuth();
  const permissions = Array.isArray(permission) ? permission : [permission];

  if (loading) return <FullPageLoader />;
  if (!hasPermission(...permissions)) return <PermissionDenied />;
  return <>{children}</>;
}

/** Sends an already-signed-in user to the home of their portal. */
export function GuestRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) return <FullPageLoader />;
  if (user) return <Navigate to={homePathFor(user.role)} replace />;
  return <>{children}</>;
}

export function homePathFor(role: RoleName): string {
  switch (role) {
    case 'ADMIN':
      return '/admin/dashboard';
    case 'COMPANY_ADMIN':
    case 'OPERATOR':
      return '/company/dashboard';
    default:
      return '/customer/trips';
  }
}
