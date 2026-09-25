import { ArrowLeft, Banknote, Building2, CalendarDays, Check, CreditCard, Lock, ShieldCheck, Smartphone, Ticket, User, Wallet } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Button, Card, Input } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { ApiError } from '@/services/api';
import { bookingService, culqiService, itineraryService, publicService } from '@/services';
import { CheckoutCancelled, openCulqiCheckout } from '@/services/culqi';
import type { Booking, PaymentMethod } from '@/types';
import { formatCurrency, formatDate, formatTime } from '@/utils/format';
import { cn } from '@/utils/cn';
import { CheckoutStepper, TrustBar } from './CheckoutStepper';
import { isItinerary, selectionSubtotal, useCheckout } from './CheckoutContext';

const METHODS: Array<{ id: PaymentMethod; label: string; description: string; icon: typeof CreditCard }> = [
  { id: 'CARD', label: 'Tarjeta de crédito / débito', description: 'Visa, Mastercard, American Express', icon: CreditCard },
  { id: 'YAPE', label: 'Yape', description: 'Paga con tu número de celular', icon: Smartphone },
  { id: 'PLIN', label: 'Plin', description: 'Paga desde tu app bancaria', icon: Smartphone },
  { id: 'TRANSFER', label: 'Transferencia bancaria', description: 'Desde tu banca por internet', icon: Building2 },
  { id: 'CASH', label: 'Pago en efectivo', description: 'En agencias y puntos autorizados', icon: Banknote },
];

