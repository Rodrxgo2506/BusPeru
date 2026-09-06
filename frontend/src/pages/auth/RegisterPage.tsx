import { Gift, Lock, Mail, Phone, Plane, ShieldCheck, Ticket } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Checkbox, Input } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { ApiError } from '@/services/api';
import { AuthCardHeading, AuthError, AuthShell } from './AuthShell';

const BENEFITS = [
  { icon: Plane, title: 'Compra tus pasajes fácil y rápido', description: 'Encuentra las mejores rutas y precios en segundos.' },
  { icon: ShieldCheck, title: 'Viaja seguro', description: 'Contamos con empresas confiables y protocolos de seguridad.' },
  { icon: Ticket, title: 'Gestiona tus viajes', description: 'Revisa tus reservas, historial y mucho más.' },
  { icon: Gift, title: 'Ofertas exclusivas', description: 'Accede a promociones y descuentos solo para miembros.' },
];

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '', password: '', confirm: '' });
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const update = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    if (form.password !== form.confirm) {
      setFieldErrors({ confirm: 'Las contraseñas no coinciden' });
      return;
    }
    if (!accepted) {
      setError('Debes aceptar los Términos y Condiciones para continuar.');
      return;
    }

    setLoading(true);
    try {
      const user = await register({
        first_name: form.first_name,
        last_name: form.last_name,
        email: form.email,
        phone: form.phone || null,
        password: form.password,
      });
      toast.success(`¡Bienvenido a BusPerú, ${user.first_name}!`);
      navigate('/customer/trips', { replace: true });
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.fields) setFieldErrors(caught.fields);
        else setError(caught.message);
      } else {
        setError('No pudimos crear tu cuenta. Inténtalo nuevamente.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      title="Crea tu cuenta en"
      highlight="BusPerú"
      subtitle="Únete y disfruta de una forma más fácil de viajar."
      benefits={BENEFITS}
      promo={{ label: 'Tu próximo destino', lines: ['Está más cerca', 'de lo que imaginas'] }}
    >
      <AuthCardHeading title="Crear cuenta" subtitle="Completa tus datos para comenzar" />

      {/* Las dos vías de registro que ya existen: personal aquí, empresa en su propia ruta. */}
      <div className="mb-5 grid grid-cols-2 gap-1 rounded-control bg-slate-100 p-1">
        <span className="rounded-lg bg-brand-50 py-2 text-center text-sm font-semibold text-brand-600">Personal</span>
        <Link
          to="/empresa/registro"
          className="rounded-lg py-2 text-center text-sm font-medium text-slate-500 transition hover:bg-white hover:text-slate-700"
        >
          Empresa
        </Link>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <AuthError message={error} />

        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Nombres" placeholder="Ingresa tus nombres" value={form.first_name} onChange={update('first_name')} error={fieldErrors.first_name} required />
          <Input label="Apellidos" placeholder="Ingresa tus apellidos" value={form.last_name} onChange={update('last_name')} error={fieldErrors.last_name} required />
        </div>
        <Input
          label="Correo electrónico"
          type="email"
          placeholder="ejemplo@correo.com"
          icon={<Mail className="h-4 w-4" />}
          value={form.email}
          onChange={update('email')}
          error={fieldErrors.email}
          required
        />
        <Input
          label="Número de celular"
          type="tel"
          placeholder="Ej: 987 654 321"
          icon={<Phone className="h-4 w-4" />}
          value={form.phone}
          onChange={update('phone')}
          error={fieldErrors.phone}
        />
        <Input
          label="Contraseña"
          type="password"
          placeholder="Crea una contraseña"
          icon={<Lock className="h-4 w-4" />}
          value={form.password}
          onChange={update('password')}
          error={fieldErrors.password}
          hint="Mínimo 8 caracteres, una mayúscula y un número."
          required
        />
        <Input
          label="Confirmar contraseña"
          type="password"
          placeholder="Confirma tu contraseña"
          icon={<Lock className="h-4 w-4" />}
          value={form.confirm}
          onChange={update('confirm')}
          error={fieldErrors.confirm}
          required
        />

        <Checkbox
          checked={accepted}
          onChange={(event) => setAccepted(event.target.checked)}
          label={
            <>
              Acepto los <span className="font-medium text-brand-600">Términos y Condiciones</span> y la{' '}
              <span className="font-medium text-brand-600">Política de Privacidad</span>.
            </>
          }
        />

        <Button type="submit" fullWidth size="lg" loading={loading}>
          Crear cuenta
        </Button>
      </form>

      <p className="mt-5 text-center text-sm text-muted">
        ¿Ya tienes cuenta?{' '}
        <Link to="/login" className="font-semibold text-brand-600 hover:text-brand-700">
          Inicia sesión
        </Link>
      </p>
    </AuthShell>
  );
}
