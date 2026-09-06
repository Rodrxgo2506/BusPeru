import { Check, Info, Lock, Mail, ShieldCheck, X, Zap } from 'lucide-react';
import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Input } from '@/components/ui';
import { ApiError } from '@/services/api';
import { authService } from '@/services';
import { AuthCardHeading, AuthShell } from './AuthShell';

const BENEFITS = [
  { icon: ShieldCheck, title: 'Seguro', description: 'Tus datos están protegidos con cifrado SSL.' },
  { icon: Zap, title: 'Rápido', description: 'Recibe el código en segundos.' },
  { icon: Lock, title: 'Confiable', description: 'Protegemos tu información en todo momento.' },
];

const CODE_LENGTH = 6;
const RESEND_COOLDOWN_SECONDS = 45;

type Step = 'email' | 'code' | 'password' | 'done';

/** Reglas que aplica el backend (`auth.validators.ts`), mostradas mientras se escribe. */
const PASSWORD_RULES: Array<{ label: string; test: (value: string) => boolean }> = [
  { label: 'Al menos 8 caracteres', test: (value) => value.length >= 8 },
  { label: 'Una mayúscula', test: (value) => /[A-Z]/.test(value) },
  { label: 'Un número', test: (value) => /[0-9]/.test(value) },
];

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * Recuperación de contraseña en tres pasos (mockup 10):
 * correo → código de 6 dígitos → nueva contraseña.
 *
 * Ninguna pantalla revela si el correo existe: tras enviar el formulario siempre se avanza
 * al paso del código, con el mismo mensaje que devuelve la API.
 */
export function ForgotPasswordPage() {
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [ticket, setTicket] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const requestCode = async (target: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await authService.forgotPassword(target);
      setNotice(result.message);
      setStep('code');
    } catch (caught) {
      setError(message(caught, 'No pudimos procesar tu solicitud. Inténtalo de nuevo.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      title="Recupera el acceso a tu cuenta"
      highlight="BusPerú"
      subtitle={
        step === 'email'
          ? 'Ingresa tu correo electrónico y te enviaremos un código para restablecer tu contraseña.'
          : step === 'code'
            ? 'Revisa tu bandeja de entrada e ingresa el código de 6 dígitos que te enviamos.'
            : 'Crea una contraseña nueva para recuperar el acceso a tu cuenta.'
      }
      benefits={BENEFITS}
      eyebrow="Recupera tu cuenta"
      promo={{ label: 'Sigue viajando', lines: ['Estamos contigo', 'en cada destino'] }}
    >
      {step === 'email' && (
        <EmailStep
          email={email}
          onEmailChange={setEmail}
          onSubmit={() => void requestCode(email)}
          loading={loading}
          error={error}
        />
      )}

      {step === 'code' && (
        <CodeStep
          email={email}
          notice={notice}
          onVerified={(issued) => {
            setTicket(issued);
            setStep('password');
          }}
          onChangeEmail={() => {
            setStep('email');
            setNotice(null);
            setError(null);
          }}
        />
      )}

      {step === 'password' && (
        <PasswordStep
          email={email}
          ticket={ticket}
          onDone={() => setStep('done')}
          onExpired={() => {
            setStep('email');
            setError('La solicitud expiró. Vuelve a pedir un código.');
          }}
        />
      )}

      {step === 'done' && <DoneStep onLogin={() => navigate('/login')} />}
    </AuthShell>
  );
}

function EmailStep({
  email,
  onEmailChange,
  onSubmit,
  loading,
  error,
}: {
  email: string;
  onEmailChange: (value: string) => void;
  onSubmit: () => void;
  loading: boolean;
  error: string | null;
}) {
  const [touched, setTouched] = useState(false);
  const invalid = touched && !/^\S+@\S+\.\S+$/.test(email);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!/^\S+@\S+\.\S+$/.test(email)) return;
    onSubmit();
  };

  return (
    <>
      <AuthCardHeading title="Recuperar contraseña" subtitle="Ingresa tu correo electrónico" />

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <Input
          label="Correo electrónico"
          type="email"
          autoComplete="email"
          placeholder="ejemplo@correo.com"
          value={email}
          onChange={(event) => onEmailChange(event.target.value)}
          onBlur={() => setTouched(true)}
          error={invalid ? 'Ingresa un correo electrónico válido' : undefined}
          icon={<Mail className="h-4 w-4" />}
          required
        />

        {error && (
          <p role="alert" className="rounded-control border border-danger-200 bg-danger-50 p-3 text-sm text-danger-600">
            {error}
          </p>
        )}

        <div className="flex gap-2.5 rounded-control border border-info-100 bg-info-50 p-3 text-xs leading-relaxed text-info-600">
          <Info className="mt-px h-4 w-4 shrink-0" aria-hidden />
          <span>Te enviaremos un código de 6 dígitos para que puedas crear una nueva contraseña.</span>
        </div>

        <Button type="submit" fullWidth size="lg" loading={loading}>
          Enviar código de recuperación
        </Button>

        <Link to="/login" className="block text-center text-sm font-semibold text-brand-600 hover:text-brand-700">
          ← Volver al inicio de sesión
        </Link>
      </form>
    </>
  );
}

