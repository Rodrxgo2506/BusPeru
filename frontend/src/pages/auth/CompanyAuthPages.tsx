import { BarChart3, Briefcase, CreditCard, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Checkbox, Input, Textarea } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { homePathFor } from '@/guards';
import { ApiError } from '@/services/api';
import { authService } from '@/services';
import { AuthDivider, AuthError, AuthShell, OAuthButtons } from './AuthShell';

const LOGIN_BENEFITS = [
  { icon: Briefcase, title: 'Gestiona tus viajes', description: 'Crea y administra tus rutas, horarios y precios.' },
  { icon: CreditCard, title: 'Controla tus ventas', description: 'Consulta tus ventas, reservas y liquidaciones.' },
  { icon: Users, title: 'Manifiestos y pasajeros', description: 'Administra la lista de pasajeros de cada viaje.' },
  { icon: BarChart3, title: 'Reportes en tiempo real', description: 'Accede a estadísticas y reportes de tu empresa.' },
];

export function CompanyLoginPage() {
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
      if (user.role === 'CUSTOMER') {
        setError('Esta cuenta es de cliente. Usa el inicio de sesión general de BusPerú.');
        return;
      }
      toast.success(`¡Bienvenido, ${user.first_name}!`);
      navigate(homePathFor(user.role), { replace: true });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'No pudimos iniciar sesión.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      title="Bienvenido al"
      highlight="Portal Empresa"
      subtitle="Gestiona tus viajes, ventas y pasajeros desde un solo lugar."
      benefits={LOGIN_BENEFITS}
    >
      <h2 className="text-center text-2xl font-bold text-ink">Iniciar sesión</h2>
      <p className="mt-1 text-center text-sm text-muted">Accede a tu cuenta empresa</p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
        <AuthError message={error} />
        <Input label="Correo electrónico" type="email" placeholder="ejemplo@empresa.com" value={email} onChange={(event) => setEmail(event.target.value)} required />
        <Input label="Contraseña" type="password" placeholder="Ingresa tu contraseña" value={password} onChange={(event) => setPassword(event.target.value)} required />

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

      <AuthDivider />
      <OAuthButtons scope="COMPANY" />

      <p className="mt-5 text-center text-sm text-muted">
        ¿Aún no tienes cuenta?{' '}
        <Link to="/empresa/registro" className="font-semibold text-brand-600 hover:text-brand-700">
          Registrar mi empresa
        </Link>
      </p>
    </AuthShell>
  );
}

const REGISTER_BENEFITS = [
  { icon: Users, title: 'Más pasajeros', description: 'Llega a miles de usuarios todos los días.' },
  { icon: Briefcase, title: 'Gestión fácil', description: 'Administra tus buses, rutas y viajes desde un solo lugar.' },
  { icon: BarChart3, title: 'Reportes en tiempo real', description: 'Monitorea tus ventas y rendimiento en tiempo real.' },
  { icon: CreditCard, title: 'Pagos seguros', description: 'Recibe tus pagos de forma segura y transparente.' },
];

