import { ArrowRightLeft, BusFront, CalendarDays, MapPin, Plus, Route as RouteIcon, Search, Trash2, Users } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui';
import type { TripType } from '@/pages/public/checkout/CheckoutContext';
import { todayIso } from '@/utils/format';
import { cn } from '@/utils/cn';

/**
 * Buscador del portal público con las tres modalidades del mockup 1.
 *
 * "Ida" conserva exactamente el comportamiento anterior: navega a `/buscar` con
 * origin/destination/date en la query. Las otras dos modalidades añaden `type` y los
 * tramos codificados, que `SearchResultsPage` interpreta.
 */

const MAX_SEGMENTS = 5;

export interface SegmentDraft {
  origin: string;
  destination: string;
  date: string;
}

const TABS: Array<{ id: TripType; label: string; icon: ReactNode }> = [
  { id: 'ONE_WAY', label: 'Ida', icon: <BusFront className="h-4 w-4" /> },
  { id: 'ROUND_TRIP', label: 'Ida y vuelta', icon: <ArrowRightLeft className="h-4 w-4" /> },
  { id: 'MULTI_CITY', label: 'Multidestino', icon: <RouteIcon className="h-4 w-4" /> },
];

/** Serializa los tramos para la URL: `origen>destino@fecha`, separados por `|`. */
export function encodeSegments(segments: SegmentDraft[]): string {
  return segments.map((s) => `${s.origin}>${s.destination}@${s.date}`).join('|');
}

export function decodeSegments(raw: string | null): SegmentDraft[] {
  if (!raw) return [];
  return raw
    .split('|')
    .map((chunk) => {
      const [route, date] = chunk.split('@');
      const [origin, destination] = (route ?? '').split('>');
      return { origin: origin ?? '', destination: destination ?? '', date: date ?? '' };
    })
    .filter((segment) => segment.origin && segment.destination && segment.date);
}

