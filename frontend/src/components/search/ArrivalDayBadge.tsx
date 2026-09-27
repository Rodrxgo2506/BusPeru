import { arrivalDayNote, arrivalDayOffset } from '@/utils/trip-results';

/**
 * «+1» junto a la hora de llegada cuando el viaje llega otro día. Sale de las fechas reales del viaje
 * (`departure_datetime` / `arrival_datetime`); sin llegada o si llega el mismo día no pinta nada.
 * Lo usan la tarjeta de resultados y el resumen de la selección de asientos, para que digan lo mismo.
 */
export function ArrivalDayBadge({ departure, arrival }: { departure: string; arrival: string | null | undefined }) {
  const offset = arrivalDayOffset(departure, arrival);
  const note = arrivalDayNote(offset);
  if (!note) return null;
  return (
    <sup className="ml-0.5 text-xs font-bold text-brand-600" title={note}>
      <span aria-hidden>+{offset}</span>
      <span className="sr-only"> ({note.toLowerCase()})</span>
    </sup>
  );
}
