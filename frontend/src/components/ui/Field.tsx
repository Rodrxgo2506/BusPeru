import { Eye, EyeOff } from 'lucide-react';
import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/utils/cn';

const CONTROL_BASE =
  'w-full rounded-control border border-border bg-white text-sm text-ink placeholder:text-slate-400 transition ' +
  'focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:bg-slate-50 disabled:text-slate-500';

interface FieldWrapperProps {
  label?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}

export function FieldWrapper({ label, error, hint, required, htmlFor, children, className }: FieldWrapperProps) {
  return (
    <div className={className}>
      {label && (
        <label htmlFor={htmlFor} className="field-label">
          {label}
          {required && <span className="ml-0.5 text-danger-600">*</span>}
        </label>
      )}
      {children}
      {error ? (
        <p className="mt-1.5 text-xs font-medium text-danger-600">{error}</p>
      ) : hint ? (
        <p className="mt-1.5 text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  icon?: ReactNode;
  containerClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, hint, icon, className, containerClassName, id, type = 'text', ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [revealed, setRevealed] = useState(false);
  const isPassword = type === 'password';

  return (
    <FieldWrapper label={label} error={error} hint={hint} required={props.required} htmlFor={inputId} className={containerClassName}>
      <div className="relative">
        {icon && <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">{icon}</span>}
        <input
          ref={ref}
          id={inputId}
          type={isPassword && revealed ? 'text' : type}
          aria-invalid={error ? true : undefined}
          className={cn(CONTROL_BASE, 'h-11 px-3.5', icon && 'pl-10', isPassword && 'pr-10', error && 'border-danger-500 focus:border-danger-500 focus:ring-danger-500/20', className)}
          {...props}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setRevealed((current) => !current)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 transition hover:text-slate-600"
            aria-label={revealed ? 'Ocultar contraseña' : 'Mostrar contraseña'}
          >
            {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}
      </div>
    </FieldWrapper>
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  hint?: string;
  options: Array<{ value: string | number; label: string }>;
  placeholder?: string;
  containerClassName?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, error, hint, options, placeholder, className, containerClassName, id, ...props },
  ref,
) {
  const generatedId = useId();
  const selectId = id ?? generatedId;

  return (
    <FieldWrapper label={label} error={error} hint={hint} required={props.required} htmlFor={selectId} className={containerClassName}>
      <select
        ref={ref}
        id={selectId}
        aria-invalid={error ? true : undefined}
        className={cn(CONTROL_BASE, 'h-11 cursor-pointer px-3.5', error && 'border-danger-500', className)}
        {...props}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldWrapper>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  hint?: string;
  containerClassName?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, error, hint, className, containerClassName, id, rows = 4, ...props },
  ref,
) {
  const generatedId = useId();
  const textareaId = id ?? generatedId;

  return (
    <FieldWrapper label={label} error={error} hint={hint} required={props.required} htmlFor={textareaId} className={containerClassName}>
      <textarea
        ref={ref}
        id={textareaId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        className={cn(CONTROL_BASE, 'resize-y px-3.5 py-2.5', error && 'border-danger-500', className)}
        {...props}
      />
    </FieldWrapper>
  );
});

export function Checkbox({ label, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode }) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  return (
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        className={cn('mt-0.5 h-4 w-4 cursor-pointer rounded border-slate-300 text-brand-500 focus:ring-brand-500', className)}
        {...props}
      />
      {label && (
        <label htmlFor={id} className="cursor-pointer text-sm text-slate-600">
          {label}
        </label>
      )}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <label className={cn('flex items-center gap-3', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors', checked ? 'bg-brand-500' : 'bg-slate-300')}
      >
        <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-5' : 'translate-x-0.5')} />
      </button>
      {label && <span className="text-sm text-slate-700">{label}</span>}
    </label>
  );
}
