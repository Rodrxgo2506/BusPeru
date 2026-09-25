/**
 * Fondo panorámico de la pantalla: cordillera, valle, carretera y un bus.
 *
 * Lo comparten «Mi perfil» y «Mis viajes». Vive aquí, y no dentro de una de las dos, porque
 * es justamente lo que da a las dos pantallas la misma identidad: un solo dibujo, una sola
 * paleta y un solo juego de velos. Si mañana cambia, cambia en ambas a la vez.
 *
 * POR QUÉ ESTÁ DIBUJADO Y NO ES UNA FOTOGRAFÍA. El proyecto no tiene NINGUNA imagen: no
 * existen `src/assets` ni `public`, y no hay un solo `.jpg`, `.png` o `.webp` en el árbol
 * (solo iconos de `lucide-react`, que son trazos). Traer una fotografía obligaría a
 * descargar un recurso nuevo, y eso queda descartado. Lo que sí existe en BusPerú es la
 * silueta andina del pie de página (`AndesSilhouette`, en `PublicLayout`), y de ahí sale el
 * lenguaje de esta escena: mismas crestas encadenadas, misma paleta `brand`, misma manera de
 * teñirla a opacidades bajas. Al ser SVG pesa unos pocos kilobytes, escala sin pixelarse y
 * no añade ninguna dependencia ni ninguna petición de red.
 *
 * CÓMO NO ESTORBA AL CONTENIDO. Tres decisiones, en este orden:
 *
 *   1. `fixed inset-0 -z-10` dentro del contexto de apilamiento que `CustomerLayout` crea
 *      con `isolate`. Así el dibujo queda por debajo de TODO lo que hay en la página
 *      —incluida la barra lateral, que es `sticky`— sin necesidad de subir de plano ni una
 *      sola tarjeta. Sin ese `isolate` el `-z-10` se escaparía al contexto raíz y lo taparía
 *      el fondo blanco del armazón público.
 *   2. Tres velos superpuestos. El plano de color deja la escena en un susurro; el degradado
 *      vertical la apaga del todo arriba, donde está el encabezado; y un óvalo blanco en el
 *      centro limpia justo la franja por la que corren los textos. El paisaje respira, pues,
 *      por los costados, que es donde no hay nada que leer.
 *   3. `pointer-events-none` y `aria-hidden`: no se puede pulsar y no se anuncia. Es
 *      decoración, y una decoración que aparece en el lector de pantalla es ruido.
 */
export function TravelBackdrop() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden>
      {/* Cielo: un degradado, no un dibujo. Ocupa lo que sobre por encima del paisaje, así que
          crece o mengua con la ventana sin deformar nada. */}
      <div className="absolute inset-0 bg-gradient-to-b from-white via-[#FFFCF7] to-[#FFF1E0]" />
      <div
        className="absolute inset-0"
        style={{ background: 'radial-gradient(600px 420px at 82% 12%, rgba(253,186,116,0.45) 0%, rgba(253,186,116,0) 70%)' }}
      />

      {/* El paisaje va anclado abajo y a lo ancho, con su proporción intacta: una ventana muy
          alta solo deja ver más cielo, nunca un bus gigante; una muy estrecha lo encoge entero
          en vez de recortarle los costados. Por eso NO se usa `slice`. */}
      <svg
        viewBox="0 0 1440 540"
        preserveAspectRatio="xMidYMax meet"
        className="absolute inset-x-0 bottom-0 h-auto w-full"
      >
        <defs>
          <linearGradient id="bp-valle" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FDE9C8" />
            <stop offset="100%" stopColor="#FFFFFF" />
          </linearGradient>
        </defs>

        {/* Cordillera lejana: la más alta y la más desvaída, para que abra la profundidad. */}
        <path
          d="M0 110 108 40 190 82 302 10 412 78 522 28 640 90 762 36 900 94 1042 24 1180 82 1302 38 1440 92V540H0Z"
          fill="#CBD5E1"
          opacity="0.62"
        />
        {/* Cordillera media, teñida de la naranja de la marca: la que da el aire andino. */}
        <path
          d="M0 162 140 100 250 142 380 78 500 138 620 92 760 150 880 102 1010 154 1140 98 1282 148 1440 110V540H0Z"
          fill="#FDBA74"
          opacity="0.55"
        />
        {/* Lomas cercanas. */}
        <path
          d="M0 238 162 196 320 232 470 188 640 234 800 192 962 238 1120 196 1290 236 1440 200V540H0Z"
          fill="#94A3B8"
          opacity="0.42"
        />

        <rect y="236" width="1440" height="304" fill="url(#bp-valle)" opacity="0.8" />

        {/* Carretera: se estrecha hacia el punto de fuga, que es lo que crea la perspectiva. */}
        <path d="M548 240 574 240 716 540 26 540Z" fill="#94A3B8" opacity="0.42" />
        <path d="M560 246 372 540" stroke="#FFFFFF" strokeWidth="7" strokeDasharray="30 26" opacity="0.9" />

        {/* Postes del arcén: repetir el mismo elemento a tamaños decrecientes marca la
            distancia mejor que cualquier degradado. */}
        <g fill="#94A3B8" opacity="0.38">
          <rect x="726" y="196" width="4" height="34" />
          <rect x="796" y="206" width="5" height="46" />
          <rect x="886" y="218" width="6" height="60" />
          <rect x="1002" y="232" width="7" height="78" />
        </g>

        {/* El bus. Va sobre la carretera y a la izquierda, lejos de la columna de texto. */}
        <g transform="translate(286 330) rotate(-4)" opacity="0.9">
          <rect width="182" height="68" rx="13" fill="#F97316" opacity="0.85" />
          <rect x="11" y="11" width="62" height="27" rx="5" fill="#FFFFFF" opacity="0.8" />
          <rect x="81" y="11" width="42" height="27" rx="5" fill="#FFFFFF" opacity="0.8" />
          <rect x="131" y="11" width="42" height="27" rx="5" fill="#FFFFFF" opacity="0.8" />
          <rect y="47" width="182" height="9" fill="#EA580C" opacity="0.45" />
          <circle cx="40" cy="72" r="12" fill="#0F172A" opacity="0.45" />
          <circle cx="146" cy="72" r="12" fill="#0F172A" opacity="0.45" />
        </g>
      </svg>

      {/* Velo 1 · deja la escena en un susurro. */}
      <div className="absolute inset-0 bg-white/35" />
      {/* Velo 2 · apaga la parte alta, que es por donde entra el encabezado. */}
      <div className="absolute inset-0 bg-gradient-to-b from-white via-white/25 to-white/45" />
      {/* Velo 3 · limpia el centro y deja el paisaje asomar por los costados. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 50% 60% at 50% 46%, rgba(255,255,255,0.92) 0%, rgba(255,255,255,0.55) 58%, rgba(255,255,255,0) 100%)',
        }}
      />
    </div>
  );
}

/**
 * Cristal de las tarjetas que flotan sobre el paisaje.
 *
 * Vive junto al fondo, y no dentro de una pantalla, porque es la otra mitad del mismo
 * acuerdo: el dibujo de atrás y el vidrio de delante se calibran juntos. Lo comparten
 * «Mis viajes» y el detalle de una reserva; «Mi perfil» usa estas mismas clases.
 */
export const TARJETA_FLOTANTE = 'border-white/70 bg-white/85 shadow-panel backdrop-blur-md';
