import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  capacityLabel,
  complaintEventLabel,
  directionsUrl,
  formatDayHours,
  groupByCity,
  isValidCoordinate,
  osmEmbedUrl,
  ratingShare,
  safeExternalUrl,
  searchTripsUrl,
  telUrl,
  upcomingSpecialHours,
  whatsappUrl,
} from './company-profile.ts';

describe('F18-19 · perfil público de empresas (utilidades)', () => {
  it('horarios: tramos, cerrado y no informado (nunca inventa un horario)', () => {
    assert.equal(formatDayHours({ ranges: [{ open: '06:00', close: '13:00' }, { open: '14:00', close: '22:00' }] }), '06:00 – 13:00 · 14:00 – 22:00');
    assert.equal(formatDayHours({ closed: true }), 'Cerrado');
    assert.equal(formatDayHours(undefined), 'No informado');
  });

  it('fechas especiales: solo de hoy en adelante y ordenadas', () => {
    const list = upcomingSpecialHours([
      { date: '2026-12-25', closed: true },
      { date: '2026-01-01', closed: true },
      { date: '2026-10-08', ranges: [{ open: '08:00', close: '12:00' }] },
    ], '2026-09-25');
    assert.deepEqual(list.map((d) => d.date), ['2026-10-08', '2026-12-25']);
  });

  it('agrupa agencias por ciudad: más agencias primero, luego alfabético', () => {
    const groups = groupByCity([{ city: 'Pucallpa' }, { city: 'Lima' }, { city: 'Huánuco' }, { city: 'Lima' }]);
    assert.deepEqual(groups.map((g) => [g.city, g.items.length]), [['Lima', 2], ['Huánuco', 1], ['Pucallpa', 1]]);
  });

  it('coordenadas: solo dentro del Perú (detecta latitud y longitud cruzadas)', () => {
    assert.equal(isValidCoordinate(-12.0464, -77.0428), true);
    assert.equal(isValidCoordinate(-77.0428, -12.0464), false);
    assert.equal(isValidCoordinate(40.4, -3.7), false);
    assert.equal(isValidCoordinate(null, -77), false);
  });

  it('mapa y «cómo llegar» se construyen con las coordenadas, no con la dirección', () => {
    const embed = osmEmbedUrl(-12.0464, -77.0428);
    assert.ok(embed.startsWith('https://www.openstreetmap.org/export/embed.html?bbox='));
    assert.ok(embed.includes('marker=-12.046400,-77.042800'));
    assert.equal(directionsUrl(-12.0464, -77.0428), 'https://www.google.com/maps/dir/?api=1&destination=-12.046400,-77.042800');
  });

  it('WhatsApp y teléfono', () => {
    assert.equal(whatsappUrl('999 111 222'), 'https://wa.me/51999111222');
    assert.equal(whatsappUrl('+51 999 111 222'), 'https://wa.me/51999111222');
    assert.equal(whatsappUrl('12'), null);
    assert.equal(telUrl('01 555 1234'), 'tel:015551234');
  });

  it('enlaces externos: solo https', () => {
    assert.equal(safeExternalUrl('https://empresa.pe/'), 'https://empresa.pe/');
    assert.equal(safeExternalUrl('http://empresa.pe'), null);
    assert.equal(safeExternalUrl('javascript:alert(1)'), null);
    assert.equal(safeExternalUrl(null), null);
  });

  it('«Ver viajes» lleva al buscador existente filtrado', () => {
    assert.equal(searchTripsUrl({ origin: 'Lima', destination: 'Huánuco', companyId: 7, date: '2026-09-25' }),
      '/buscar?origin=Lima&destination=Hu%C3%A1nuco&date=2026-09-25&company_id=7');
  });

  it('distribución de opiniones y capacidad', () => {
    assert.equal(ratingShare({ 5: 3, 4: 1 }, 5, 4), 75);
    assert.equal(ratingShare({}, 5, 0), 0);
    assert.equal(capacityLabel(40, 40), '40 asientos');
    assert.equal(capacityLabel(40, 52), '40–52 asientos');
  });

  it('historial del Libro de Reclamaciones en castellano', () => {
    assert.equal(complaintEventLabel('STATUS_CHANGED', 'CLOSED'), 'Cambio de estado → Cerrada');
    assert.equal(complaintEventLabel('COMPANY_NOTE', null), 'Descargo de la empresa');
    assert.equal(complaintEventLabel('OTRO', 'X'), 'OTRO → X');
  });
});
