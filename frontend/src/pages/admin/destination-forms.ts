import type { FormField } from '@/components/common/ResourceForm';

/**
 * Campos de los formularios del CMS de destinos (FASE 17). Reutilizan `ResourceForm`: textarea para
 * los textos largos (texto plano, sin editor HTML) y los mismos límites que valida la API.
 */

const STATUS_OPTIONS = [
  { value: 'ACTIVE', label: 'Publicado' },
  { value: 'INACTIVE', label: 'Oculto' },
];

export interface LocationOption {
  id: number;
  city: string;
  name: string;
}

/**
 * Campos del destino. Las ciudades salen de `locations` (FASE 17B): el destino editorial guarda una
 * referencia real, no un nombre escrito a mano, y con ella el buscador de la ficha llega precargado.
 */
export function destinationFields(locations: LocationOption[]): FormField[] {
  const cityOptions = locations.map((location) => ({ value: location.id, label: `${location.city} — ${location.name}` }));
  return [
    { name: 'name', label: 'Nombre', required: true, placeholder: 'Ej: Cajamarca' },
    { name: 'slug', label: 'Slug (URL)', placeholder: 'Se genera a partir del nombre', hint: 'Minúsculas, números y guiones: /destinos/la-merced' },
    { name: 'subtitle', label: 'Subtítulo', full: true, placeholder: 'Ej: La Capital del Carnaval Peruano' },
    { name: 'description', label: 'Descripción', type: 'textarea', placeholder: 'Texto de presentación del destino' },
    { name: 'price_from', label: 'Precio desde (S/)', type: 'number', step: '0.01', hint: 'Informativo: no cambia el precio real de los viajes.' },
    { name: 'display_order', label: 'Orden', type: 'number', step: '1', hint: 'Posición en «Descubre más destinos».' },
    { name: 'location_id', label: 'Ciudad del destino', type: 'select', options: cityOptions, placeholder: 'Sin ciudad asociada', hint: 'Precarga el destino en el buscador de la ficha.' },
    { name: 'origin_location_id', label: 'Ciudad de origen sugerida', type: 'select', options: cityOptions, placeholder: 'Sin origen sugerido', hint: 'Precarga el origen y titula la insignia de tiempo de viaje.' },
    { name: 'address', label: 'Dirección', full: true, placeholder: 'Terminal o punto de referencia' },
    { name: 'ticket_schedule', label: 'Horario de pasajes', placeholder: 'Ej: Lun. a Dom. 08:00am - 20:00 pm' },
    { name: 'package_schedule', label: 'Horario de encomiendas', placeholder: 'Ej: Lun. a Dom. 08:00am - 20:00 pm' },
    { name: 'travel_duration', label: 'Duración del viaje', placeholder: 'Ej: 18 horas' },
    { name: 'temperature', label: 'Temperatura', placeholder: 'Ej: 5°C - 22°C' },
    { name: 'altitude_masl', label: 'Altitud (msnm)', type: 'number', step: '1', placeholder: 'Ej: 2750' },
    { name: 'time_from_lima', label: 'Tiempo desde el origen', placeholder: 'Ej: 18hr', hint: 'Texto corto: se muestra dentro de la insignia circular.' },
    { name: 'status', label: 'Estado', type: 'select', required: true, options: STATUS_OPTIONS },
  ];
}

export const ATTRACTION_FIELDS: FormField[] = [
  { name: 'name', label: 'Nombre', required: true, full: true, placeholder: 'Ej: Baños del Inca' },
  { name: 'description', label: 'Descripción', type: 'textarea' },
  { name: 'display_order', label: 'Orden', type: 'number', step: '1' },
  { name: 'status', label: 'Estado', type: 'select', required: true, options: STATUS_OPTIONS },
];

export const FESTIVITY_FIELDS: FormField[] = [
  { name: 'name', label: 'Nombre', required: true, full: true, placeholder: 'Ej: Festival de San Sebastián' },
  { name: 'date_label', label: 'Fecha', required: true, placeholder: 'Ej: 20 de enero', hint: 'Texto libre: «Enero», «20 de enero»…' },
  { name: 'display_order', label: 'Orden', type: 'number', step: '1' },
  { name: 'description', label: 'Descripción', type: 'textarea' },
  { name: 'status', label: 'Estado', type: 'select', required: true, options: STATUS_OPTIONS },
];

/**
 * `ResourceForm` envía `null` en los campos vacíos. Para el slug y el orden eso no es «borrar» sino
 * «no indicado»: se omiten para que la API genere el slug o conserve el orden.
 */
export function destinationPayload(values: Record<string, unknown>): Record<string, unknown> {
  const payload = { ...values };
  if (payload.slug === null || payload.slug === '') delete payload.slug;
  if (payload.display_order === null) delete payload.display_order;
  return payload;
}

export const childPayload = (values: Record<string, unknown>): Record<string, unknown> => {
  const payload = { ...values };
  if (payload.display_order === null) delete payload.display_order;
  return payload;
};
