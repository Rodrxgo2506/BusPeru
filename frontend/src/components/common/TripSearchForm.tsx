import { ArrowRightLeft, BusFront, CalendarDays, Plus, Route as RouteIcon, Search, Trash2 } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { LocationDropdown } from '@/components/common/LocationDropdown';
import { PassengerSelector } from '@/components/common/PassengerSelector';
import { Button } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { publicService } from '@/services';
import type { TripType } from '@/pages/public/checkout/CheckoutContext';
import { todayIso } from '@/utils/format';
import { DEFAULT_PASSENGERS, totalPassengers, type PassengerCounts } from '@/utils/passengers';
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

/** Máximo de pasajeros si la plataforma no publica `booking.max_seats_per_booking`: el de siempre. */
const FALLBACK_MAX_PASSENGERS = 6;

function DateField({
  label,
  value,
  min,
  onChange,
  appearance = 'field',
  tone = 'light',
}: {
  label: string;
  value: string;
  min: string;
  onChange: (value: string) => void;
  appearance?: 'field' | 'bar';
  tone?: 'light' | 'onBrand';
}) {
  const bar = appearance === 'bar';
  const onBrand = tone === 'onBrand';
  return (
    <label
      className={cn(
        'block',
        bar ? 'rounded-lg px-3 py-1.5' : 'rounded-control border border-border p-3 focus-within:border-brand-500',
      )}
    >
      <span className={cn('block text-xs font-medium', bar ? 'mb-0.5' : 'mb-1', onBrand ? 'text-white/85' : 'text-muted')}>{label}</span>
      <span className="flex items-center gap-2">
        {!bar && <CalendarDays className="h-4 w-4 shrink-0 text-brand-500" aria-hidden />}
        <input
          type="date"
          value={value}
          min={min}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            'w-full border-0 bg-transparent p-0 text-sm font-medium focus:outline-none focus:ring-0',
            onBrand ? 'text-white [color-scheme:dark]' : 'text-ink',
          )}
          aria-label={label}
        />
      </span>
    </label>
  );
}

