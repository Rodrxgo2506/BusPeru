import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export interface PassengerDetails {
  first_name: string;
  last_name_1: string;
  last_name_2: string;
  document_type: string;
  document_number: string;
  birth_date: string;
  gender: string;
  phone: string;
  email: string;
  notes: string;
  invoice: boolean;
}

export type TripType = 'ONE_WAY' | 'ROUND_TRIP' | 'MULTI_CITY';

/** Un tramo del itinerario: qué se busca, qué viaje se eligió y con qué asientos. */
export interface ItinerarySegment {
  order: number;
  origin: string;
  destination: string;
  date: string;
  tripId: number | null;
  seatIds: number[];
  seatNumbers: string[];
  /**
   * Precio efectivo de cada asiento, en el mismo orden que `seatIds`. Viene del backend
   * (`trip_seat_type_prices` o `trips.base_price`), no de una multiplicación: dos asientos
   * del mismo viaje pueden costar distinto. Es dato de PRESENTACIÓN; al crear la reserva el
   * backend vuelve a calcularlo y su cifra es la que manda.
   */
  seatPrices: number[];
}

interface CheckoutState {
  /** Compra de un solo tramo. Se conserva tal cual para no alterar el flujo de IDA. */
  tripId: number | null;
  seatIds: number[];
  seatNumbers: string[];
  seatPrices: number[];
  passenger: PassengerDetails | null;
  bookingId: number | null;
  couponCode: string | null;
  /** Compra de varios tramos. `null` en una ida simple. */
  tripType: TripType;
  segments: ItinerarySegment[];
  groupId: number | null;
}

const STORAGE_KEY = 'busperu.checkout';

const EMPTY: CheckoutState = {
  tripId: null,
  seatIds: [],
  seatNumbers: [],
  seatPrices: [],
  passenger: null,
  bookingId: null,
  couponCode: null,
  tripType: 'ONE_WAY',
  segments: [],
  groupId: null,
};

/**
 * Una seleccion sin sus precios no sirve: se descarta.
 *
 * `sessionStorage` sobrevive a un despliegue, asi que una pestaña abierta puede traer una
 * seleccion guardada por una version anterior de la aplicacion, cuando todavia no se
 * guardaba el precio de cada asiento. Con esos datos no hay forma honesta de reconstruir el
 * importe —desde la migracion 010 dos asientos del mismo viaje pueden costar distinto, asi
 * que multiplicar el precio base por la cantidad daria una cifra inventada—, y el pasajero
 * veria un total que el cobro luego desmiente.
 *
 * Se prefiere quedarse sin seleccion antes que con una seleccion que miente: las pantallas
 * de pasajeros y de pago ya devuelven al buscador cuando no hay asientos elegidos, de modo
 * que el pasajero simplemente vuelve a elegirlos y el precio se lee otra vez del backend.
 */
function withUsablePrices(state: CheckoutState): CheckoutState {
  const completa = (seatIds: number[], seatPrices: number[]) =>
    seatPrices.length === seatIds.length && seatPrices.every((precio) => Number.isFinite(Number(precio)));

  return {
    ...state,
    ...(completa(state.seatIds, state.seatPrices) ? {} : { tripId: null, seatIds: [], seatNumbers: [], seatPrices: [] }),
    segments: state.segments.map((segment) =>
      completa(segment.seatIds, segment.seatPrices) ? segment : { ...segment, seatIds: [], seatNumbers: [], seatPrices: [] },
    ),
  };
}

function readStored(): CheckoutState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    return withUsablePrices({ ...EMPTY, ...(JSON.parse(raw) as CheckoutState) });
  } catch {
    return EMPTY;
  }
}

