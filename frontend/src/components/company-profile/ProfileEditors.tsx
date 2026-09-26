import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Input, Select } from '@/components/ui';
import type { Moderated, ReviewStatus, SpecialHours, TimeRange, WeeklyHours } from '@/types/company-profile';
import { REVIEW_STATUS_LABELS, WEEK_DAYS } from '@/utils/company-profile';
import { formatDateTime } from '@/utils/format';

/** F18-19 · piezas reutilizables de los editores del perfil (panel de empresa y supervisión ADMIN). */

export function ReviewStatusBadge({ status }: { status: ReviewStatus | null | undefined }) {
  if (!status) return <Badge>Sin perfil</Badge>;
  const tone = status === 'APPROVED' ? 'success' : status === 'PENDING' ? 'warning' : status === 'REJECTED' ? 'danger' : 'neutral';
  return <Badge tone={tone}>{REVIEW_STATUS_LABELS[status]}</Badge>;
}

/** Estado de moderación de un contenido: badges, nota del ADMIN y suspensión. */
export function ModerationSummary({ item }: { item: Moderated & { is_active?: boolean } }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <ReviewStatusBadge status={item.review_status} />
      {item.is_published ? <Badge tone="info">Hay una versión publicada</Badge> : <Badge>Nunca publicado</Badge>}
      {item.is_active === false && <Badge>Oculto por la empresa</Badge>}
      {item.suspended_at && <Badge tone="danger">Suspendido por BusPerú</Badge>}
      {item.review_status === 'REJECTED' && item.moderation_note && (
        <span className="w-full rounded bg-danger-50 px-2 py-1 text-danger-700">Motivo del rechazo: {item.moderation_note}</span>
      )}
      {item.suspended_at && item.suspension_reason && (
        <span className="w-full rounded bg-danger-50 px-2 py-1 text-danger-700">Suspensión: {item.suspension_reason}</span>
      )}
      {item.submitted_at && item.review_status === 'PENDING' && <span className="text-muted">Enviado el {formatDateTime(item.submitted_at)}</span>}
    </div>
  );
}

/** Lista de textos cortos editable (características, valores). */
export function TextListEditor({ label, values, onChange, max, placeholder }: { label: string; values: string[]; onChange: (values: string[]) => void; max: number; placeholder?: string }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const value = draft.trim();
    if (!value || values.length >= max || values.some((v) => v.toLocaleLowerCase('es') === value.toLocaleLowerCase('es'))) return;
    onChange([...values, value]);
    setDraft('');
  };
  return (
    <div>
      <p className="mb-1.5 text-sm font-medium text-ink">{label}</p>
      <ul className="space-y-1.5">
        {values.map((value, index) => (
          <li key={value} className="flex items-center gap-2 rounded-control bg-slate-50 px-3 py-1.5 text-sm">
            <span className="min-w-0 flex-1 truncate">{value}</span>
            <button type="button" aria-label={`Subir ${value}`} disabled={index === 0} onClick={() => onChange(values.map((v, i) => (i === index - 1 ? value : i === index ? values[index - 1]! : v)))} className="rounded p-1 text-slate-500 hover:bg-white disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" /></button>
            <button type="button" aria-label={`Quitar ${value}`} onClick={() => onChange(values.filter((_, i) => i !== index))} className="rounded p-1 text-danger-600 hover:bg-white"><X className="h-3.5 w-3.5" /></button>
          </li>
        ))}
      </ul>
      {values.length < max && (
        <div className="mt-2 flex gap-2">
          <Input
            aria-label={`Añadir a ${label}`}
            value={draft}
            placeholder={placeholder}
            maxLength={100}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              }
            }}
            containerClassName="flex-1"
          />
          <Button type="button" variant="outline" icon={<Plus className="h-4 w-4" />} onClick={add}>Añadir</Button>
        </div>
      )}
      <p className="mt-1 text-xs text-muted">{values.length} de {max}</p>
    </div>
  );
}

type DayMode = 'unset' | 'closed' | 'open';
const modeOf = (hours: WeeklyHours, key: keyof WeeklyHours): DayMode => (!hours[key] ? 'unset' : 'closed' in hours[key]! ? 'closed' : 'open');