export function TripSearchForm({
  cities,
  initialDestination = '',
  initialOrigin = '',
  variant = 'card',
  tone = 'light',
}: {
  cities: string[];
  initialDestination?: string;
  /** FASE 17B · la ficha de destino precarga origen y destino desde el CMS. */
  initialOrigin?: string;
  /** `card`: tarjeta con pestañas (portada). `bar`: una sola fila compacta (ficha de destino). */
  variant?: 'card' | 'bar';
  tone?: 'light' | 'onBrand';
}) {
  const navigate = useNavigate();

  const [tab, setTab] = useState<TripType>('ONE_WAY');
  const [passengerCounts, setPassengerCounts] = useState<PassengerCounts>(DEFAULT_PASSENGERS);
  const [error, setError] = useState<string | null>(null);

  // FASE 17: el tope del selector es el límite de asientos por reserva que publica la plataforma.
  const settings = useAsync(() => publicService.settings(), []);
  const configuredMax = Number(settings.data?.['booking.max_seats_per_booking']);
  const maxPassengers = Number.isInteger(configuredMax) && configuredMax > 0 ? configuredMax : FALLBACK_MAX_PASSENGERS;
  // El buscador envía el TOTAL, como antes: la búsqueda no aplica reglas por tipo de pasajero.
  const passengers = String(totalPassengers(passengerCounts));

  // Ida e ida y vuelta comparten origen/destino; la vuelta añade su fecha.
  const [origin, setOrigin] = useState(initialOrigin);
  const [destination, setDestination] = useState(initialDestination);
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
  function validate(tab: TripType): SegmentDraft[] | null {
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

  // En la barra compacta no hay pestañas: con fecha de vuelta el viaje es de ida y vuelta.
  const effectiveTab: TripType = variant === 'bar' ? (returnDate ? 'ROUND_TRIP' : 'ONE_WAY') : tab;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const drafts = validate(effectiveTab);
    if (!drafts) return;

    // IDA: misma URL de siempre, para no cambiar nada de ese flujo.
    if (effectiveTab === 'ONE_WAY') {
      const params = new URLSearchParams({ date, passengers });
      if (origin) params.set('origin', origin);
      if (destination) params.set('destination', destination);
      navigate(`/buscar?${params.toString()}`);
      return;
    }

    const params = new URLSearchParams({ type: effectiveTab, passengers, segments: encodeSegments(drafts) });
    navigate(`/buscar?${params.toString()}`);
  };

  const onBrand = tone === 'onBrand';

  /**
   * FASE 17B · barra compacta de la ficha de destino: una sola fila en escritorio, con los mismos
   * controles, la misma validación y la misma navegación que la tarjeta. No hay segunda lógica.
   */
  if (variant === 'bar') {
    const divider = <span aria-hidden className={cn('hidden h-8 w-px lg:block', onBrand ? 'bg-white/30' : 'bg-border')} />;
    return (
      <form onSubmit={handleSubmit} noValidate className="w-full">
        <div className="grid gap-1 sm:grid-cols-2 lg:flex lg:items-center lg:gap-0">
          <span className={cn('hidden shrink-0 px-3 text-sm font-bold lg:block', onBrand ? 'text-white' : 'text-ink')}>Compra tu pasaje:</span>
          {divider}
          <LocationDropdown
            label="Origen:"
            value={origin}
            onChange={setOrigin}
            options={cities}
            placeholder="Elegir"
            appearance="bar"
            tone={tone}
            className="lg:w-[150px]"
          />
          {divider}
          <LocationDropdown
            label="Destino:"
            value={destination}
            onChange={setDestination}
            options={cities}
            placeholder="Elegir"
            appearance="bar"
            tone={tone}
            className="lg:w-[150px]"
          />
          {divider}
          <DateField label="Fecha salida:" value={date} min={todayIso()} onChange={setDate} appearance="bar" tone={tone} />
          {divider}
          <DateField label="Fecha retorno:" value={returnDate} min={date || todayIso()} onChange={setReturnDate} appearance="bar" tone={tone} />
          {divider}
          <PassengerSelector
            value={passengerCounts}
            onChange={setPassengerCounts}
            maxTotal={maxPassengers}
            label="N° pasajeros:"
            appearance="bar"
            tone={tone}
            className="lg:w-[150px]"
          />
          <button
            type="submit"
            className={cn(
              'mt-2 shrink-0 rounded-full px-8 py-2.5 text-sm font-bold uppercase tracking-wide transition sm:col-span-2 lg:mt-0 lg:ml-3 lg:w-auto',
              onBrand ? 'bg-white text-brand-600 hover:bg-brand-50' : 'bg-brand-500 text-white hover:bg-brand-600',
            )}
          >
            Buscar
          </button>
        </div>
        {error && (
          <p role="alert" className={cn('mt-2 px-3 text-sm font-medium', onBrand ? 'text-white' : 'text-danger-600')}>
            {error}
          </p>
        )}
      </form>
    );
  }

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
                  <LocationDropdown
                    label="Origen"
                    value={segment.origin}
                    onChange={(value) => updateSegment(index, { origin: value })}
                    options={cities}
                    placeholder="¿Desde dónde?"
                  />
                  <LocationDropdown
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
              <LocationDropdown label="Origen" value={origin} onChange={setOrigin} options={cities} placeholder="¿Desde dónde viajas?" />
              <button
                type="button"
                onClick={swap}
                className="absolute -right-3 top-1/2 z-10 hidden -translate-y-1/2 rounded-full border border-border bg-white p-1.5 text-brand-500 shadow-sm transition hover:bg-brand-50 lg:block"
                aria-label="Intercambiar origen y destino"
              >
                <ArrowRightLeft className="h-3.5 w-3.5" />
              </button>
            </div>

            <LocationDropdown label="Destino" value={destination} onChange={setDestination} options={cities} placeholder="¿A dónde vas?" />

            <DateField label="Fecha de ida" value={date} min={todayIso()} onChange={setDate} />

            {tab === 'ROUND_TRIP' && (
              <DateField label="Fecha de vuelta" value={returnDate} min={date || todayIso()} onChange={setReturnDate} />
            )}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-[220px_1fr]">
          <PassengerSelector value={passengerCounts} onChange={setPassengerCounts} maxTotal={maxPassengers} />

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
