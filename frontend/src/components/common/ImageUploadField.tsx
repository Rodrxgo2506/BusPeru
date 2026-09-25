import { ImageOff, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { cn } from '@/utils/cn';

/**
 * Campo de imagen del panel (FASE 17): vista previa, elegir archivo y quitar.
 *
 * Solo ayuda a elegir: el servidor vuelve a comprobar formato, MIME, bytes mágicos y tamaño.
 * `accept` y `maxBytes` evitan un viaje inútil cuando el archivo ya se ve que no vale.
 */
export function ImageUploadField({
  label,
  hint,
  currentUrl,
  accept = 'image/jpeg,image/png,image/webp',
  maxBytes = 5 * 1024 * 1024,
  busy = false,
  onSelect,
  onRemove,
  previewClassName,
  layout = 'inline',
}: {
  label: string;
  hint?: string;
  currentUrl: string | null;
  accept?: string;
  maxBytes?: number;
  busy?: boolean;
  onSelect: (file: File) => void;
  onRemove?: () => void;
  previewClassName?: string;
  /**
   * `inline` (por defecto): vista previa y botones en la misma fila, para tarjetas estrechas.
   * `stacked` (F17C-UI-01): vista previa a todo el ancho y botones debajo, dentro de la tarjeta.
   */
  layout?: 'inline' | 'stacked';
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);

  useEffect(() => setBroken(false), [currentUrl]);

  const choose = (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (file.size > maxBytes) {
      setError(`La imagen supera el máximo de ${maxBytes >= 1024 * 1024 ? `${Math.round(maxBytes / 1024 / 1024)} MB` : `${Math.round(maxBytes / 1024)} KB`}.`);
      return;
    }
    onSelect(file);
  };

  const stacked = layout === 'stacked';
  const message = error ? (
    <p className="text-xs font-medium text-danger-600">{error}</p>
  ) : hint ? (
    <p className="text-xs text-muted">{hint}</p>
  ) : null;

  return (
    <div>
      <p className="field-label">{label}</p>
      <div className={cn('flex gap-3', stacked ? 'flex-col items-start' : 'flex-col sm:flex-row sm:items-center')}>
        <div
          className={cn(
            'flex h-28 items-center justify-center overflow-hidden rounded-control border border-dashed border-border bg-slate-50',
            // En fila la vista previa no puede encoger; apilada ocupa el ancho de la tarjeta.
            stacked ? 'w-full' : 'w-full shrink-0 sm:w-44',
            previewClassName,
          )}
        >
          {currentUrl && !broken ? (
            <img src={currentUrl} alt={label} onError={() => setBroken(true)} className="h-full w-full object-contain" />
          ) : (
            <ImageOff className="h-7 w-7 text-slate-300" aria-hidden />
          )}
        </div>
        {stacked && message}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" icon={<Upload className="h-4 w-4" />} loading={busy} onClick={() => inputRef.current?.click()}>
            {currentUrl ? 'Reemplazar' : 'Subir imagen'}
          </Button>
          {currentUrl && onRemove && (
            <Button type="button" variant="ghost" size="sm" icon={<Trash2 className="h-4 w-4" />} disabled={busy} onClick={onRemove}>
              Quitar
            </Button>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(event) => {
            choose(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      </div>
      {!stacked && message && <div className="mt-1.5">{message}</div>}
    </div>
  );
}
