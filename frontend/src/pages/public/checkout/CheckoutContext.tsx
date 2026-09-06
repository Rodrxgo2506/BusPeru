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
}

interface CheckoutState {
  /** Compra de un solo tramo. Se conserva tal cual para no alterar el flujo de IDA. */
  tripId: number | null;
  seatIds: number[];
  seatNumbers: string[];
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
  passenger: null,
  bookingId: null,
  couponCode: null,
  tripType: 'ONE_WAY',
  segments: [],
  groupId: null,
};

function readStored(): CheckoutState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as CheckoutState) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

interface CheckoutContextValue extends CheckoutState {
  setSeats: (tripId: number, seatIds: number[], seatNumbers: string[]) => void;
  setPassenger: (passenger: PassengerDetails) => void;
  setCoupon: (code: string | null) => void;
  setBooking: (bookingId: number) => void;
  /** Arranca un itinerario con los tramos que se buscaron. */
  startItinerary: (tripType: TripType, segments: Array<Pick<ItinerarySegment, 'origin' | 'destination' | 'date'>>) => void;
  /** Fija el viaje elegido para un tramo, descartando los asientos que hubiera. */
  selectSegmentTrip: (order: number, tripId: number) => void;
  /** Fija los asientos de un tramo concreto. */
  setSegmentSeats: (order: number, tripId: number, seatIds: number[], seatNumbers: string[]) => void;
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
      setSeats: (tripId, seatIds, seatNumbers) =>
        // Elegir un viaje suelto abandona cualquier itinerario a medias.
        persist({ ...state, tripId, seatIds, seatNumbers, bookingId: null, tripType: 'ONE_WAY', segments: [], groupId: null }),
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
          })),
        }),

      selectSegmentTrip: (order, tripId) =>
        persist({
          ...state,
          groupId: null,
          segments: state.segments.map((segment) =>
            segment.order === order ? { ...segment, tripId, seatIds: [], seatNumbers: [] } : segment,
          ),
        }),

      setSegmentSeats: (order, tripId, seatIds, seatNumbers) =>
        persist({
          ...state,
          groupId: null,
          segments: state.segments.map((segment) =>
            segment.order === order ? { ...segment, tripId, seatIds, seatNumbers } : segment,
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

/** true cuando la compra en curso tiene varios tramos. */
export function isItinerary(state: { tripType: TripType; segments: ItinerarySegment[] }): boolean {
  return state.tripType !== 'ONE_WAY' && state.segments.length > 1;
}
