import { CalendarDays, Gift, IdCard, Lock, Mail, Phone, Plane, ShieldCheck, Ticket } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Checkbox, Input, Select } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { ApiError } from '@/services/api';
import {
  DOCUMENT_TYPE_OPTIONS,
  DOCUMENT_UI,
  documentNumberError,
  isDocumentType,
  maskBirthDateInput,
  normalizeDocumentNumber,
  parseBirthDateInput,
} from '@/utils/identity';
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

  const [form, setForm] = useState({
    first_name: '', last_name: '', document_type: 'DNI', document_number: '', birth_date: '', email: '', phone: '', password: '', confirm: '',
  });
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const update = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));
  const docType = isDocumentType(form.document_type) ? form.document_type : 'DNI';
  const docUi = DOCUMENT_UI[docType];

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    // Documento y fecha: mismo formato que exige la API (que vuelve a validarlo). Solo formato, no identidad.
    const errores: Record<string, string> = {};
    const docError = documentNumberError(isDocumentType(form.document_type) ? form.document_type : '', form.document_number);
    if (docError) errores[form.document_type ? 'document_number' : 'document_type'] = docError;
    const nacimiento = parseBirthDateInput(form.birth_date);
    if (!form.birth_date.trim()) errores.birth_date = 'Ingresa tu fecha de nacimiento';
    else if ('error' in nacimiento) errores.birth_date = nacimiento.error;
    if (form.password !== form.confirm) errores.confirm = 'Las contraseñas no coinciden';
    if (Object.keys(errores).length > 0) {
      setFieldErrors(errores);
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
        document_type: docType,
        document_number: normalizeDocumentNumber(docType, form.document_number),
        birth_date: 'iso' in nacimiento ? nacimiento.iso : undefined,
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
        <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Select
            label="Tipo de documento"
            options={DOCUMENT_TYPE_OPTIONS}
            value={form.document_type}
            onChange={update('document_type')}
            error={fieldErrors.document_type}
            required
          />
          <Input
            label="Número de documento"
            placeholder={docUi.placeholder}
            icon={<IdCard className="h-4 w-4" />}
            inputMode={docUi.inputMode}
            maxLength={docUi.maxLength}
            autoComplete="off"
            value={form.document_number}
            onChange={update('document_number')}
            error={fieldErrors.document_number}
            hint={docUi.hint}
            required
          />
        </div>
        <Input
          label="Fecha de nacimiento"
          placeholder="DD/MM/AAAA"
          icon={<CalendarDays className="h-4 w-4" />}
          inputMode="numeric"
          autoComplete="bday"
          maxLength={10}
          value={form.birth_date}
          onChange={(event) => setForm((current) => ({ ...current, birth_date: maskBirthDateInput(event.target.value) }))}
          error={fieldErrors.birth_date}
          hint="Día, mes y año. Ej: 17/05/1999"
          required
        />
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