function SelectCity({
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder: string;
}) {
  return (
    <label className="block rounded-control border border-border p-3 focus-within:border-brand-500">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      <span className="flex items-center gap-2">
        <MapPin className="h-4 w-4 shrink-0 text-brand-500" />
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="w-full cursor-pointer border-0 bg-transparent p-0 text-sm font-medium text-ink focus:outline-none focus:ring-0"
          aria-label={label}
        >
          <option value="">{placeholder}</option>
          {options.map((city) => (
            <option key={city} value={city}>
              {city}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}

function DateField({ label, value, min, onChange }: { label: string; value: string; min: string; onChange: (value: string) => void }) {
  return (
    <label className="block rounded-control border border-border p-3 focus-within:border-brand-500">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      <span className="flex items-center gap-2">
        <CalendarDays className="h-4 w-4 shrink-0 text-brand-500" />
        <input
          type="date"
          value={value}
          min={min}
          onChange={(event) => onChange(event.target.value)}
          className="w-full border-0 p-0 text-sm font-medium text-ink focus:outline-none focus:ring-0"
          aria-label={label}
        />
      </span>
    </label>
  );
}

export function TripSearchForm({ cities }: { cities: string[] }) {
  const navigate = useNavigate();

  const [tab, setTab] = useState<TripType>('ONE_WAY');
  const [passengers, setPassengers] = useState('1');
  const [error, setError] = useState<string | null>(null);

  // Ida e ida y vuelta comparten origen/destino; la vuelta añade su fecha.
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [date, setDate] = useState(todayIso());
  const [returnDate, setReturnDate] = useState('');

  const [segments, setSegments] = useState<SegmentDraft[]>([
    { origin: '', destination: '', date: todayIso() },
    { origin: '', destination: '', date: todayIso() },
  ]);

  const swap = () => {
    setOrigin(destination);
    setDestination(origin);
  };

  const updateSegment = (index: number, patch: Partial<SegmentDraft>) => {
    setSegments((current) => current.map((segment, i) => (i === index ? { ...segment, ...patch } : segment)));
  };

  const addSegment = () => {
    setSegments((current) => {
      if (current.length >= MAX_SEGMENTS) return current;
      const last = current[current.length - 1]!;
      // El nuevo tramo arranca donde acabó el anterior: es lo natural en un multidestino.
      return [...current, { origin: last.destination, destination: '', date: last.date }];
    });
  };

  const removeSegment = (index: number) => {
    setSegments((current) => (current.length <= 2 ? current : current.filter((_, i) => i !== index)));
  };

  /** Las mismas reglas que valida el backend, para avisar antes de ir al servidor. */
  function validate(): SegmentDraft[] | null {
    if (tab === 'ONE_WAY') {
      if (!date) return setError('Elige la fecha de ida'), null;
      return [{ origin, destination, date }];
    }

    const drafts: SegmentDraft[] =
      tab === 'ROUND_TRIP'
        ? [
            { origin, destination, date },
            { origin: destination, destination: origin, date: returnDate },
          ]
        : segments;

    for (const [index, segment] of drafts.entries()) {
      if (!segment.origin || !segment.destination) {
        return setError(`Completa el origen y el destino del tramo ${index + 1}`), null;
      }
      if (segment.origin === segment.destination) {
        return setError(`El tramo ${index + 1} tiene el mismo origen y destino`), null;
      }
      if (!segment.date) return setError(`Elige la fecha del tramo ${index + 1}`), null;
      if (index > 0 && segment.date < drafts[index - 1]!.date) {
        return setError(
          tab === 'ROUND_TRIP'
            ? 'La fecha de vuelta no puede ser anterior a la de ida'
            : `La fecha del tramo ${index + 1} no puede ser anterior a la del tramo ${index}`,
        ), null;
      }
    }

    return drafts;
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const drafts = validate();
    if (!drafts) return;

    // IDA: misma URL de siempre, para no cambiar nada de ese flujo.
    if (tab === 'ONE_WAY') {
      const params = new URLSearchParams({ date, passengers });
      if (origin) params.set('origin', origin);
      if (destination) params.set('destination', destination);
      navigate(`/buscar?${params.toString()}`);
      return;
    }

    const params = new URLSearchParams({ type: tab, passengers, segments: encodeSegments(drafts) });
    navigate(`/buscar?${params.toString()}`);
  };

  return (
    <>
      <div className="mb-4 flex gap-2 overflow-x-auto scrollbar-none" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => {
              setTab(item.id);
              setError(null);
            }}
            className={cn(
              'flex shrink-0 items-center gap-2 rounded-control px-4 py-2 text-sm font-semibold transition',
              tab === item.id ? 'bg-brand-500 text-white' : 'text-slate-500 hover:bg-brand-50 hover:text-brand-600',
            )}
          >
            {item.icon} {item.label}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="space-y-3" noValidate>
        {tab === 'MULTI_CITY' ? (
          <div className="space-y-3">
            {segments.map((segment, index) => (
              <div key={index} className="rounded-control border border-border/70 bg-slate-50/60 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-brand-600">Tramo {index + 1}</span>
                  {segments.length > 2 && (
                    <button
                      type="button"
                      onClick={() => removeSegment(index)}
                      className="rounded-lg p-1.5 text-slate-400 transition hover:bg-danger-50 hover:text-danger-600"
                      aria-label={`Eliminar tramo ${index + 1}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <SelectCity
                    label="Origen"
                    value={segment.origin}
                    onChange={(value) => updateSegment(index, { origin: value })}
                    options={cities}
                    placeholder="¿Desde dónde?"
                  />
                  <SelectCity
                    label="Destino"
                    value={segment.destination}
                    onChange={(value) => updateSegment(index, { destination: value })}
                    options={cities}
                    placeholder="¿A dónde?"
                  />
                  <DateField
                    label="Fecha"
                    value={segment.date}
                    min={index === 0 ? todayIso() : segments[index - 1]!.date}
                    onChange={(value) => updateSegment(index, { date: value })}
                  />
                </div>
              </div>
            ))}

            {segments.length < MAX_SEGMENTS && (
              <button
                type="button"
                onClick={addSegment}
                className="flex w-full items-center justify-center gap-2 rounded-control border border-dashed border-border py-2.5 text-sm font-semibold text-brand-600 transition hover:border-brand-500 hover:bg-brand-50"
              >
                <Plus className="h-4 w-4" /> Agregar tramo
              </button>
            )}
          </div>
        ) : (
          <div className={cn('grid gap-3', tab === 'ROUND_TRIP' ? 'lg:grid-cols-4' : 'lg:grid-cols-3')}>
            <div className="relative">
              <SelectCity label="Origen" value={origin} onChange={setOrigin} options={cities} placeholder="¿Desde dónde viajas?" />
              <button
                type="button"
                onClick={swap}
                className="absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-full border border-border bg-white p-1.5 text-brand-500 shadow-sm transition hover:bg-brand-50 lg:block"
                aria-label="Intercambiar origen y destino"
              >
                <ArrowRightLeft className="h-3.5 w-3.5" />
              </button>
            </div>

            <SelectCity label="Destino" value={destination} onChange={setDestination} options={cities} placeholder="¿A dónde vas?" />

            <DateField label="Fecha de ida" value={date} min={todayIso()} onChange={setDate} />

            {tab === 'ROUND_TRIP' && (
              <DateField label="Fecha de vuelta" value={returnDate} min={date || todayIso()} onChange={setReturnDate} />
            )}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-[220px_1fr]">
          <label className="block rounded-control border border-border p-3 focus-within:border-brand-500">
            <span className="mb-1 block text-xs font-medium text-muted">Pasajeros</span>
            <span className="flex items-center gap-2">
              <Users className="h-4 w-4 shrink-0 text-brand-500" />
              <select
                value={passengers}
                onChange={(event) => setPassengers(event.target.value)}
                className="w-full cursor-pointer border-0 bg-transparent p-0 text-sm font-medium text-ink focus:outline-none focus:ring-0"
                aria-label="Cantidad de pasajeros"
              >
                {[1, 2, 3, 4, 5, 6].map((count) => (
                  <option key={count} value={count}>
                    {count} {count === 1 ? 'pasajero' : 'pasajeros'}
                  </option>
                ))}
              </select>
            </span>
          </label>

          <Button type="submit" size="lg" icon={<Search className="h-4 w-4" />}>
            Buscar pasajes
          </Button>
        </div>

        {error && (
          <p role="alert" className="rounded-control border border-danger-200 bg-danger-50 p-3 text-sm text-danger-600">
            {error}
          </p>
        )}
      </form>
    </>
  );
}