function CodeStep({
  email,
  notice,
  onVerified,
  onChangeEmail,
}: {
  email: string;
  notice: string | null;
  onVerified: (ticket: string) => void;
  onChangeEmail: () => void;
}) {
  const [digits, setDigits] = useState<string[]>(Array(CODE_LENGTH).fill(''));
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);

  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const code = digits.join('');

  useEffect(() => {
    inputs.current[0]?.focus();
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  const setDigit = (index: number, value: string) => {
    const clean = value.replace(/\D/g, '').slice(-1);
    setDigits((current) => {
      const next = [...current];
      next[index] = clean;
      return next;
    });
    if (clean && index < CODE_LENGTH - 1) inputs.current[index + 1]?.focus();
  };

  const handleKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && !digits[index] && index > 0) inputs.current[index - 1]?.focus();
    if (event.key === 'ArrowLeft' && index > 0) inputs.current[index - 1]?.focus();
    if (event.key === 'ArrowRight' && index < CODE_LENGTH - 1) inputs.current[index + 1]?.focus();
  };

  /** Pegar el código completo desde el correo rellena las seis casillas. */
  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, CODE_LENGTH);
    if (!pasted) return;
    event.preventDefault();
    const next = Array(CODE_LENGTH).fill('');
    for (let index = 0; index < pasted.length; index += 1) next[index] = pasted[index];
    setDigits(next);
    inputs.current[Math.min(pasted.length, CODE_LENGTH - 1)]?.focus();
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    if (code.length !== CODE_LENGTH) {
      setError('Ingresa los 6 dígitos del código.');
      return;
    }
    setLoading(true);
    setError(null);
    setResent(null);
    try {
      const result = await authService.verifyResetCode(email, code);
      onVerified(result.ticket);
    } catch (caught) {
      setError(message(caught, 'El código no es válido o ha expirado.'));
      setDigits(Array(CODE_LENGTH).fill(''));
      inputs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  const resend = async () => {
    setResending(true);
    setError(null);
    setResent(null);
    try {
      const result = await authService.resendResetCode(email);
      setResent(result.message);
      setDigits(Array(CODE_LENGTH).fill(''));
      setCooldown(RESEND_COOLDOWN_SECONDS);
      inputs.current[0]?.focus();
    } catch (caught) {
      setError(message(caught, 'No pudimos reenviar el código. Inténtalo en unos segundos.'));
    } finally {
      setResending(false);
    }
  };

  const mmss = `${String(Math.floor(cooldown / 60)).padStart(2, '0')}:${String(cooldown % 60).padStart(2, '0')}`;

  return (
    <>
      <h2 className="text-center text-2xl font-bold text-ink">Código de verificación</h2>

      <p className="mt-3 text-center text-sm text-muted">
        Hemos enviado un código de verificación a
        <span className="mt-1 flex items-center justify-center gap-2 font-semibold text-brand-600">
          <Mail className="h-4 w-4" />
          {email}
        </span>
      </p>

      {notice && <p className="mt-3 text-center text-xs text-muted">{notice}</p>}

      <form onSubmit={verify} className="mt-6 space-y-4" noValidate>
        <div className="flex justify-center gap-2" role="group" aria-label="Código de verificación de 6 dígitos">
          {digits.map((digit, index) => (
            <input
              key={index}
              ref={(element) => {
                inputs.current[index] = element;
              }}
              value={digit}
              onChange={(event) => setDigit(index, event.target.value)}
              onKeyDown={(event) => handleKeyDown(index, event)}
              onPaste={handlePaste}
              inputMode="numeric"
              autoComplete={index === 0 ? 'one-time-code' : 'off'}
              maxLength={1}
              aria-label={`Dígito ${index + 1}`}
              className="h-14 w-11 rounded-control border border-border text-center text-xl font-bold text-ink transition focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 sm:w-12"
            />
          ))}
        </div>

        <p className="text-center text-xs text-muted">El código expirará en 15 minutos.</p>

        {error && (
          <p role="alert" className="rounded-control border border-danger-200 bg-danger-50 p-3 text-center text-sm text-danger-600">
            {error}
          </p>
        )}
        {resent && (
          <p role="status" className="rounded-control border border-success-200 bg-success-50 p-3 text-center text-sm text-success-600">
            {resent}
          </p>
        )}

        <Button type="submit" fullWidth size="lg" loading={loading} disabled={code.length !== CODE_LENGTH}>
          Verificar código
        </Button>

        <p className="text-center text-sm text-muted">
          ¿No recibiste el código?{' '}
          {cooldown > 0 ? (
            <span className="font-semibold text-slate-400">Reenviar código ({mmss})</span>
          ) : (
            <button
              type="button"
              onClick={() => void resend()}
              disabled={resending}
              className="font-semibold text-brand-600 transition hover:text-brand-700 disabled:opacity-60"
            >
              {resending ? 'Reenviando...' : 'Reenviar código'}
            </button>
          )}
        </p>

        <button type="button" onClick={onChangeEmail} className="block w-full text-center text-sm font-semibold text-brand-600 hover:text-brand-700">
          Usar otro correo
        </button>
      </form>
    </>
  );
}