/** Horario semanal: por día, «no informado», «cerrado» o de 1 a 3 tramos (horario dividido). */
export function WeeklyHoursEditor({ value, onChange }: { value: WeeklyHours; onChange: (value: WeeklyHours) => void }) {
  const setDay = (key: keyof WeeklyHours, day: WeeklyHours[keyof WeeklyHours] | undefined) => {
    const next = { ...value };
    if (day === undefined) delete next[key];
    else next[key] = day;
    onChange(next);
  };
  const ranges = (key: keyof WeeklyHours): TimeRange[] => {
    const day = value[key];
    return day && 'ranges' in day ? day.ranges : [];
  };
  return (
    <div className="space-y-2">
      {WEEK_DAYS.map((day) => {
        const mode = modeOf(value, day.key);
        return (
          <div key={day.key} className="grid gap-2 rounded-control bg-slate-50 p-2 sm:grid-cols-[110px_150px_1fr] sm:items-center">
            <span className="text-sm font-medium text-ink">{day.label}</span>
            <Select
              aria-label={`Horario del ${day.label}`}
              value={mode}
              onChange={(event) => {
                const next = event.target.value as DayMode;
                setDay(day.key, next === 'unset' ? undefined : next === 'closed' ? { closed: true } : { ranges: [{ open: '08:00', close: '18:00' }] });
              }}
              options={[{ value: 'unset', label: 'No informado' }, { value: 'closed', label: 'Cerrado' }, { value: 'open', label: 'Abierto' }]}
            />
            {mode === 'open' && (
              <div className="flex flex-wrap items-center gap-2">
                {ranges(day.key).map((range, index) => (
                  <span key={index} className="inline-flex items-center gap-1 rounded bg-white px-2 py-1 ring-1 ring-border">
                    <input type="time" aria-label={`${day.label} apertura ${index + 1}`} value={range.open} onChange={(event) => setDay(day.key, { ranges: ranges(day.key).map((r, i) => (i === index ? { ...r, open: event.target.value } : r)) })} className="text-sm" />
                    –
                    <input type="time" aria-label={`${day.label} cierre ${index + 1}`} value={range.close} onChange={(event) => setDay(day.key, { ranges: ranges(day.key).map((r, i) => (i === index ? { ...r, close: event.target.value } : r)) })} className="text-sm" />
                    {ranges(day.key).length > 1 && (
                      <button type="button" aria-label="Quitar tramo" onClick={() => setDay(day.key, { ranges: ranges(day.key).filter((_, i) => i !== index) })} className="text-danger-600"><X className="h-3.5 w-3.5" /></button>
                    )}
                  </span>
                ))}
                {ranges(day.key).length < 3 && (
                  <button type="button" onClick={() => setDay(day.key, { ranges: [...ranges(day.key), { open: '15:00', close: '20:00' }] })} className="text-xs font-semibold text-brand-600 hover:underline">+ tramo</button>
                )}
              </div>
            )}
          </div>
        );
      })}
      <p className="text-xs text-muted">«No informado» no muestra nada al público: no se inventa ningún horario.</p>
    </div>
  );
}

/** Horarios especiales por fecha (feriados, fechas excepcionales). */
export function SpecialHoursEditor({ value, onChange }: { value: SpecialHours[]; onChange: (value: SpecialHours[]) => void }) {
  const update = (index: number, patch: Partial<SpecialHours>) => onChange(value.map((day, i) => (i === index ? { ...day, ...patch } : day)));
  return (
    <div className="space-y-2">
      {value.map((day, index) => (
        <div key={index} className="grid gap-2 rounded-control bg-slate-50 p-2 sm:grid-cols-[150px_130px_1fr_auto] sm:items-center">
          <input type="date" aria-label="Fecha" value={day.date} onChange={(event) => update(index, { date: event.target.value })} className="rounded border border-border px-2 py-1.5 text-sm" />
          <Select
            aria-label="Tipo de horario especial"
            value={day.closed ? 'closed' : 'open'}
            onChange={(event) => update(index, event.target.value === 'closed' ? { closed: true, ranges: undefined } : { closed: undefined, ranges: [{ open: '08:00', close: '13:00' }] })}
            options={[{ value: 'closed', label: 'Cerrado' }, { value: 'open', label: 'Horario especial' }]}
          />
          <div className="flex flex-wrap items-center gap-2">
            {!day.closed && day.ranges?.[0] && (
              <span className="inline-flex items-center gap-1 text-sm">
                <input type="time" aria-label="Apertura" value={day.ranges[0].open} onChange={(event) => update(index, { ranges: [{ ...day.ranges![0]!, open: event.target.value }] })} />
                –
                <input type="time" aria-label="Cierre" value={day.ranges[0].close} onChange={(event) => update(index, { ranges: [{ ...day.ranges![0]!, close: event.target.value }] })} />
              </span>
            )}
            <input aria-label="Nota" placeholder="Nota (opcional)" maxLength={120} value={day.note ?? ''} onChange={(event) => update(index, { note: event.target.value })} className="min-w-0 flex-1 rounded border border-border px-2 py-1.5 text-sm" />
          </div>
          <button type="button" aria-label="Quitar fecha" onClick={() => onChange(value.filter((_, i) => i !== index))} className="justify-self-end rounded p-1.5 text-danger-600 hover:bg-white"><Trash2 className="h-4 w-4" /></button>
        </div>
      ))}
      {value.length < 30 && (
        <Button type="button" size="sm" variant="outline" icon={<Plus className="h-4 w-4" />} onClick={() => onChange([...value, { date: new Date().toISOString().slice(0, 10), closed: true }])}>
          Añadir fecha especial
        </Button>
      )}
    </div>
  );
}

/** Botones de orden (subir/bajar) para listas del panel. */
export function OrderButtons({ index, total, onMove, disabled }: { index: number; total: number; onMove: (from: number, to: number) => void; disabled?: boolean }) {
  return (
    <span className="inline-flex flex-col">
      <button type="button" aria-label="Subir" disabled={disabled || index === 0} onClick={() => onMove(index, index - 1)} className="rounded p-0.5 text-slate-500 hover:bg-slate-100 disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" /></button>
      <button type="button" aria-label="Bajar" disabled={disabled || index === total - 1} onClick={() => onMove(index, index + 1)} className="rounded p-0.5 text-slate-500 hover:bg-slate-100 disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" /></button>
    </span>
  );
}
