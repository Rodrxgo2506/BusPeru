/**
 * F18-19 · dimensiones reales de una imagen leídas de su cabecera binaria (PNG, JPEG, WebP).
 *
 * Sin dependencias: el almacén ya comprueba extensión, MIME y bytes mágicos; esto añade el tamaño en
 * píxeles para rechazar imágenes absurdas (1×1 de rastreo, 40 000 px que tumban el navegador).
 * Devuelve null si la cabecera no se puede interpretar: quien llama lo trata como imagen inválida.
 */
export interface ImageSize {
  width: number;
  height: number;
}

function png(buffer: Buffer): ImageSize | null {
  // Firma (8) + longitud (4) + «IHDR» (4) + ancho (4) + alto (4).
  if (buffer.length < 24 || buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpeg(buffer: Buffer): ImageSize | null {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (SOF.has(marker)) return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
  return null;
}

function webp(buffer: Buffer): ImageSize | null {
  if (buffer.length < 30) return null;
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (chunk === 'VP8 ') return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  return null;
}

export function readImageSize(buffer: Buffer, mime: string): ImageSize | null {
  try {
    const size = mime === 'image/png' ? png(buffer) : mime === 'image/jpeg' ? jpeg(buffer) : mime === 'image/webp' ? webp(buffer) : null;
    return size && size.width > 0 && size.height > 0 ? size : null;
  } catch {
    return null;
  }
}
