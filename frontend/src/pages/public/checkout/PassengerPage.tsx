import { ArrowLeft, ArrowRight, BusFront, CalendarDays, ShieldCheck, Ticket, User, Wallet } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Button, Card, Checkbox, Input, LoadingState, Select, Textarea } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useAsync } from '@/hooks/useAsync';
import { publicService } from '@/services';
import { formatCurrency, formatDate, formatTime } from '@/utils/format';
import { CheckoutStepper, TrustBar } from './CheckoutStepper';
import { isItinerary, selectionSubtotal, useCheckout, type PassengerDetails } from './CheckoutContext';

const EMPTY_PASSENGER: PassengerDetails = {
  first_name: '',
  last_name_1: '',
  last_name_2: '',
  document_type: 'DNI',
  document_number: '',
  birth_date: '',
  gender: '',
  phone: '',
  email: '',
  notes: '',
  invoice: false,
};

export function PassengerPage() {
  const checkout = useCheckout();
  const navigate = useNavigate();
  const { user } = useAuth();

  const trip = useAsync(() => (checkout.tripId ? publicService.trip(checkout.tripId) : Promise.resolve(null)), [checkout.tripId]);

  /** Compra de varios tramos: el resumen los lista en vez de mostrar un solo viaje. */
  const itinerary = isItinerary(checkout);
  const segments = itinerary ? checkout.segments : [];
  const segmentTrips = useAsync(
    () => Promise.all(segments.filter((entry) => entry.tripId).map((entry) => publicService.trip(entry.tripId!))),
    [itinerary, segments.map((entry) => `${entry.tripId}:${entry.seatIds.join('-')}`).join('|')],
  );
  const settings = useAsync(() => publicService.settings(), []);

  const [form, setForm] = useState<PassengerDetails>(checkout.passenger ?? EMPTY_PASSENGER);
  const [accepted, setAccepted] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!checkout.passenger && user) {
      setForm((current) => ({
        ...current,
        first_name: current.first_name || user.first_name,
        last_name_1: current.last_name_1 || user.last_name,
        email: current.email || user.email,
        phone: current.phone || (user.phone ?? ''),
      }));
    }
  }, [user, checkout.passenger]);

  const itinerarioListo = itinerary && segments.every((entry) => entry.tripId && entry.seatIds.length > 0);
  const idaLista = checkout.tripId !== null && checkout.seatIds.length > 0;

  if (itinerary ? !itinerarioListo : !idaLista) {
    return <Navigate to="/buscar" replace />;
  }

  const update = (key: keyof PassengerDetails) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    if (form.first_name.trim().length < 2) nextErrors.first_name = 'Ingresa el nombre del pasajero';
    if (form.last_name_1.trim().length < 2) nextErrors.last_name_1 = 'Ingresa el apellido paterno';
    if (form.document_number.trim().length < 6) nextErrors.document_number = 'Ingresa un documento válido';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) nextErrors.email = 'Ingresa un correo válido';
    if (form.phone.trim().length < 6) nextErrors.phone = 'Ingresa un teléfono de contacto';
    if (!accepted) nextErrors.terms = 'Debes aceptar los términos y condiciones';

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    checkout.setPassenger(form);
    navigate('/reserva/pago');
  };

  if (trip.loading) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-10">
        <LoadingState label="Cargando datos del viaje..." />
      </div>
    );
  }

  const data = trip.data;
  const serviceFee = Number(settings.data?.['booking.service_fee'] ?? 2.5);
  const seatCount = itinerary
    ? segments.reduce((sum, entry) => sum + entry.seatIds.length, 0)
    : checkout.seatIds.length;

  // El subtotal es la suma de los precios EFECTIVOS que traia la seleccion, no el precio
  // base por la cantidad: dos asientos del mismo viaje pueden costar distinto.
  const subtotal = itinerary
    ? segments.reduce((sum, entry) => sum + selectionSubtotal(entry.seatPrices), 0)
    : selectionSubtotal(checkout.seatPrices);

  const total = subtotal + serviceFee * seatCount;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <CheckoutStepper current={4} />

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          <Card>
            <h2 className="mb-4 font-semibold text-ink">Resumen de tu viaje</h2>

            {itinerary ? (
              <ol className="space-y-3">
                {segments.map((entry, index) => {
                  const viaje = segmentTrips.data?.[index];
                  return (
                    <li key={entry.order} className="rounded-control border border-border p-3">
                      <p className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-brand-600">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-500 text-[10px] text-white">
                          {entry.order}
                        </span>
                        {checkout.tripType === 'ROUND_TRIP'
                          ? entry.order === 1
                            ? 'Ida'
                            : 'Vuelta'
                          : `Tramo ${entry.order}`}
                      </p>
                      <p className="text-sm font-semibold text-ink">
                        {entry.origin} → {entry.destination}
                      </p>
                      <p className="text-xs text-muted">
                        {formatDate(entry.date)} · {viaje ? formatTime(viaje.departure_datetime) : '—'}
                      </p>
                      <p className="mt-1 text-xs text-muted">Asientos: {entry.seatNumbers.join(', ') || '—'}</p>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <>
            <p className="text-lg font-extrabold uppercase text-ink">{data?.company_name}</p>
            <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
              <BusFront className="h-3.5 w-3.5" />
              {data?.bus_type_name ?? 'Bus'}
            </span>

            <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
              <div>
                <p className="text-sm font-medium text-slate-600">{data?.origin_city}</p>
                <p className="text-xl font-bold text-ink">{formatTime(data?.departure_datetime)}</p>
                <p className="text-xs text-muted">{data?.origin_terminal}</p>
              </div>
              <div>
                <p className="text-right text-sm font-medium text-slate-600">{data?.destination_city}</p>
                <p className="text-right text-xl font-bold text-ink">{formatTime(data?.arrival_datetime)}</p>
                <p className="text-right text-xs text-muted">{data?.destination_terminal}</p>
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
                <SummaryRow icon={<Ticket className="h-4 w-4 text-brand-500" />} label="Asientos" value={checkout.seatNumbers.join(', ')} />
              )}
              {/* «Precio por pasajero» ya no existe: cada asiento tiene el suyo. Se muestra
                  el subtotal, que es la suma real de los asientos elegidos. */}
              <SummaryRow icon={<Wallet className="h-4 w-4 text-brand-500" />} label={itinerary ? 'Subtotal de los tramos' : 'Subtotal'} value={formatCurrency(subtotal)} />
              <SummaryRow icon={<Wallet className="h-4 w-4 text-brand-500" />} label="Cargo por servicio" value={formatCurrency(serviceFee * seatCount)} />
            </dl>

            <div className="mt-4 flex items-center justify-between rounded-control bg-brand-50 p-3">
              <span className="text-sm font-semibold text-ink">TOTAL A PAGAR</span>
              <span className="text-xl font-extrabold text-brand-600">{formatCurrency(total)}</span>
            </div>
          </Card>

          <Card className="flex gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-success-600" />
            <p className="text-sm">
              <span className="block font-semibold text-ink">Tus datos están seguros</span>
              <span className="text-muted">Utilizamos cifrado SSL para proteger tu información personal.</span>
            </p>
          </Card>
        </aside>

        <Card>
          <h1 className="text-2xl font-bold text-ink">Datos del pasajero</h1>
          <p className="mt-1 text-sm text-muted">Ingresa los datos de la persona que viajará.</p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-5" noValidate>
            <div className="grid gap-4 sm:grid-cols-3">
              <Input label="Nombre(s)" placeholder="Ej: Rodrigo" value={form.first_name} onChange={update('first_name')} error={errors.first_name} required />
              <Input label="Apellido paterno" placeholder="Ej: Pérez" value={form.last_name_1} onChange={update('last_name_1')} error={errors.last_name_1} required />
              <Input label="Apellido materno" placeholder="Ej: Gómez" value={form.last_name_2} onChange={update('last_name_2')} />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Select
                label="Tipo de documento"
                options={[
                  { value: 'DNI', label: 'DNI' },
                  { value: 'CE', label: 'Carné de extranjería' },
                  { value: 'PAS', label: 'Pasaporte' },
                ]}
                value={form.document_type}
                onChange={update('document_type')}
                required
              />
              <Input label="Número de documento" placeholder="Ej: 12345678" value={form.document_number} onChange={update('document_number')} error={errors.document_number} required />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Fecha de nacimiento" type="date" value={form.birth_date} onChange={update('birth_date')} />
              <Select
                label="Género"
                placeholder="Seleccionar"
                options={[
                  { value: 'F', label: 'Femenino' },
                  { value: 'M', label: 'Masculino' },
                  { value: 'O', label: 'Otro' },
                ]}
                value={form.gender}
                onChange={update('gender')}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Teléfono / Celular" type="tel" placeholder="Ej: 987 654 321" value={form.phone} onChange={update('phone')} error={errors.phone} required />
              <Input label="Correo electrónico" type="email" placeholder="Ej: rodrigo@email.com" value={form.email} onChange={update('email')} error={errors.email} required />
            </div>

            <div className="border-t border-border pt-5">
              <h2 className="font-semibold text-ink">Información adicional</h2>
              <div className="mt-3 flex flex-wrap gap-6">
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input type="radio" name="invoice" checked={form.invoice} onChange={() => setForm({ ...form, invoice: true })} className="text-brand-500 focus:ring-brand-500" />
                  Sí, quiero factura
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input type="radio" name="invoice" checked={!form.invoice} onChange={() => setForm({ ...form, invoice: false })} className="text-brand-500 focus:ring-brand-500" />
                  No, no necesito factura
                </label>
              </div>

              <Textarea
                label="Observaciones (opcional)"
                placeholder="Ej: Viajo con equipaje especial, etc."
                className="mt-4"
                value={form.notes}
                onChange={update('notes')}
              />
            </div>

            <div>
              <Checkbox
                checked={accepted}
                onChange={(event) => setAccepted(event.target.checked)}
                label={
                  <>
                    Acepto los <span className="font-medium text-brand-600">términos y condiciones</span> y la{' '}
                    <span className="font-medium text-brand-600">política de privacidad</span>.
                  </>
                }
              />
              {errors.terms && <p className="mt-1.5 text-xs font-medium text-danger-600">{errors.terms}</p>}
            </div>

            <div className="flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:justify-between">
              <Button type="button" variant="outline" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => navigate(-1)}>
                Volver
              </Button>
              <Button type="submit" size="lg" iconRight={<ArrowRight className="h-4 w-4" />}>
                Continuar al resumen
              </Button>
            </div>
          </form>
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