export function PaymentPage() {
  const checkout = useCheckout();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { isAuthenticated } = useAuth();

  const trip = useAsync(() => (checkout.tripId ? publicService.trip(checkout.tripId) : Promise.resolve(null)), [checkout.tripId]);
  const settings = useAsync(() => publicService.settings(), []);
  /** Llave publica y disponibilidad de la tarjeta. La privada nunca llega aqui. */
  const culqi = useAsync(() => culqiService.config(), []);

  /**
   * Compra de varios tramos (ida y vuelta / multidestino). Cuando la hay, el resumen y el
   * cobro trabajan sobre los tramos; si no, todo sigue igual que en la compra de IDA.
   */
  const itinerary = isItinerary(checkout);
  const segments = itinerary ? checkout.segments : [];
  const segmentTrips = useAsync(
    () => Promise.all(segments.filter((s) => s.tripId).map((s) => publicService.trip(s.tripId!))),
    [itinerary, segments.map((s) => `${s.tripId}:${s.seatIds.join('-')}`).join('|')],
  );

  // H-23: un itinerario no se cobra por Culqi, así que la tarjeta no se ofrece ahí.
  const availableMethods = itinerary ? METHODS.filter((option) => option.id !== 'CARD') : METHODS;
  const [method, setMethod] = useState<PaymentMethod>(availableMethods[0]!.id);
  const [coupon, setCoupon] = useState(checkout.couponCode ?? '');
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const itinerarioCompleto = itinerary && segments.every((segment) => segment.tripId && segment.seatIds.length > 0);
  const idaCompleta = checkout.tripId !== null && checkout.seatIds.length > 0;

  if ((!itinerary && !idaCompleta) || (itinerary && !itinerarioCompleto) || !checkout.passenger) {
    return <Navigate to="/buscar" replace />;
  }
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  const data = trip.data;
  const serviceFee = Number(settings.data?.['booking.service_fee'] ?? 2.5);
  const passenger = checkout.passenger;

  // El importe se calcula igual en ambos casos; en el itinerario se suma tramo a tramo.
  const seatCount = itinerary
    ? segments.reduce((sum, segment) => sum + segment.seatIds.length, 0)
    : checkout.seatIds.length;

  // Suma de los precios EFECTIVOS de los asientos elegidos. No se multiplica el precio base
  // por la cantidad: el backend cobra asiento a asiento y esta cifra debe coincidir.
  const subtotal = itinerary
    ? segments.reduce((sum, segment) => sum + selectionSubtotal(segment.seatPrices), 0)
    : selectionSubtotal(checkout.seatPrices);

  const total = subtotal + serviceFee * seatCount;

  /**
   * ¿Hay ya una reserva de este mismo checkout que se pueda seguir pagando?
   *
   * EL PROBLEMA QUE RESUELVE. Este paso crea la reserva ANTES de abrir Culqi, porque es la
   * reserva la que retiene el asiento. Si el cobro no llega a completarse —la ventana se
   * cierra, la tarjeta se rechaza, se recarga la página— esa reserva sigue viva con su
   * retención de 15 minutos. Al reintentar se creaba OTRA reserva sobre los mismos asientos,
   * y el backend la rechazaba con «Los asientos 01 ya fueron tomados»: el pasajero chocaba
   * contra su propia reserva anterior sin ninguna forma de entenderlo.
   *
   * Se reutiliza solo si TODO encaja. `GET /bookings/:id` ya está acotado por el alcance de
   * visibilidad del backend, así que una reserva ajena responde 404 y cae por el `catch`: la
   * comprobación de propiedad no se reimplementa aquí.
   *
   * La autoridad sigue siendo el backend, que revalida bajo cerrojo al cobrar. Esto solo
   * evita crear una reserva que se sabe de antemano que va a chocar.
   */
  const reservaReutilizable = async (): Promise<Booking | null> => {
    if (checkout.bookingId === null) return null;

    try {
      const previa = await bookingService.get(checkout.bookingId);

      const vigente =
        previa.status === 'PENDING' &&
        (!previa.expires_at || new Date(previa.expires_at.replace(' ', 'T')).getTime() > Date.now());
      const mismoViaje = Number(previa.trip_id) === checkout.tripId;
      // `seat_numbers` llega como "01, 02"; se compara como conjunto para no depender del orden.
      const asientosPrevios = String(previa.seat_numbers ?? '')
        .split(',')
        .map((numero) => numero.trim())
        .filter(Boolean)
        .sort();
      const mismosAsientos =
        asientosPrevios.length === checkout.seatNumbers.length &&
        asientosPrevios.every((numero, indice) => numero === [...checkout.seatNumbers].sort()[indice]);

      if (vigente && mismoViaje && mismosAsientos) return previa;
    } catch {
      // No existe, no es suya o el backend no la deja ver. Se descarta y se crea una nueva.
    }

    // Caducada, cancelada, ya pagada o de otro viaje: se olvida el identificador y se sigue
    // como si fuera la primera vez. Los asientos y el pasajero no se tocan.
    checkout.setBooking(null);
    return null;
  };

  /**
   * Creates the booking (locking the seats) and confirms its payment. Card fields are
   * display-only: the schema stores no card data and nothing typed there is ever sent.
   */
  const handlePay = async (event: FormEvent) => {
    event.preventDefault();
    setProcessing(true);
    setError(null);

    const titular = {
      passenger_name: `${passenger.first_name} ${passenger.last_name_1} ${passenger.last_name_2}`.trim(),
      passenger_document: `${passenger.document_type} ${passenger.document_number}`.trim(),
      passenger_phone: passenger.phone,
      passenger_email: passenger.email,
      notes: passenger.notes || null,
      coupon_code: coupon.trim() || null,
      payment_method: method,
    };

    try {
      if (itinerary) {
        // Una sola llamada crea todos los tramos en una transacción: si uno falla, no
        // queda ninguno creado y el usuario ve el error sin haber pagado nada a medias.
        const grupo = await itineraryService.create({
          ...titular,
          trip_type: checkout.tripType,
          segments: segments.map((segment) => ({ trip_id: segment.tripId, seat_ids: segment.seatIds })),
        });
        const groupId = Number(grupo.group_id);

        const pagado = await itineraryService.pay(groupId, { method });
        // H-22: un pago manual queda pendiente hasta que la empresa lo verifique.
        const tramos = (pagado.segments ?? []) as Array<{ status?: unknown }>;
        if (tramos.some((tramo) => tramo.status !== 'CONFIRMED')) {
          toast.info('Pago registrado. Pendiente de verificación.', `Itinerario ${String(grupo.group_code)}: te avisaremos cuando se confirme.`);
          // Primero se sale del checkout y luego se limpia, para que esta pantalla no redirija al buscador.
          navigate('/customer/trips', { replace: true });
          checkout.reset();
          return;
        }
        checkout.setGroup(groupId);
        toast.success('¡Pago aprobado!', `Itinerario ${String(grupo.group_code)} confirmado.`);
        navigate(`/reserva/confirmacion/itinerario/${groupId}`, { replace: true });
        return;
      }

      const booking =
        (await reservaReutilizable()) ??
        (await bookingService.create({
          trip_id: checkout.tripId,
          seat_ids: checkout.seatIds,
          ...titular,
        }));

      // Se anota YA, no al terminar el pago: si el cobro falla, el reintento tiene que saber
      // que esta reserva existe y que es la que retiene el asiento.
      checkout.setBooking(booking.id);

      if (method === 'CARD') {
        // La ventana de Culqi devuelve un token; los datos de la tarjeta no pasan por aqui.
        // El importe que se muestra sale del total real de la reserva que acaba de crear el
        // backend, no de una suma hecha en el navegador: el backend vuelve a calcularlo y
        // solo cobra el suyo, de modo que tocar este numero no cambia lo que se cobra.
        const token = await openCulqiCheckout({
          publicKey: culqi.data!.public_key,
          amountCents: Math.round(Number(booking.total_amount) * 100),
          currency: culqi.data!.currency,
          description: `Reserva ${booking.booking_code}`,
        });
        await bookingService.pay(booking.id, { method, token });
      } else {
        const registrada = await bookingService.pay(booking.id, { method });
        // H-22: un pago manual queda pendiente hasta que la empresa lo verifique.
        if (registrada.status !== 'CONFIRMED') {
          toast.info('Pago registrado. Pendiente de verificación.', `Reserva ${booking.booking_code}: te avisaremos cuando se confirme.`);
          navigate(`/customer/bookings/${booking.id}`, { replace: true });
          checkout.reset();
          return;
        }
      }
      toast.success('¡Pago aprobado!', `Reserva ${booking.booking_code} confirmada.`);
      navigate(`/reserva/confirmacion/${booking.id}`, { replace: true });
    } catch (caught) {
      // Cerrar la ventana de Culqi no es un fallo: la reserva sigue viva con su retencion y
      // el pasajero puede reintentar sin volver a elegir asientos.
      if (caught instanceof CheckoutCancelled) setError(null);
      else setError(caught instanceof ApiError || caught instanceof Error ? caught.message : 'No pudimos procesar tu pago. Inténtalo nuevamente.');
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <CheckoutStepper current={5} />

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <aside className="space-y-5 lg:sticky lg:top-24 lg:self-start">
          <Card>
            <h2 className="font-semibold text-ink">Resumen de tu viaje</h2>

            {itinerary ? (
              <ol className="mt-4 space-y-3">
                {segments.map((entry, index) => {
                  const viaje = segmentTrips.data?.[index];
                  return (
                    <li key={entry.order} className="rounded-control border border-border p-3">
                      <p className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-brand-600">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-500 text-[10px] text-white">
                          {entry.order}
                        </span>
                        {checkout.tripType === 'ROUND_TRIP' ? (entry.order === 1 ? 'Ida' : 'Vuelta') : `Tramo ${entry.order}`}
                      </p>
                      <p className="text-sm font-semibold text-ink">
                        {entry.origin} → {entry.destination}
                      </p>
                      <p className="text-xs text-muted">
                        {formatDate(entry.date)} · {viaje ? formatTime(viaje.departure_datetime) : '—'}
                        {viaje?.company_name ? ` · ${viaje.company_name}` : ''}
                      </p>
                      <p className="mt-1 flex items-center justify-between text-xs">
                        <span className="text-muted">Asientos: {entry.seatNumbers.join(', ') || '—'}</span>
                        <span className="font-semibold text-ink">
                          {formatCurrency(selectionSubtotal(entry.seatPrices))}
                        </span>
                      </p>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <>
            <p className="mt-4 text-lg font-extrabold uppercase leading-tight text-ink">{data?.company_name}</p>
            <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
              {data?.bus_type_name ?? 'Bus'}
            </span>

            <div className="mt-4 flex items-start justify-between gap-3 border-t border-border pt-4">
              <div>
                <p className="text-sm font-medium text-slate-600">{data?.origin_city}</p>
                <p className="text-xl font-bold text-ink">{formatTime(data?.departure_datetime)}</p>
                <p className="text-xs text-muted">{data?.origin_terminal}</p>
              </div>
              <div className="pt-2 text-slate-300">→</div>
              <div className="text-right">
                <p className="text-sm font-medium text-slate-600">{data?.destination_city}</p>
                <p className="text-xl font-bold text-ink">{formatTime(data?.arrival_datetime)}</p>
                <p className="text-xs text-muted">{data?.destination_terminal}</p>
              </div>
            </div>

              </>
            )}

            <dl className="mt-4 space-y-2.5 border-t border-border pt-4 text-sm">
              {!itinerary && (
                <SummaryRow icon={<CalendarDays className="h-4 w-4 text-brand-500" />} label="Fecha de viaje" value={formatDate(data?.departure_datetime)} />
              )}
              <SummaryRow icon={<User className="h-4 w-4 text-brand-500" />} label="Pasajeros" value={`${seatCount} ${seatCount === 1 ? 'pasajero' : 'pasajeros'}`} />
              {!itinerary && (
                <SummaryRow icon={<Ticket className="h-4 w-4 text-brand-500" />} label="Asiento seleccionado" value={checkout.seatNumbers.join(', ')} />
              )}
              <SummaryRow
                icon={<Wallet className="h-4 w-4 text-brand-500" />}
                label={itinerary ? 'Subtotal de los tramos' : 'Subtotal'}
                value={formatCurrency(subtotal)}
              />
              <SummaryRow icon={<Wallet className="h-4 w-4 text-brand-500" />} label="Cargo por servicio" value={formatCurrency(serviceFee * seatCount)} />
            </dl>

            <div className="mt-4 flex items-center justify-between rounded-control bg-brand-50 p-3.5">
              <span className="text-sm font-semibold text-ink">TOTAL A PAGAR</span>
              <span className="text-xl font-extrabold text-brand-600">{formatCurrency(total)}</span>
            </div>
          </Card>

          <Card className="flex gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-brand-500" />
            <p className="text-sm">
              <span className="block font-semibold text-ink">Pago 100% seguro</span>
              <span className="text-muted">Tu información y pago están protegidos con encriptación SSL.</span>
            </p>
          </Card>
        </aside>

        <Card>
          <h1 className="text-2xl font-bold text-ink">Elige tu método de pago</h1>
          <p className="mt-1 text-sm text-muted">Selecciona el método que prefieras para realizar tu pago de forma segura.</p>

          {error && (
            <div className="mt-4 rounded-control border border-danger-200 bg-danger-50 p-3 text-sm text-danger-700" role="alert">
              {error}
            </div>
          )}

          <form onSubmit={handlePay} className="mt-6 grid gap-5 lg:grid-cols-2">
            <fieldset className="space-y-3">
              <legend className="sr-only">Método de pago</legend>
              {availableMethods.map((option) => {
                const Icon = option.icon;
                const isSelected = method === option.id;
                return (
                  <label
                    key={option.id}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-card border p-4 transition',
                      isSelected ? 'border-brand-500 bg-brand-50/50' : 'border-border hover:border-brand-200',
                    )}
                  >
                    <input type="radio" name="method" value={option.id} checked={isSelected} onChange={() => setMethod(option.id)} className="sr-only" />
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-white">
                      <Icon className="h-5 w-5 text-slate-600" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-ink">{option.label}</span>
                      <span className="block text-xs text-muted">{option.description}</span>
                    </span>
                    <span
                      className={cn(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2',
                        isSelected ? 'border-brand-500 bg-brand-500 text-white' : 'border-slate-300',
                      )}
                      aria-hidden
                    >
                      {isSelected && <Check className="h-3 w-3" strokeWidth={3.5} />}
                    </span>
                  </label>
                );
              })}
              {itinerary && <p className="text-xs text-muted">Pago con tarjeta no disponible para itinerarios.</p>}
            </fieldset>

            <div className="space-y-4 rounded-card border border-border p-5">
              {method === 'CARD' ? (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-muted">Aceptamos</span>
                    <span className="flex items-center gap-2">
                      <VisaMark />
                      <MastercardMark />
                      <AmexMark />
                    </span>
                  </div>

                  {culqi.data?.card_enabled ? (
                    <p className="rounded-control border border-border bg-slate-50 p-3 text-xs text-slate-600">
                      Al continuar se abrira la ventana segura de <strong className="text-ink">Culqi</strong> para introducir
                      los datos de tu tarjeta. BusPeru no ve, no guarda ni transmite el numero de tu tarjeta: solo recibe un
                      identificador de pago.
                    </p>
                  ) : (
                    <p className="rounded-control border border-warning-200 bg-warning-50 p-3 text-xs text-warning-700">
                      El pago con tarjeta no esta disponible en este momento. Elige otro metodo para completar tu compra.
                    </p>
                  )}
                </>
              ) : (
                <p className="rounded-control bg-slate-50 p-4 text-sm text-slate-600">
                  Se registrará tu pago con el método <strong className="text-ink">{METHODS.find((entry) => entry.id === method)?.label}</strong>. Tu
                  reserva quedará pendiente de verificación hasta que la empresa confirme que recibió el pago.
                </p>
              )}

              <Input
                label="Cupón de descuento (opcional)"
                placeholder="Ej: VIAJA20"
                value={coupon}
                onChange={(event) => setCoupon(event.target.value.toUpperCase())}
                hint="Se validará contra los cupones activos de la plataforma."
              />

              <div className="rounded-control bg-brand-50 p-4">
                <p className="text-sm text-muted">Total a pagar</p>
                <p className="text-2xl font-extrabold text-brand-600">{formatCurrency(total)}</p>
              </div>

              <Button type="submit" fullWidth size="lg" loading={processing} icon={<Lock className="h-4 w-4" />}>
                Pagar ahora
              </Button>

              <p className="flex items-start justify-center gap-2 text-center text-xs text-muted">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success-600" />
                <span>
                  <span className="block font-semibold text-ink">Tus datos están protegidos</span>
                  Utilizamos encriptación SSL de 256 bits.
                </span>
              </p>
            </div>
          </form>

          <Button variant="outline" className="mt-6" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => navigate(-1)}>
            Volver
          </Button>
        </Card>
      </div>

      <TrustBar />
    </div>
  );
}

function SummaryRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="flex items-center gap-2 text-muted">
        {icon}
        {label}
      </dt>
      <dd className="text-right font-medium text-ink">{value}</dd>
    </div>
  );
}

/* Marcas de tarjeta dibujadas en línea: los mockups no traen assets y no se cargan recursos externos. */
function VisaMark() {
  return (
    <span className="flex h-6 w-10 items-center justify-center rounded border border-border bg-white text-[10px] font-black italic tracking-tight text-[#1A1F71]">
      VISA
    </span>
  );
}

function MastercardMark() {
  return (
    <span className="flex h-6 w-10 items-center justify-center gap-0 rounded border border-border bg-white" aria-label="Mastercard">
      <span className="h-3.5 w-3.5 rounded-full bg-[#EB001B]" />
      <span className="-ml-1.5 h-3.5 w-3.5 rounded-full bg-[#F79E1B] opacity-90" />
    </span>
  );
}

function AmexMark() {
  return (
    <span className="flex h-6 w-10 items-center justify-center rounded border border-border bg-[#006FCF] text-[7px] font-black leading-none text-white">
      AMEX
    </span>
  );
}
