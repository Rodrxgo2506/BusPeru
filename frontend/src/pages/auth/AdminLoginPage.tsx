import { BarChart3, Bus, Lock, ShieldCheck, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Checkbox, Input, Logo } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { ApiError } from '@/services/api';
import { AuthError, OAuthButtons } from './AuthShell';

const FEATURES = [
  { icon: BarChart3, label: 'Estadísticas en tiempo real' },
  { icon: Users, label: 'Gestión de usuarios' },
  { icon: Bus, label: 'Control de operaciones' },
  { icon: ShieldCheck, label: 'Seguridad avanzada' },
];

export function AdminLoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const user = await login(email, password);
      if (user.role !== 'ADMIN') {
        setError('Esta área es exclusiva para administradores autorizados de la plataforma BusPerú.');
        return;
      }
      toast.success('¡Bienvenido de vuelta, Admin!');
      navigate('/admin/dashboard', { replace: true });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'No pudimos iniciar sesión.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="flex items-center justify-center bg-white px-6 py-12 sm:px-12">
        <div className="w-full max-w-md">
          <Logo subtitle="Administrador" />

          <h1 className="mt-10 text-3xl font-bold tracking-tight text-ink">Iniciar sesión</h1>
          <p className="mt-1.5 text-sm text-muted">Accede al panel de administración de BusPerú.</p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-4" noValidate>
            <AuthError message={error} />

            <Input label="Correo electrónico" type="email" placeholder="admin@busperu.com" value={email} onChange={(event) => setEmail(event.target.value)} required />
            <Input label="Contraseña" type="password" placeholder="Tu contraseña" value={password} onChange={(event) => setPassword(event.target.value)} required />

            <div className="flex items-center justify-between">
              <Checkbox label="Recordarme" />
              <Link to="/recuperar-contrasena" className="text-sm font-medium text-danger-600 hover:text-danger-700">
                ¿Olvidaste tu contraseña?
              </Link>
            </div>

            <Button type="submit" variant="admin" fullWidth size="lg" loading={loading} icon={<ShieldCheck className="h-4 w-4" />}>
              Iniciar sesión
            </Button>
          </form>

          {/* Mockup 30: el panel de administración ofrece los dos proveedores. */}
          <OAuthButtons providers={['GOOGLE', 'MICROSOFT']} scope="ADMIN" />

          <p className="mt-6 text-center text-sm text-muted">
            ¿No eres administrador?{' '}
            <Link to="/" className="font-semibold text-danger-600 hover:text-danger-700">
              Volver al sitio
            </Link>
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-5 text-xs text-muted">
            <span className="flex items-center gap-1.5">
              <Lock className="h-3.5 w-3.5" />
              Conexión segura
            </span>
            <span>© {new Date().getFullYear()} BusPerú. Todos los derechos reservados.</span>
          </div>
        </div>
      </div>

      <div className="relative hidden overflow-hidden bg-admin-900 lg:flex lg:flex-col lg:justify-center lg:px-14">
        <div className="absolute inset-0 opacity-20" aria-hidden>
          <div className="absolute -right-20 top-10 h-80 w-80 rounded-full bg-danger-600 blur-[120px]" />
          <div className="absolute bottom-0 left-0 h-80 w-80 rounded-full bg-blue-600 blur-[140px]" />
        </div>

        <div className="relative">
          <h2 className="text-4xl font-bold leading-tight text-white">
            Panel de administración
            <br />
            BusPerú
          </h2>
          <p className="mt-4 max-w-md text-slate-300">Gestiona y controla toda la plataforma desde un solo lugar.</p>

          <ul className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {FEATURES.map((feature) => {
              const Icon = feature.icon;
              return (
                <li key={feature.label} className="rounded-card border border-white/10 bg-white/5 p-4 text-center">
                  <Icon className="mx-auto h-6 w-6 text-white" />
                  <p className="mt-2 text-xs font-medium leading-snug text-slate-300">{feature.label}</p>
                </li>
              );
            })}
          </ul>

          <div className="mt-12 flex items-start gap-3 rounded-card border border-white/10 bg-white/5 p-4">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-danger-500" />
            <div>
              <p className="text-sm font-semibold text-white">Acceso restringido</p>
              <p className="mt-0.5 text-xs text-slate-400">
                Esta área es exclusiva para administradores autorizados de la plataforma BusPerú.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