function PasswordStep({
  email,
  ticket,
  onDone,
  onExpired,
}: {
  email: string;
  ticket: string;
  onDone: () => void;
  onExpired: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rulesMet = PASSWORD_RULES.every((rule) => rule.test(password));
  const mismatch = touched && confirm.length > 0 && confirm !== password;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!rulesMet || password !== confirm) return;

    setLoading(true);
    setError(null);
    try {
      await authService.resetPassword({ email, ticket, new_password: password, confirm_password: confirm });
      onDone();
    } catch (caught) {
      const text = message(caught, 'No pudimos actualizar tu contraseña. Inténtalo de nuevo.');
      // Si la solicitud caducó hay que volver a empezar: el ticket ya no sirve.
      if (caught instanceof ApiError && /expirad|no es válida/i.test(caught.message)) onExpired();
      else setError(text);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <h2 className="text-center text-2xl font-bold text-ink">Nueva contraseña</h2>

      <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
        <Input
          label="Nueva contraseña"
          type="password"
          autoComplete="new-password"
          placeholder="Ingresa tu nueva contraseña"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />

        <ul className="space-y-1.5 text-xs">
          <li className="font-medium text-slate-500">Tu contraseña debe contener:</li>
          {PASSWORD_RULES.map((rule) => {
            const passed = rule.test(password);
            return (
              <li key={rule.label} className={`flex items-center gap-2 ${passed ? 'text-success-600' : 'text-slate-500'}`}>
                {passed ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5 text-slate-300" />}
                {rule.label}
              </li>
            );
          })}
        </ul>

        <Input
          label="Confirmar contraseña"
          type="password"
          autoComplete="new-password"
          placeholder="Confirma tu nueva contraseña"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          onBlur={() => setTouched(true)}
          error={mismatch ? 'Las contraseñas no coinciden' : undefined}
          required
        />

        {error && (
          <p role="alert" className="rounded-control border border-danger-200 bg-danger-50 p-3 text-sm text-danger-600">
            {error}
          </p>
        )}

        <Button type="submit" fullWidth size="lg" loading={loading} disabled={!rulesMet || password !== confirm}>
          Restablecer contraseña
        </Button>

        <Link to="/login" className="block text-center text-sm font-semibold text-brand-600 hover:text-brand-700">
          Volver al inicio de sesión
        </Link>
      </form>
    </>
  );
}

function DoneStep({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="space-y-5 text-center">
      <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-success-50 text-success-600">
        <ShieldCheck className="h-8 w-8" />
      </span>
      <h2 className="text-2xl font-bold text-ink">Contraseña actualizada</h2>
      <p className="text-sm text-muted">
        Tu contraseña se actualizó correctamente. Ya puedes iniciar sesión con tus nuevos datos.
      </p>
      <Button fullWidth size="lg" onClick={onLogin}>
        Iniciar sesión
      </Button>
    </div>
  );
}
