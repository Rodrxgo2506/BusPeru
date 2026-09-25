import { Gift, Lock, Mail, Plane, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button, Checkbox, Input } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { homePathFor } from '@/guards';
import { ApiError } from '@/services/api';
import { AuthCardHeading, AuthError, AuthShell, OAuthButtons } from './AuthShell';

const BENEFITS = [
  { icon: Plane, title: 'Compra tus pasajes fácil y rápido', description: 'Encuentra las mejores rutas y precios en segundos.' },
  { icon: ShieldCheck, title: 'Viaja seguro', description: 'Contamos con empresas confiables y protocolos de seguridad.' },
  { icon: Gift, title: 'Gestiona tus viajes', description: 'Revisa tus reservas, historial y mucho más.' },
];

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // H-35: react-router ≤ 7.17 acepta rutas con barra invertida («/\evil.com») como redirección
  // externa (GHSA-wrjc-x8rr-h8h6). `from` lo pone el propio guard, pero solo se sigue si es una
  // ruta interna: empieza por «/» y no por «//» ni «/\».
  const from = (location.state as { from?: unknown } | null)?.from;
  const redirectTo = typeof from === 'string' && /^\/(?![/\\])/.test(from) && !from.includes('\\') ? from : undefined;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const user = await login(email, password);
      toast.success(`¡Bienvenido de nuevo, ${user.first_name}!`);
      navigate(redirectTo ?? homePathFor(user.role), { replace: true });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'No pudimos iniciar sesión. Inténtalo nuevamente.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      eyebrow="Bienvenido de nuevo"
      title="Inicia sesión en"
      highlight="BusPerú"
      subtitle="Accede a tu cuenta y continúa planificando tus próximos viajes."
      benefits={BENEFITS}
      promo={{ label: 'Más destinos, más experiencias', lines: ['Viajar por el Perú', 'es más fácil contigo'] }}
    >
      <AuthCardHeading title="Iniciar sesión" subtitle="Ingresa a tu cuenta para continuar" />

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <AuthError message={error} />

        <Input
          label="Correo electrónico"
          type="email"
          autoComplete="email"
          placeholder="ejemplo@correo.com"
          icon={<Mail className="h-4 w-4" />}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <Input
          label="Contraseña"
          type="password"
          autoComplete="current-password"
          placeholder="Ingresa tu contraseña"
          icon={<Lock className="h-4 w-4" />}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />

        <div className="flex items-center justify-between">
          <Checkbox label="Recordarme" />
          <Link to="/recuperar-contrasena" className="text-sm font-medium text-brand-600 hover:text-brand-700">
            ¿Olvidaste tu contraseña?
          </Link>
        </div>

        <Button type="submit" fullWidth size="lg" loading={loading}>
          Iniciar sesión
        </Button>
      </form>

      <OAuthButtons scope="CUSTOMER" />

      <p className="mt-5 text-center text-sm text-muted">
        ¿No tienes cuenta?{' '}
        <Link to="/registro" className="font-semibold text-brand-600 hover:text-brand-700">
          Regístrate aquí
        </Link>
      </p>
    </AuthShell>
  );
}
