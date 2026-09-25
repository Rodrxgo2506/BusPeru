import { LogOut } from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Avatar } from '@/components/ui';
import { CUSTOMER_NAV, ADMIN_NAV, COMPANY_NAV } from '@/constants/navigation';
import { useAuth } from '@/context/AuthContext';
import { cn } from '@/utils/cn';
import { PortalLayout } from './PortalLayout';

export { PublicLayout } from './PublicLayout';
export { PortalLayout, PortalPage } from './PortalLayout';

export function CompanyLayout() {
  return <PortalLayout items={COMPANY_NAV} theme="light" searchPlaceholder="Buscar viajes, reservas, pasajeros..." />;
}

export function AdminLayout() {
  return <PortalLayout items={ADMIN_NAV} theme="dark" brandSubtitle="Administrador" searchPlaceholder="Buscar empresas, usuarios, viajes, reservas..." />;
}

/** The customer area lives inside the public shell, with its own side navigation. */
export function CustomerLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    /* `isolate` crea aquí el contexto de apilamiento del que depende el fondo panorámico de
       «Mi perfil»: sin él, su capa `-z-10` se escaparía al contexto raíz y quedaría debajo
       del blanco opaco del armazón público, es decir, invisible. En las demás pantallas del
       área de cliente no cambia nada, porque ninguna dibuja fondo. */
    <div className="relative isolate mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        {/* min-w-0: sin esto el nav con scroll horizontal estira la columna del grid. */}
        <aside className="min-w-0 lg:sticky lg:top-24 lg:self-start">
          <div className="card overflow-hidden border-white/70 bg-white/85 shadow-panel backdrop-blur-md">
            <div className="flex items-center gap-3 border-b border-border p-5">
              <Avatar firstName={user?.first_name} lastName={user?.last_name} src={user?.avatar_url} size="lg" />
              <div className="min-w-0">
                <p className="truncate font-semibold text-ink">
                  {user?.first_name} {user?.last_name}
                </p>
                <p className="truncate text-xs text-muted">{user?.email}</p>
              </div>
            </div>
            <nav className="scrollbar-none flex gap-1 overflow-x-auto p-2 lg:block lg:space-y-0.5" aria-label="Mi cuenta">
              {CUSTOMER_NAV.map((item) =>
                item.disabled ? (
                  <span
                    key={item.to}
                    title="Disponible próximamente"
                    aria-disabled="true"
                    className="flex shrink-0 cursor-not-allowed items-center gap-3 whitespace-nowrap rounded-control px-3 py-2.5 text-sm font-medium text-slate-300 lg:w-full"
                  >
                    {item.icon}
                    {item.label}
                  </span>
                ) : (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      cn(
                        'flex shrink-0 items-center gap-3 whitespace-nowrap rounded-control px-3 py-2.5 text-sm font-medium transition lg:w-full',
                        isActive ? 'bg-brand-50 text-brand-600' : 'text-slate-600 hover:bg-slate-50',
                      )
                    }
                  >
                    {item.icon}
                    {item.label}
                  </NavLink>
                ),
              )}
              <button
                type="button"
                onClick={() => void logout().then(() => navigate('/'))}
                className="flex shrink-0 items-center gap-3 whitespace-nowrap rounded-control px-3 py-2.5 text-sm font-medium text-danger-600 transition hover:bg-danger-50 lg:w-full"
              >
                <LogOut className="h-[18px] w-[18px]" />
                Cerrar sesión
              </button>
            </nav>
          </div>
        </aside>

        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
