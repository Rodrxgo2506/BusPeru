/**
 * Imágenes de la web pública, centralizadas.
 *
 * ALOJADAS EN BUSPERÚ. Son fotografías de Wikimedia Commons (licencias Creative Commons), descargadas
 * una vez, redimensionadas y convertidas a WebP en varios anchos (`src/assets/photos`). Vite les pone
 * un nombre con hash y se sirven desde nuestro CloudFront con caché inmutable: sin terceros, sin las
 * dos redirecciones de `Special:FilePath` y sin el límite de peticiones (429) de Wikimedia, que antes
 * retrasaban 1–2 s la imagen principal. Cada `Photo` trae `srcSet` para que el navegador baje solo el
 * ancho que va a pintar, y `width`/`height` para reservar su hueco.
 *
 * LICENCIAS: todas exigen atribución y las CC BY-SA, compartir la adaptación con la misma licencia.
 * Los créditos (`PHOTO_CREDITS`) se publican en «Información útil → Créditos de las fotografías».
 * Cambiar una foto es cambiar sus variantes aquí y su crédito; ningún componente construye URLs.
 */
import abra640 from '@/assets/photos/abra-malaga-640.webp';
import abra1024 from '@/assets/photos/abra-malaga-1024.webp';
import abra1600 from '@/assets/photos/abra-malaga-1600.webp';
import huayhuash640 from '@/assets/photos/cordillera-huayhuash-640.webp';
import huayhuash1024 from '@/assets/photos/cordillera-huayhuash-1024.webp';
import huayhuash1600 from '@/assets/photos/cordillera-huayhuash-1600.webp';
import huanuco480 from '@/assets/photos/huanuco-pampa-480.webp';
import huanuco800 from '@/assets/photos/huanuco-pampa-800.webp';
import huascaran640 from '@/assets/photos/huascaran-640.webp';
import huascaran960 from '@/assets/photos/huascaran-960.webp';
import huascaran1280 from '@/assets/photos/huascaran-1280.webp';
import huascaran1920 from '@/assets/photos/huascaran-1920.webp';
import paron640 from '@/assets/photos/laguna-paron-640.webp';
import paron1024 from '@/assets/photos/laguna-paron-1024.webp';
import paron1600 from '@/assets/photos/laguna-paron-1600.webp';
import lima480 from '@/assets/photos/lima-costa-480.webp';
import lima800 from '@/assets/photos/lima-costa-800.webp';
import nevada640 from '@/assets/photos/nevada-carretera-central-640.webp';
import nevada1024 from '@/assets/photos/nevada-carretera-central-1024.webp';
import nevada1600 from '@/assets/photos/nevada-carretera-central-1600.webp';
import tingo480 from '@/assets/photos/tingo-maria-480.webp';
import tingo800 from '@/assets/photos/tingo-maria-800.webp';
import wilcacocha640 from '@/assets/photos/wilcacocha-640.webp';
import wilcacocha960 from '@/assets/photos/wilcacocha-960.webp';
import wilcacocha1600 from '@/assets/photos/wilcacocha-1600.webp';

export interface Photo {
  /** Variante por defecto (la mediana): la usan los navegadores que ignoran `srcSet`. */
  src: string;
  srcSet: string;
  /** Proporción real de la foto, para reservar su hueco (`width`/`height`). */
  width: number;
  height: number;
}

/** Arma una `Photo` a partir de sus variantes `[url, ancho]` y el alto de la mayor. */
function photo(variants: Array<[string, number]>, width: number, height: number, defaultIndex = 1): Photo {
  return {
    src: variants[Math.min(defaultIndex, variants.length - 1)]![0],
    srcSet: variants.map(([url, w]) => `${url} ${w}w`).join(', '),
    width,
    height,
  };
}

const HUASCARAN = photo([[huascaran640, 640], [huascaran960, 960], [huascaran1280, 1280], [huascaran1920, 1920]], 1920, 1280);
const WILCACOCHA = photo([[wilcacocha640, 640], [wilcacocha960, 960], [wilcacocha1600, 1600]], 1600, 1067);

export const heroImages = {
  /**
   * Huascarán, en la Cordillera Blanca: la montaña más alta del Perú.
   *
   * Se prefirió a una foto de buses en carretera por composición: aquí el cielo ocupa toda la
   * mitad izquierda —donde va el titular— y la cumbre queda a la derecha, así que la imagen
   * se lee entera sin pelearse con el texto.
   */
  main: HUASCARAN,
};

/**
 * Fondo de las pantallas de autenticación (login, registro, recuperación): la laguna Wilcacocha,
 * con la Cordillera Blanca al fondo. Va muy velada, detrás del formulario.
 */
export const authImages = {
  background: WILCACOCHA,
};

/** Cabecera de la página de destinos: nevada en la Carretera Central. Decorativa. */
export const destinationsHeroImage = photo([[nevada640, 640], [nevada1024, 1024], [nevada1600, 1600]], 1600, 1067);

/** Cabecera de la página de empresas: la laguna Parón, en la Cordillera Blanca. Decorativa. */
export const companiesHeroImage = photo([[paron640, 640], [paron1024, 1024], [paron1600, 1600]], 1600, 900);

/** Cabecera de la página de ofertas: la Cordillera Huayhuash. Decorativa. */
export const offersHeroImage = photo([[huayhuash640, 640], [huayhuash1024, 1024], [huayhuash1600, 1600]], 1600, 901);

