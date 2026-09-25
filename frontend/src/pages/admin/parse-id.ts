/** Id de ruta a número. Un valor no válido se convierte en 0, que la API responde como 404. */
export function parseId(value: string | undefined): number {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : 0;
}