interface CheckoutContextValue extends CheckoutState {
  setSeats: (tripId: number, seatIds: number[], seatNumbers: string[], seatPrices: number[]) => void;
  setPassenger: (passenger: PassengerDetails) => void;
  setCoupon: (code: string | null) => void;
  /**
   * Identificador de la reserva en curso. Se fija en cuanto el backend la crea, no al
   * terminar el pago: si el cobro falla, el reintento necesita saber que esa reserva ya
   * existe y esta reteniendo el asiento. `null` la descarta cuando deja de ser utilizable.
   */
  setBooking: (bookingId: number | null) => void;
  /** Arranca un itinerario con los tramos que se buscaron. */
  startItinerary: (tripType: TripType, segments: Array<Pick<ItinerarySegment, 'origin' | 'destination' | 'date'>>) => void;
  /** Fija el viaje elegido para un tramo, descartando los asientos que hubiera. */
  selectSegmentTrip: (order: number, tripId: number) => void;
  /** Fija los asientos de un tramo concreto. */
  setSegmentSeats: (order: number, tripId: number, seatIds: number[], seatNumbers: string[], seatPrices: number[]) => void;
  setGroup: (groupId: number) => void;
  reset: () => void;
}

const CheckoutContext = createContext<CheckoutContextValue | null>(null);

/** Booking selection survives a page refresh between checkout steps via sessionStorage. */
export function CheckoutProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CheckoutState>(readStored);

  const persist = useCallback((next: CheckoutState) => {
    setState(next);
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Private-mode browsers may block sessionStorage; the flow still works in-memory.
    }
  }, []);

  const value = useMemo<CheckoutContextValue>(
    () => ({
      ...state,
      setSeats: (tripId, seatIds, seatNumbers, seatPrices) =>
        // Elegir un viaje suelto abandona cualquier itinerario a medias.
        persist({ ...state, tripId, seatIds, seatNumbers, seatPrices, bookingId: null, tripType: 'ONE_WAY', segments: [], groupId: null }),
      setPassenger: (passenger) => persist({ ...state, passenger }),
      setCoupon: (couponCode) => persist({ ...state, couponCode }),
      setBooking: (bookingId) => persist({ ...state, bookingId }),

      startItinerary: (tripType, segments) =>
        persist({
          ...EMPTY,
          passenger: state.passenger,
          tripType,
          segments: segments.map((segment, index) => ({
            ...segment,
            order: index + 1,
            tripId: null,
            seatIds: [],
            seatNumbers: [],
            seatPrices: [],
          })),
        }),

      selectSegmentTrip: (order, tripId) =>
        persist({
          ...state,
          groupId: null,
          segments: state.segments.map((segment) =>
            segment.order === order ? { ...segment, tripId, seatIds: [], seatNumbers: [], seatPrices: [] } : segment,
          ),
        }),

      setSegmentSeats: (order, tripId, seatIds, seatNumbers, seatPrices) =>
        persist({
          ...state,
          groupId: null,
          segments: state.segments.map((segment) =>
            segment.order === order ? { ...segment, tripId, seatIds, seatNumbers, seatPrices } : segment,
          ),
        }),

      setGroup: (groupId) => persist({ ...state, groupId }),

      reset: () => {
        sessionStorage.removeItem(STORAGE_KEY);
        setState(EMPTY);
      },
    }),
    [state, persist],
  );

  return <CheckoutContext.Provider value={value}>{children}</CheckoutContext.Provider>;
}

export function useCheckout(): CheckoutContextValue {
  const context = useContext(CheckoutContext);
  if (!context) throw new Error('useCheckout debe usarse dentro de CheckoutProvider');
  return context;
}

/**
 * Subtotal de una seleccion: la SUMA de los precios efectivos de sus asientos.
 *
 * No hay ningun respaldo por precio base multiplicado por la cantidad, y no lo hay a
 * proposito (auditoria 6F, hallazgo H-10): desde la migracion 010 dos asientos del mismo
 * viaje pueden costar distinto, asi que esa multiplicacion solo podria dar una cifra
 * equivocada. Una seleccion que no traiga sus precios se descarta al leerla —ver
 * `withUsablePrices`— en vez de estimarla.
 */
export function selectionSubtotal(seatPrices: number[]): number {
  return seatPrices.reduce((suma, precio) => suma + Number(precio), 0);
}

/** true cuando la compra en curso tiene varios tramos. */
export function isItinerary(state: { tripType: TripType; segments: ItinerarySegment[] }): boolean {
  return state.tripType !== 'ONE_WAY' && state.segments.length > 1;
}