/** Cabecera del centro de ayuda: la carretera al Abra Málaga, en los Andes. Decorativa. */
export const helpHeroImage = photo([[abra640, 640], [abra1024, 1024], [abra1600, 1600]], 1600, 1020);

/**
 * Fotografía por destino. Las claves son el nombre de ciudad ya normalizado (minúsculas y
 * sin tildes), porque es lo que llega de la API. Variantes para tarjetas (≈ 300–450 px de ancho).
 */
export const destinationImages: Record<string, Photo> = {
  // Laguna Wilcacocha, con la Cordillera Blanca al fondo.
  huaraz: photo([[wilcacocha640, 640], [wilcacocha960, 960]], 1600, 1067, 0),
  // Huánuco Pampa, el sitio arqueológico inca más conocido del departamento.
  huanuco: photo([[huanuco480, 480], [huanuco800, 800]], 800, 450, 0),
  // Tingo María con la montaña de la Bella Durmiente detrás.
  'tingo maria': photo([[tingo480, 480], [tingo800, 800]], 800, 450, 0),
  // Costa Verde: el litoral de Lima.
  lima: photo([[lima480, 480], [lima800, 800]], 800, 536, 0),
};

/** Para cualquier ciudad sin fotografía propia: el Huascarán, en la Cordillera Blanca. */
export const fallbackDestinationImage = photo([[huascaran640, 640], [huascaran960, 960]], 1920, 1280, 0);

/** `sizes` de las tarjetas de destino: 1 columna en móvil, 2 en tableta, 4 en escritorio. */
export const DESTINATION_CARD_SIZES = '(min-width: 1024px) 25vw, (min-width: 640px) 50vw, 100vw';

/** Quita tildes y mayúsculas para que «Huánuco» y «huanuco» encuentren la misma foto. */
export function normalizeCity(city: string): string {
  return city
    .normalize('NFD')
    // Rango de diacríticos combinantes: separa la tilde de la letra y la descarta.
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

export function destinationImage(city: string): Photo {
  return destinationImages[normalizeCity(city)] ?? fallbackDestinationImage;
}

/** Imagen que llega de la API (una sola URL, sin variantes) con la misma forma que una `Photo`. */
export function remotePhoto(url: string, width = 1600, height = 1067): Photo {
  return { src: url, srcSet: '', width, height };
}

export interface PhotoCredit {
  title: string;
  usedIn: string;
  author: string;
  license: string;
  licenseUrl: string;
  source: string;
}

/**
 * Créditos exigidos por las licencias Creative Commons. Las fotos se usan redimensionadas y
 * convertidas a WebP; las CC BY-SA se comparten bajo la misma licencia.
 */
export const PHOTO_CREDITS: PhotoCredit[] = [
  { title: 'Huascarán Norte, desde el Km 42, ruta a Portachuelo', usedIn: 'Portada y destinos sin foto propia', author: 'Carlo Brescia', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0', source: 'https://commons.wikimedia.org/wiki/File:Huascar%C3%A1n_Norte,_desde_el_Km_42,_ruta_a_Portachuelo.jpg' },
  { title: 'Laguna Wilcacocha 01', usedIn: 'Acceso y registro; destino Huaraz', author: 'Diego Baravelli', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0', source: 'https://commons.wikimedia.org/wiki/File:Laguna_Wilcacocha_01.jpg' },
  { title: 'Nevada carretera central', usedIn: 'Destinos', author: 'Jonathan J. Chancasana Villacorta', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0', source: 'https://commons.wikimedia.org/wiki/File:Nevada_carretera_central.jpg' },
  { title: 'Laguna Parón 2026 24', usedIn: 'Empresas', author: 'Txolo', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0', source: 'https://commons.wikimedia.org/wiki/File:Laguna_Par%C3%B3n_2026_24.jpg' },
  { title: 'Cordillera Huayhuash 03993', usedIn: 'Ofertas', author: 'Waterloo1883', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0', source: 'https://commons.wikimedia.org/wiki/File:Cordillera_Huayhuash_03993.jpg' },
  { title: 'Road to Abra Malaga', usedIn: 'Centro de ayuda e Información útil', author: 'Ron Knight from Seaford, East Sussex, United Kingdom', license: 'CC BY 2.0', licenseUrl: 'https://creativecommons.org/licenses/by/2.0', source: 'https://commons.wikimedia.org/wiki/File:Road_to_Abra_Malaga_(8605267341).jpg' },
  { title: '2017.08 Huanuco Pampa', usedIn: 'Destino Huánuco', author: 'Yo franco', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0', source: 'https://commons.wikimedia.org/wiki/File:2017.08_Huanuco_Pampa.jpg' },
  { title: 'Tingo María, Rupa Rupa', usedIn: 'Destino Tingo María', author: 'Heiner Amado Cadillo', license: 'CC BY-SA 3.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0', source: 'https://commons.wikimedia.org/wiki/File:Tingo_Mar%C3%ADa,_Rupa_Rupa_10221,_Peru_-_panoramio_-_Heiner_Amado_Cadillo.jpg' },
  { title: 'Lima Peru coast', usedIn: 'Destino Lima', author: 'magicmonkey', license: 'CC BY 2.0', licenseUrl: 'https://creativecommons.org/licenses/by/2.0', source: 'https://commons.wikimedia.org/wiki/File:Lima_Peru_coast.jpg' },
];
