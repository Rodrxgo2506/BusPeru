/**
 * Aritmética monetaria en CÉNTIMOS ENTEROS (auditoría 11E-0, hallazgo H-51).
 *
 * Los importes llegan de la base como texto decimal ("47.50") o como número de JavaScript. Hacer
 * `Number(total * 10 / 100).toFixed(2)` decide dinero con coma flotante: 1.005 no existe en binario
 * y `(1.005).toFixed(2)` da "1.00". Aquí los decimales se leen dígito a dígito, las cuentas se hacen
 * con enteros (BigInt cuando el producto puede pasar de 2^53) y el redondeo es explícito: mitad
 * hacia arriba, sobre importes que nunca son negativos. Solo se vuelve a decimal para persistir.
 */

/**
 * Convierte un importe decimal a céntimos. Lee el texto, no multiplica el número: "10.005" son
 * 1000,5 céntimos y se redondea a 1001. Los números se pasan a texto sin notación científica.
 */
export function toCentsExact(value: string | number): number {
  const texto = typeof value === 'number' ? numberToPlainString(value) : value.trim();
  const coincide = /^(-?)(\d*)(?:\.(\d*))?$/.exec(texto);
  if (!coincide || (coincide[2] === '' && (coincide[3] ?? '') === '')) {
    throw new Error(`Importe no válido: ${String(value)}`);
  }
  const negativo = coincide[1] === '-';
  const enteros = BigInt(coincide[2] || '0');
  const decimales = (coincide[3] ?? '').padEnd(3, '0');
  let centimos = enteros * 100n + BigInt(decimales.slice(0, 2));
  // Mitad hacia arriba (en valor absoluto) mirando el tercer decimal y los que siguen.
  const resto = decimales.slice(2);
  if (Number(resto[0]) > 5 || (resto[0] === '5')) centimos += 1n;
  const resultado = Number(centimos);
  return negativo ? -resultado : resultado;
}

function numberToPlainString(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Importe no válido: ${value}`);
  // 12 decimales bastan para cualquier importe y evitan la notación exponencial de `String(1e-7)`.
  return value.toFixed(12);
}

/** Céntimos a decimal con dos cifras, como texto exacto para persistir ("12.34"). */
export function centsToDecimal(cents: number): string {
  const negativo = cents < 0;
  const absoluto = Math.abs(Math.trunc(cents));
  const texto = `${Math.floor(absoluto / 100)}.${String(absoluto % 100).padStart(2, '0')}`;
  return negativo ? `-${texto}` : texto;
}

/** División entera redondeando la mitad hacia arriba. Numerador y denominador no negativos. */
export function roundHalfUpDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('Denominador no válido');
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/**
 * Porcentaje de un importe: `round(centimos × porcentaje / 100)`. El porcentaje admite decimales
 * ("12.50") y se lleva a centésimas de punto antes de multiplicar, así que no hay coma flotante.
 */
export function percentOfCents(cents: number, percent: string | number): number {
  const centesimas = BigInt(toCentsExact(percent));
  return Number(roundHalfUpDiv(BigInt(cents) * centesimas, 10000n));
}

/**
 * Parte proporcional acumulada: `round(total × parte / todo)`. Es la base de la reversión de la
 * comisión (H-27): con la parte ACUMULADA, la suma de las reversiones sucesivas nunca deriva y
 * llega exactamente al total cuando la parte alcanza el todo.
 */
export function proportionalCents(total: number, part: number, whole: number): number {
  if (whole <= 0) return 0;
  const acotada = Math.min(Math.max(part, 0), whole);
  return Number(roundHalfUpDiv(BigInt(total) * BigInt(acotada), BigInt(whole)));
}
