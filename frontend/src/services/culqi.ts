/**
 * Culqi Checkout en el navegador.
 *
 * Los datos de la tarjeta NUNCA pasan por BusPerú. El formulario lo pinta y lo valida Culqi
 * dentro de su propia ventana, y lo único que vuelve a nuestra aplicación es un token
 * (`tkn_…`) que por sí solo no sirve para nada fuera de nuestra cuenta. Con eso, BusPerú
 * queda fuera del alcance de PCI DSS: no ve, no guarda y no transmite números de tarjeta.
 *
 * Aquí solo se usa la LLAVE PÚBLICA, que es la que Culqi exige que viaje al navegador. La
 * privada vive exclusivamente en el backend y no existe ninguna variable `VITE_` para ella.
 *
 * Se integra Checkout v4 (`https://checkout.culqi.com/js/v4`) porque es el flujo cuyo
 * contrato está documentado con precisión: `Culqi.publicKey`, `Culqi.settings()`,
 * `Culqi.open()` y la función global `culqi()` como devolución de llamada. Culqi anuncia que
 * migrará a Checkout Custom; cuando publiquen su contrato estable, el cambio se hace aquí y
 * en ningún otro sitio.
 */

const SCRIPT_URL = 'https://checkout.culqi.com/js/v4';
const SCRIPT_ID = 'culqi-checkout-v4';

interface CulqiGlobal {
  publicKey: string;
  settings(options: Record<string, unknown>): void;
  options?(options: Record<string, unknown>): void;
  open(): void;
  close?(): void;
  token?: { id: string };
  error?: { user_message?: string; merchant_message?: string };
}

declare global {
  interface Window {
    Culqi?: CulqiGlobal;
    culqi?: () => void;
  }
}

/** Carga el script una sola vez, aunque se entre y se salga varias veces del checkout. */
function loadScript(): Promise<CulqiGlobal> {
  if (window.Culqi) return Promise.resolve(window.Culqi);

  return new Promise((resolve, reject) => {
    const existente = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    const script = existente ?? document.createElement('script');

    const alCargar = () => {
      if (window.Culqi) resolve(window.Culqi);
      else reject(new Error('Culqi no quedó disponible tras cargar su script'));
    };

    script.addEventListener('load', alCargar, { once: true });
    script.addEventListener('error', () => reject(new Error('No se pudo cargar el formulario de pago')), { once: true });

    if (!existente) {
      script.id = SCRIPT_ID;
      script.src = SCRIPT_URL;
      script.async = true;
      document.head.appendChild(script);
    }
  });
}

export interface CheckoutRequest {
  publicKey: string;
  /** En céntimos, tal como lo exige Culqi. Lo calcula quien llama a partir del total. */
  amountCents: number;
  currency: string;
  description: string;
}

/** El usuario cerró la ventana sin pagar. No es un error que haya que enseñar en rojo. */
export class CheckoutCancelled extends Error {
  constructor() {
    super('Pago cancelado');
    this.name = 'CheckoutCancelled';
  }
}

/**
 * Abre la ventana de Culqi y resuelve con el token.
 *
 * La devolución de llamada de Culqi es una función global (`window.culqi`), así que se
 * instala justo antes de abrir y se retira al terminar: dejarla puesta haría que un pago
 * posterior resolviera la promesa equivocada.
 */
export async function openCulqiCheckout(request: CheckoutRequest): Promise<string> {
  const Culqi = await loadScript();

  return new Promise<string>((resolve, reject) => {
    const anterior = window.culqi;
    let resuelto = false;
    const limpiar = () => {
      resuelto = true;
      window.culqi = anterior;
    };

    /**
     * Culqi valida su configuración por dentro y, cuando algo no le cuadra, **lo escribe en
     * consola y no abre nada**: no lanza, no llama a la devolución de llamada y la promesa
     * se quedaría esperando para siempre, con el botón cargando y sin explicación.
     *
     * Esto comprueba que el formulario haya llegado al DOM. No usa ninguna API no
     * documentada: solo mira si apareció algo suyo en la página. Culqi monta un
     * `div#culqi-js` con un iframe de `checkoutview.culqi.com`, y se buscan esas dos formas.
     *
     * Se excluyen los `<script>` A PROPÓSITO: el nuestro se llama `culqi-checkout-v4`, y un
     * selector más flojo lo daba por bueno, de modo que el vigilante nunca saltaba —justo lo
     * contrario de lo que existe para hacer—.
     */
    const vigilarApertura = () => {
      setTimeout(() => {
        if (resuelto) return;
        const abierto = document.querySelector('div[id*="culqi"], iframe[src*="culqi"]');
        if (abierto) return;
        limpiar();
        reject(new Error('No se pudo abrir el formulario de pago. Vuelve a intentarlo en unos segundos.'));
      }, 2000);
    };

    window.culqi = () => {
      try {
        if (Culqi.token?.id) {
          Culqi.close?.();
          resolve(Culqi.token.id);
          return;
        }
        const mensaje = Culqi.error?.user_message;
        reject(mensaje ? new Error(mensaje) : new CheckoutCancelled());
      } finally {
        limpiar();
      }
    };

    try {
      Culqi.publicKey = request.publicKey;
      // SIN `order`. En Culqi, `order` NO es una referencia libre del comercio: es el
      // identificador `ord_…` de una Orden de Pago creada antes desde el backend, y sirve
      // para habilitar PagoEfectivo, billeteras móviles y Cuotéalo. Aquí se cobra con
      // tarjeta tokenizada, que no usa órdenes; dejándolo vacío Culqi muestra justamente
      // los medios con tarjeta, que es lo que BusPerú ofrece. Pasarle el código de reserva
      // hacía fallar su validación y el formulario no llegaba a abrirse.
      //
      // La referencia de la reserva no se pierde: viaja en `description`, y sobre todo en
      // la `metadata` del cargo que crea el backend (booking_id, booking_code, payment_id).
      Culqi.settings({
        title: 'BusPerú',
        currency: request.currency,
        description: request.description,
        amount: request.amountCents,
      });
      Culqi.open();
      vigilarApertura();
    } catch (error) {
      limpiar();
      reject(error instanceof Error ? error : new Error('No se pudo abrir el formulario de pago'));
    }
  });
}
