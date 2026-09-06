/**
 * Imágenes de la web pública, centralizadas.
 *
 * Todas son fotografías reales de Wikimedia Commons, servidas por `Special:FilePath`, que
 * redirige a la versión redimensionada al ancho pedido. Se eligió esa forma —y no la ruta
 * `/thumb/…`— porque es la estable: la ruta directa a la miniatura devuelve 400 si esa
 * medida concreta no está generada.
 *
 * Cambiar una imagen es cambiar un nombre de archivo aquí. Ningún componente construye URLs
 * por su cuenta.
 */

const COMMONS = 'https://commons.wikimedia.org/wiki/Special:FilePath';

/** URL de un archivo de Commons al ancho indicado. */
function commons(file: string, width: number): string {
  return `${COMMONS}/${encodeURIComponent(file)}?width=${width}`;
}

export const heroImages = {
  /**
   * Huascarán, en la Cordillera Blanca: la montaña más alta del Perú.
   *
   * Se prefirió a una foto de buses en carretera por composición: aquí el cielo ocupa toda la
   * mitad izquierda —donde va el titular— y la cumbre queda a la derecha, así que la imagen
   * se lee entera sin pelearse con el texto.
   */
  main: commons('Huascarán Norte, desde el Km 42, ruta a Portachuelo.jpg', 1920),
  mainSmall: commons('Huascarán Norte, desde el Km 42, ruta a Portachuelo.jpg', 960),
};

/**
 * Fondo de las pantallas de autenticación (login, registro, recuperación).
 *
 * Buses interprovinciales en la Carretera Central, a su paso por los Andes: es la imagen
 * que mejor representa el producto. Aquí funciona mejor que en la portada porque va muy
 * velada, detrás del formulario, y no compite con el titular.
 */
export const authImages = {
  background: commons('Laguna Wilcacocha 01.jpg', 1620),
  backgroundSmall: commons('Laguna Wilcacocha 01.jpg', 960),
};

/**
 * Cabecera de la página de destinos. Buses interprovinciales en la Carretera Central: es
 * decorativa y va detrás del texto, muy velada.
 */
export const destinationsHeroImage = commons('Nevada carretera central.jpg', 1600);

/**
 * Cabecera de la página de empresas: la laguna Parón, en la Cordillera Blanca. Decorativa.
 */
export const companiesHeroImage = commons('Laguna Parón 2026 24.jpg', 1600);

/**
 * Cabecera de la página de ofertas: la Cordillera Huayhuash. Decorativa.
 */
export const offersHeroImage = commons('Cordillera Huayhuash 03993.jpg', 1600);

/**
 * Cabecera del centro de ayuda: la carretera al Abra Málaga, en los Andes. Decorativa.
 */
export const helpHeroImage = commons('Road to Abra Malaga (8605267341).jpg', 1600);

/**
 * Fotografía por destino. Las claves son el nombre de ciudad ya normalizado (minúsculas y
 * sin tildes), porque es lo que llega de la API.
 */
export const destinationImages: Record<string, string> = {
  // Laguna Wilcacocha, con la Cordillera Blanca al fondo.
  huaraz: commons('Laguna Wilcacocha 01.jpg', 800),
  // Huánuco Pampa, el sitio arqueológico inca más conocido del departamento.
  huanuco: commons('2017.08 Huanuco Pampa.jpg', 800),
  // Tingo María con la montaña de la Bella Durmiente detrás.
  'tingo maria': commons('Tingo María, Rupa Rupa 10221, Peru - panoramio - Heiner Amado Cadillo.jpg', 800),
  // Costa Verde: el litoral de Lima.
  lima: commons('Lima Peru coast.jpg', 800),
};

/** Para cualquier ciudad sin fotografía propia: el Huascarán, en la Cordillera Blanca. */
export const fallbackDestinationImage = commons('Huascarán Norte, desde el Km 42, ruta a Portachuelo.jpg', 800);

/** Quita tildes y mayúsculas para que «Huánuco» y «huanuco» encuentren la misma foto. */
export function normalizeCity(city: string): string {
  return city
    .normalize('NFD')
    // Rango de diacríticos combinantes: separa la tilde de la letra y la descarta.
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

export function destinationImage(city: string): string {
  return destinationImages[normalizeCity(city)] ?? fallbackDestinationImage;
}