export function CompanyRegisterPage() {
  const toast = useToast();
  const [step, setStep] = useState<1 | 2>(1);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const [company, setCompany] = useState({ legal_name: '', name: '', tax_id: '', phone: '', email: '', description: '' });
  const [admin, setAdmin] = useState({ first_name: '', last_name: '', email: '', phone: '', password: '', position: '' });

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setFieldErrors({});
    try {
      await authService.registerCompany({
        company: { ...company, description: company.description || null, phone: company.phone || null },
        admin: { ...admin, phone: admin.phone || null, position: admin.position || null },
      });
      setSubmitted(true);
      toast.success('Solicitud enviada', 'Te notificaremos cuando finalice la verificación.');
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.fields) setFieldErrors(caught.fields);
        else setError(caught.message);
        if (caught.fields && Object.keys(caught.fields).some((key) => key.startsWith('company'))) setStep(1);
      } else {
        setError('No pudimos registrar tu empresa. Inténtalo nuevamente.');
      }
    } finally {
      setLoading(false);
    }
  };

  if (submitted) {
    return (
      <AuthShell title="Registra tu empresa en" highlight="BusPerú" subtitle="Tu solicitud está en revisión." benefits={REGISTER_BENEFITS}>
        <div className="space-y-4 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-warning-50 text-warning-600">
            <Briefcase className="h-7 w-7" />
          </span>
          <h2 className="text-xl font-bold text-ink">Tu solicitud está en revisión</h2>
          <p className="text-sm text-muted">
            Hemos recibido correctamente tu solicitud de registro. Nuestro equipo está verificando la información enviada y te
            notificaremos por correo electrónico cuando el proceso finalice.
          </p>
          <Button fullWidth to="/empresa/login">
            Ir al inicio de sesión
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Registra tu empresa en"
      highlight="BusPerú"
      subtitle="Únete a nuestro sistema y comienza a ofrecer tus viajes a miles de pasajeros en todo el Perú."
      benefits={REGISTER_BENEFITS}
    >
      <h2 className="text-center text-xl font-bold text-ink">Información de la empresa</h2>
      <p className="mt-1 text-center text-sm text-muted">Completa los datos para crear tu cuenta</p>

      <ol className="mt-5 flex items-center justify-center gap-2" aria-label="Progreso del registro">
        {[
          { id: 1, label: 'Datos de empresa' },
          { id: 2, label: 'Representante' },
        ].map((item, index) => (
          <li key={item.id} className="flex items-center gap-2">
            {index > 0 && <span className="h-px w-8 bg-border" />}
            <span
              className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                step >= item.id ? 'bg-brand-500 text-white' : 'bg-slate-200 text-slate-500'
              }`}
            >
              {item.id}
            </span>
            <span className={`text-xs font-medium ${step >= item.id ? 'text-ink' : 'text-slate-400'}`}>{item.label}</span>
          </li>
        ))}
      </ol>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
        <AuthError message={error} />

        {step === 1 ? (
          <>
            <Input label="Razón social" placeholder="Ej: Transportes Express S.A.C." value={company.legal_name} onChange={(event) => setCompany({ ...company, legal_name: event.target.value })} error={fieldErrors['company.legal_name']} required />
            <Input label="Nombre comercial" placeholder="Ej: Expreso Andino" value={company.name} onChange={(event) => setCompany({ ...company, name: event.target.value })} error={fieldErrors['company.name']} required />
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="RUC" placeholder="Ej: 20123456789" value={company.tax_id} onChange={(event) => setCompany({ ...company, tax_id: event.target.value })} error={fieldErrors['company.tax_id']} required />
              <Input label="Teléfono" type="tel" placeholder="987 654 321" value={company.phone} onChange={(event) => setCompany({ ...company, phone: event.target.value })} error={fieldErrors['company.phone']} />
            </div>
            <Input label="Correo corporativo" type="email" placeholder="empresa@correo.com" value={company.email} onChange={(event) => setCompany({ ...company, email: event.target.value })} error={fieldErrors['company.email']} required />
            <Textarea label="Descripción" placeholder="Ej: Transporte interprovincial con servicio ejecutivo..." value={company.description} onChange={(event) => setCompany({ ...company, description: event.target.value })} rows={3} />

            <Button type="button" fullWidth size="lg" onClick={() => setStep(2)}>
              Continuar
            </Button>
          </>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Nombres" placeholder="Ej: Juan Carlos" value={admin.first_name} onChange={(event) => setAdmin({ ...admin, first_name: event.target.value })} error={fieldErrors['admin.first_name']} required />
              <Input label="Apellidos" placeholder="Ej: Pérez Gómez" value={admin.last_name} onChange={(event) => setAdmin({ ...admin, last_name: event.target.value })} error={fieldErrors['admin.last_name']} required />
            </div>
            <Input label="Correo del representante" type="email" placeholder="representante@empresa.com" value={admin.email} onChange={(event) => setAdmin({ ...admin, email: event.target.value })} error={fieldErrors['admin.email']} required />
            <Input label="Teléfono" type="tel" placeholder="987 654 321" value={admin.phone} onChange={(event) => setAdmin({ ...admin, phone: event.target.value })} />
            <Input label="Cargo" placeholder="Ej: Gerente general" value={admin.position} onChange={(event) => setAdmin({ ...admin, position: event.target.value })} />
            <Input
              label="Contraseña"
              type="password"
              placeholder="Crea una contraseña"
              value={admin.password}
              onChange={(event) => setAdmin({ ...admin, password: event.target.value })}
              error={fieldErrors['admin.password']}
              hint="Mínimo 8 caracteres, una mayúscula y un número."
              required
            />

            <div className="flex gap-3">
              <Button type="button" variant="secondary" fullWidth onClick={() => setStep(1)}>
                Volver
              </Button>
              <Button type="submit" fullWidth loading={loading}>
                Enviar solicitud
              </Button>
            </div>
          </>
        )}

        <div className="rounded-control border border-brand-100 bg-brand-50 p-3 text-xs text-brand-700">
          <strong>Tu información está protegida.</strong> En BusPerú cuidamos la privacidad y seguridad de tus datos.
        </div>
      </form>

      <p className="mt-5 text-center text-sm text-muted">
        ¿Ya tienes una cuenta?{' '}
        <Link to="/empresa/login" className="font-semibold text-brand-600 hover:text-brand-700">
          Iniciar sesión
        </Link>
      </p>
    </AuthShell>
  );
}
