import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildIdentityUpdate,
  DOCUMENT_UI,
  documentNumberError,
  editableIdentity,
  formatBirthDate,
  formatIdentityDocument,
  maskBirthDateInput,
  normalizeDocumentNumber,
  parseBirthDateInput,
  todayInPeru,
} from './identity.ts';

// Datos SINTÉTICOS: 12345678, CE123456, P1234567, 17/05/1999.

describe('identidad · número de documento (solo formato)', () => {
  it('DNI: exactamente 8 dígitos', () => {
    assert.equal(documentNumberError('DNI', '12345678'), null);
    for (const malo of ['1234567', '123456789', '1234ABCD', '1234 5678', '1234-5678']) {
      assert.match(documentNumberError('DNI', malo) ?? '', /8 dígitos/, malo);
    }
    assert.equal(documentNumberError('DNI', ''), 'Ingresa tu número de documento');
  });
  it('CE: 8 a 12 letras o números; minúsculas aceptadas y normalizadas', () => {
    assert.equal(documentNumberError('CE', 'CE123456'), null);
    assert.equal(documentNumberError('CE', 'ce123456'), null);
    assert.equal(normalizeDocumentNumber('CE', ' ce123456 '), 'CE123456');
    for (const malo of ['CE-12345', 'CE 123456', 'CE12345', 'CE12345#']) assert.notEqual(documentNumberError('CE', malo), null, malo);
    assert.equal(documentNumberError('CE', '  '), 'Ingresa tu número de documento');
  });
  it('PASAPORTE: 6 a 12 letras o números', () => {
    assert.equal(documentNumberError('PASAPORTE', 'P1234567'), null);
    for (const malo of ['P12#4567', 'P123', 'P 1234567']) assert.notEqual(documentNumberError('PASAPORTE', malo), null, malo);
    assert.equal(documentNumberError('PASAPORTE', ''), 'Ingresa tu número de documento');
  });
  it('sin tipo elegido pide el tipo', () => {
    assert.equal(documentNumberError('', '12345678'), 'Elige el tipo de documento');
  });
  it('el campo se adapta al tipo: placeholder, teclado y longitud', () => {
    assert.equal(DOCUMENT_UI.DNI.placeholder, 'Ingresa tu DNI');
    assert.equal(DOCUMENT_UI.DNI.inputMode, 'numeric');
    assert.equal(DOCUMENT_UI.DNI.maxLength, 8);
    assert.equal(DOCUMENT_UI.CE.placeholder, 'Ingresa tu carné de extranjería');
    assert.equal(DOCUMENT_UI.PASAPORTE.placeholder, 'Ingresa tu pasaporte');
  });
  it('se muestra como «TIPO — número»; sin datos, nada', () => {
    assert.equal(formatIdentityDocument('DNI', '12345678'), 'DNI — 12345678');
    assert.equal(formatIdentityDocument('PASAPORTE', 'P1234567'), 'PASAPORTE — P1234567');
    assert.equal(formatIdentityDocument(null, null), null);
  });
});

describe('identidad · fecha de nacimiento DD/MM/AAAA', () => {
  const HOY = '2026-09-27';
  it('máscara: solo dígitos y barras en su sitio', () => {
    assert.equal(maskBirthDateInput('17051999'), '17/05/1999');
    assert.equal(maskBirthDateInput('17/05/1999'), '17/05/1999');
    assert.equal(maskBirthDateInput('1705'), '17/05');
    assert.equal(maskBirthDateInput('17a05b1999999'), '17/05/1999');
  });
  it('válida → AAAA-MM-DD', () => {
    assert.deepEqual(parseBirthDateInput('17/05/1999', HOY), { iso: '1999-05-17' });
    assert.deepEqual(parseBirthDateInput('27/09/2026', HOY), { iso: '2026-09-27' }, 'hoy es válido');
    assert.deepEqual(parseBirthDateInput('29/02/2024', HOY), { iso: '2024-02-29' });
  });
  it('imposible, futura o mal escrita → error', () => {
    assert.deepEqual(parseBirthDateInput('30/02/1999', HOY), { error: 'Esa fecha no existe' });
    assert.deepEqual(parseBirthDateInput('31/04/1999', HOY), { error: 'Esa fecha no existe' });
    assert.deepEqual(parseBirthDateInput('28/09/2026', HOY), { error: 'La fecha de nacimiento no puede ser posterior a hoy' });
    for (const mala of ['1999-05-17', '17-05-1999', '17/5/1999', 'mañana', '']) {
      assert.deepEqual(parseBirthDateInput(mala, HOY), { error: 'Escribe la fecha como DD/MM/AAAA' }, mala);
    }
  });
  it('se muestra DD/MM/AAAA; sin dato, nada', () => {
    assert.equal(formatBirthDate('1999-05-17'), '17/05/1999');
    assert.equal(formatBirthDate(null), null);
  });
  it('«hoy» se calcula en hora de Perú', () => {
    assert.equal(todayInPeru(new Date('2026-09-28T03:00:00Z')), '2026-09-27', '22:00 del 27 en Lima');
  });
});

describe('identidad · edición del perfil (completar una vez)', () => {
  const HOY = '2026-09-27';
  const vacio = { document_type: null, document_number: null, birth_date: null };
  const completo = { document_type: 'DNI', document_number: '12345678', birth_date: '1999-05-17' };
  it('sin datos: puede completar documento y fecha', () => {
    assert.deepEqual(editableIdentity(vacio), { document: true, birthDate: true });
    assert.deepEqual(buildIdentityUpdate({ document_type: 'CE', document_number: 'ce123456', birth_date: '17051999' }, vacio, HOY), {
      payload: { document_type: 'CE', document_number: 'CE123456', birth_date: '1999-05-17' }, errors: {},
    });
  });
  it('con datos: los campos quedan bloqueados y nunca se envían', () => {
    assert.deepEqual(editableIdentity(completo), { document: false, birthDate: false });
    assert.deepEqual(buildIdentityUpdate({ document_type: 'DNI', document_number: '87654321', birth_date: '01/01/2000' }, completo, HOY), { payload: {}, errors: {} });
  });
  it('dejar vacío no borra ni envía nada', () => {
    assert.deepEqual(buildIdentityUpdate({ document_type: '', document_number: '', birth_date: '' }, vacio, HOY), { payload: {}, errors: {} });
  });
  it('errores de formato en su campo', () => {
    assert.deepEqual(buildIdentityUpdate({ document_type: 'DNI', document_number: '1234567' }, vacio, HOY).errors, { document_number: 'El DNI debe tener exactamente 8 dígitos, solo números' });
    assert.deepEqual(buildIdentityUpdate({ document_number: '12345678' }, vacio, HOY).errors, { document_type: 'Elige el tipo de documento' });
    assert.deepEqual(buildIdentityUpdate({ birth_date: '30/02/1999' }, vacio, HOY).errors, { birth_date: 'Esa fecha no existe' });
    assert.deepEqual(buildIdentityUpdate({ birth_date: '28/09/2026' }, vacio, HOY).errors, { birth_date: 'La fecha de nacimiento no puede ser posterior a hoy' });
  });
});
