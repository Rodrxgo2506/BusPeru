import { ChevronDown, MapPin, Search, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { FloatingPanel } from '@/components/common/FloatingPanel';
import { useClickOutside } from '@/hooks/useClickOutside';
import { cn } from '@/utils/cn';
import { filterOptions } from '@/utils/text';

/**
 * Selector de ciudad del buscador (FASE 17): origen y destino usan este MISMO componente.
 *
 * Panel blanco con borde, sombra y esquinas suaves; buscador arriba con filtro en tiempo real (sin
 * distinguir tildes), lista con scroll, selección con ratón o teclado (↑ ↓ Enter Esc) y cierre al
 * hacer clic fuera. Las opciones llegan de quien lo usa —hoy `GET /public/cities`—: no hay listas
 * escritas a mano.
 *
 * FASE 17B · dos presentaciones del disparador con la MISMA logica: `field` (tarjeta del buscador)
 * y `bar` (barra compacta de la ficha de destino, tambien sobre fondo naranja).
 */

export type ControlAppearance = 'field' | 'bar';
export type ControlTone = 'light' | 'onBrand';

export function LocationDropdown({
  label,
  value,
  onChange,
  options,
  placeholder,
  className,
  appearance = 'field',
  tone = 'light',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder: string;
  className?: string;
  appearance?: ControlAppearance;
  tone?: ControlTone;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const filtered = useMemo(() => filterOptions(options, search), [options, search]);

  const close = () => {
    setOpen(false);
    setSearch('');
  };
  useClickOutside([containerRef, panelRef], close, open);

  useEffect(() => {
    if (!open) return;
    setHighlight(Math.max(0, filtered.indexOf(value)));
    // Solo al abrir: mientras se escribe, el resaltado vuelve al primer resultado (efecto de abajo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    setHighlight(0);
  }, [search]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const select = (city: string) => {
    onChange(city);
    close();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((current) => Math.min(filtered.length - 1, current + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((current) => Math.max(0, current - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const city = filtered[highlight];
      if (city) select(city);
    }
  };

  const onBrand = tone === 'onBrand';
  const bar = appearance === 'bar';
  // En la barra la etiqueta ya lleva dos puntos («Origen:»): el nombre accesible no los repite.
  const plainLabel = label.replace(/:\s*$/, '');

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        className={cn(
          'block w-full text-left transition',
          bar
            ? cn('rounded-lg px-3 py-1.5', onBrand ? 'hover:bg-white/10' : 'hover:bg-slate-50', open && (onBrand ? 'bg-white/10' : 'bg-slate-50'))
            : cn('rounded-control border bg-white p-3', open ? 'border-brand-500 ring-2 ring-brand-500/20' : 'border-border hover:border-brand-300'),
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`${plainLabel}: ${value || placeholder}`}
      >
        <span className={cn('block text-xs font-medium', bar ? 'mb-0.5' : 'mb-1', onBrand ? 'text-white/85' : 'text-muted')}>{label}</span>
        <span className="flex items-center gap-2">
          {!bar && <MapPin className="h-4 w-4 shrink-0 text-brand-500" aria-hidden />}
          <span
            className={cn(
              'min-w-0 flex-1 truncate',
              bar ? 'text-sm font-semibold uppercase tracking-wide' : 'text-sm font-medium',
              value ? (onBrand ? 'text-white' : 'text-ink') : onBrand ? 'text-white/70' : 'text-slate-400',
            )}
          >
            {value || placeholder}
          </span>
          {bar && <ChevronDown className={cn('h-4 w-4 shrink-0', onBrand ? 'text-white/80' : 'text-slate-400')} aria-hidden />}
        </span>
      </button>

      {value && !open && !bar && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute right-2 top-2 rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          aria-label={`Quitar ${plainLabel.toLowerCase()}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}

      <FloatingPanel anchorRef={containerRef} panelRef={panelRef} open={open} onKeyDown={onKeyDown}>
          <div className="border-b border-border p-2">
            <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 focus-within:border-brand-500">
              <Search className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
              <input
                ref={searchRef}
                // El panel se monta un render después de abrir (se posiciona primero): el foco va al montar.
                autoFocus
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar ciudad"
                className="w-full border-0 bg-transparent p-0 text-sm text-ink placeholder:text-slate-400 focus:outline-none focus:ring-0"
                aria-label={`Buscar ${plainLabel.toLowerCase()}`}
                aria-controls={listId}
                autoComplete="off"
              />
            </label>
          </div>

          <ul ref={listRef} id={listId} role="listbox" aria-label={plainLabel} className="min-h-0 flex-1 overflow-y-auto py-1 overscroll-contain">
            {filtered.length === 0 ? (
              <li className="px-4 py-3 text-sm text-muted">No encontramos esa ciudad</li>
            ) : (
              filtered.map((city, index) => (
                <li
                  key={city}
                  data-index={index}
                  role="option"
                  aria-selected={city === value}
                  onMouseEnter={() => setHighlight(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => select(city)}
                  className={cn(
                    'cursor-pointer px-4 py-2.5 text-sm font-semibold uppercase tracking-wide transition-colors',
                    index === highlight ? 'bg-brand-50 text-brand-700' : 'text-slate-700',
                    city === value && 'text-brand-600',
                  )}
                >
                  {city}
                </li>
              ))
            )}
          </ul>
      </FloatingPanel>
    </div>
  );
}
