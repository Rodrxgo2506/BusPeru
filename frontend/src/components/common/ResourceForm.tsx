import { useEffect, useState, type FormEvent } from 'react';
import { Button, Checkbox, Input, Modal, Select, Textarea } from '@/components/ui';
import { ApiError } from '@/services/api';
import { cn } from '@/utils/cn';

export interface FormField {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'email' | 'tel' | 'password' | 'select' | 'textarea' | 'date' | 'datetime-local' | 'time' | 'checkbox';
  options?: Array<{ value: string | number; label: string }>;
  placeholder?: string;
  required?: boolean;
  hint?: string;
  full?: boolean;
  /** Hidden when editing (e.g. the password of an existing user). */
  createOnly?: boolean;
  step?: string;
}

interface ResourceFormProps<T extends Record<string, unknown>> {
  open: boolean;
  onClose: () => void;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
  title: string;
  description?: string;
  fields: FormField[];
  initialValues?: Partial<T> | null;
  submitLabel?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

function normalize(value: unknown, field: FormField): string | boolean {
  if (field.type === 'checkbox') return Boolean(value);
  if (value === null || value === undefined) return '';
  if (field.type === 'datetime-local' && typeof value === 'string') return value.replace(' ', 'T').slice(0, 16);
  if (field.type === 'date' && typeof value === 'string') return value.slice(0, 10);
  return String(value);
}

export function ResourceForm<T extends Record<string, unknown>>({
  open,
  onClose,
  onSubmit,
  title,
  description,
  fields,
  initialValues,
  submitLabel = 'Guardar',
  size = 'md',
}: ResourceFormProps<T>) {
  const isEditing = Boolean(initialValues);
  const visibleFields = fields.filter((field) => !field.createOnly || !isEditing);

  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    const next: Record<string, string | boolean> = {};
    for (const field of visibleFields) {
      next[field.name] = normalize(initialValues?.[field.name], field);
    }
    setValues(next);
    setErrors({});
    setGeneralError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialValues]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setErrors({});
    setGeneralError(null);

    const payload: Record<string, unknown> = {};
    for (const field of visibleFields) {
      const raw = values[field.name];
      if (field.type === 'checkbox') {
        payload[field.name] = Boolean(raw);
        continue;
      }
      const text = String(raw ?? '').trim();
      if (text === '') {
        payload[field.name] = field.required ? '' : null;
        continue;
      }
      payload[field.name] = field.type === 'number' ? Number(text) : text;
    }

    try {
      await onSubmit(payload);
      onClose();
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.fields) setErrors(error.fields);
        setGeneralError(error.fields ? null : error.message);
      } else {
        setGeneralError('No se pudo guardar. Inténtalo nuevamente.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size={size}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button form="resource-form" type="submit" loading={submitting}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id="resource-form" onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
        {generalError && (
          <div className="rounded-control border border-danger-200 bg-danger-50 p-3 text-sm text-danger-700 sm:col-span-2" role="alert">
            {generalError}
          </div>
        )}

        {visibleFields.map((field) => {
          const error = errors[field.name];
          const wrapperClass = field.full || field.type === 'textarea' ? 'sm:col-span-2' : undefined;

          if (field.type === 'checkbox') {
            return (
              <div key={field.name} className={cn('flex items-center', wrapperClass)}>
                <Checkbox
                  label={field.label}
                  checked={Boolean(values[field.name])}
                  onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.checked }))}
                />
              </div>
            );
          }

          if (field.type === 'select') {
            return (
              <Select
                key={field.name}
                label={field.label}
                required={field.required}
                error={error}
                hint={field.hint}
                options={field.options ?? []}
                placeholder={field.placeholder ?? 'Seleccionar...'}
                value={String(values[field.name] ?? '')}
                onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
                containerClassName={wrapperClass}
              />
            );
          }

          if (field.type === 'textarea') {
            return (
              <Textarea
                key={field.name}
                label={field.label}
                required={field.required}
                error={error}
                hint={field.hint}
                placeholder={field.placeholder}
                value={String(values[field.name] ?? '')}
                onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
                containerClassName={wrapperClass}
              />
            );
          }

          return (
            <Input
              key={field.name}
              label={field.label}
              type={field.type ?? 'text'}
              step={field.step}
              required={field.required}
              error={error}
              hint={field.hint}
              placeholder={field.placeholder}
              value={String(values[field.name] ?? '')}
              onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
              containerClassName={wrapperClass}
            />
          );
        })}
      </form>
    </Modal>
  );
}
