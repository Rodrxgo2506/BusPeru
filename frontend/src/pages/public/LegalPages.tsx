import {
  AlertTriangle,
  BookOpen,
  CalendarX,
  CheckCircle2,
  Cookie,
  CreditCard,
  FileText,
  HelpCircle,
  Headphones,
  Printer,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { PublicHero } from '@/components/common/PublicHero';
import { Button, Card, Checkbox, Input, Select, Textarea } from '@/components/ui';
import { helpHeroImage } from '@/constants/images';
import { useAsync } from '@/hooks/useAsync';
import { usePageMeta } from '@/hooks/usePageMeta';
import { ApiError } from '@/services/api';
import { complaintService } from '@/services/company-profile';
import { publicService } from '@/services';
import type { ComplaintForm, ComplaintLookup, ComplaintReceipt, LegalInfo } from '@/types/company-profile';
import { formatDate, formatDateTime } from '@/utils/format';

/**
 * F18-19 · «Información útil»: textos legales y de servicio de BusPerú y el Libro de Reclamaciones virtual.
 *
 * LOS TEXTOS SON UNA VERSIÓN PROPUESTA. Describen el funcionamiento REAL de la plataforma (verificado en el
 * código: plazos, estados, pagos, almacenamiento) y citan las normas verificadas en fuentes oficiales
 * (docs/production/F18-19-LEGAL-SOURCES.md). Los datos del proveedor que faltan salen de `/public/legal` y
 * se muestran como PENDIENTES: no se inventa ninguno. Deben revisarse con asesoría legal antes de publicar.
 */

const LEGAL_PAGES = [
  { to: '/terminos', title: 'Términos y condiciones', description: 'Cómo funciona BusPerú, qué hace la plataforma y qué hace la empresa de transporte.', icon: <FileText className="h-6 w-6" /> },
  { to: '/privacidad', title: 'Política de privacidad', description: 'Qué datos tratamos, para qué, con quién los compartimos y tus derechos.', icon: <ShieldCheck className="h-6 w-6" /> },
  { to: '/cookies', title: 'Política de cookies', description: 'Qué guardamos en tu navegador y qué servicios de terceros se cargan.', icon: <Cookie className="h-6 w-6" /> },
  { to: '/reservas-y-cancelaciones', title: 'Reservas y cancelaciones', description: 'Plazos de pago, cancelación y reembolsos tal como funcionan hoy.', icon: <CalendarX className="h-6 w-6" /> },
  { to: '/pagos', title: 'Información de pagos', description: 'Medios de pago disponibles y cómo se confirma cada uno.', icon: <CreditCard className="h-6 w-6" /> },
  { to: '/ayuda', title: 'Preguntas frecuentes', description: 'Respuestas rápidas sobre compras, pagos y viajes.', icon: <HelpCircle className="h-6 w-6" /> },
  { to: '/customer/support', title: 'Ayuda y soporte', description: 'Crea un ticket de soporte desde tu cuenta.', icon: <Headphones className="h-6 w-6" /> },
  { to: '/libro-de-reclamaciones', title: 'Libro de Reclamaciones', description: 'Registra un reclamo o una queja y consulta su estado.', icon: <BookOpen className="h-6 w-6" /> },
];

export function InfoHubPage() {
  usePageMeta({ title: 'Información útil | BusPerú', description: 'Términos, privacidad, cookies, reservas y cancelaciones, pagos y Libro de Reclamaciones de BusPerú.' });
  return (
    <PublicHero eyebrow="Transparencia" title="Información útil" description="Todo lo que necesitas saber sobre cómo funciona BusPerú." image={helpHeroImage} imagePosition="50% 60%">
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {LEGAL_PAGES.map((page) => (
          <li key={page.to}>
            <Link to={page.to} className="flex h-full flex-col rounded-card bg-white p-5 shadow-card ring-1 ring-black/5 transition hover:-translate-y-0.5 hover:shadow-elevated">
              <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-brand-50 text-brand-600" aria-hidden>{page.icon}</span>
              <span className="mt-3 font-bold text-ink">{page.title}</span>
              <span className="mt-1 text-sm text-muted">{page.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </PublicHero>
  );
}

// ================================================================================ utilidades de documento
function Pending({ children }: { children: ReactNode }) {
  return <mark className="rounded bg-amber-100 px-1 font-semibold text-amber-900">[PENDIENTE: {children}]</mark>;
}

function ProviderValue({ value, label }: { value: string | null | undefined; label: string }) {
  return value ? <strong>{value}</strong> : <Pending>{label}</Pending>;
}

function useLegal(): LegalInfo | null {
  return useAsync(() => complaintService.legal(), []).data;
}

function LegalDocument({ title, description, updated, children }: { title: string; description: string; updated: string; children: ReactNode }) {
  usePageMeta({ title: `${title} | BusPerú`, description });
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:py-14">
      <nav aria-label="Ruta" className="text-sm text-muted">
        <Link to="/informacion" className="hover:text-brand-600">Información útil</Link> <span aria-hidden>/</span> {title}
      </nav>
      <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">{title}</h1>
      <p className="mt-2 text-slate-600">{description}</p>
      <div className="mt-5 flex gap-3 rounded-card border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" role="note">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
        <p>
          <strong>Versión propuesta, pendiente de validación legal.</strong> Describe el funcionamiento actual de la plataforma. Los datos marcados como
          «PENDIENTE» todavía no están definidos. Última actualización: {updated}.
        </p>
      </div>
      <div className="legal-doc mt-8 space-y-8 text-[15px] leading-relaxed text-slate-700 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:text-ink [&_li]:ml-5 [&_li]:list-disc [&_p+p]:mt-3 [&_ul]:mt-2 [&_ul]:space-y-1">
        {children}
      </div>
    </div>
  );
}

const UPDATED = '25/09/2026';

// ================================================================================ Términos y condiciones
export function TermsPage() {
  const legal = useLegal();
  return (
    <LegalDocument title="Términos y condiciones" description="Condiciones de uso de la plataforma BusPerú." updated={UPDATED}>
      <section>
        <h2>1. Quiénes somos</h2>
        <p>
          BusPerú es una plataforma en línea operada por <ProviderValue value={legal?.business_name} label="razón social" />, con RUC{' '}
          <ProviderValue value={legal?.ruc} label="RUC" /> y domicilio en <ProviderValue value={legal?.address} label="domicilio" />. Contacto:{' '}
          <ProviderValue value={legal?.email} label="correo de contacto" />.
        </p>
      </section>
      <section>
        <h2>2. Qué hace BusPerú y qué hace la empresa de transporte</h2>
        <p>
          BusPerú permite buscar, reservar y pagar pasajes de bus interprovincial <strong>ofrecidos por empresas de transporte</strong> registradas y
          verificadas en la plataforma. <strong>BusPerú no presta el servicio de transporte</strong>: lo presta la empresa indicada en cada viaje, que
          publica sus rutas, horarios, buses, precios y asientos, y es responsable de ejecutar el viaje conforme a la normativa de transporte aplicable.
        </p>
        <p>BusPerú es responsable de la plataforma, del proceso de reserva y pago, y de la atención de consultas, reclamos y quejas sobre ese proceso.</p>
        <p>
          <Pending>alcance de la responsabilidad de BusPerú como intermediario frente al consumidor, a validar con asesoría legal (Código de Protección y Defensa del Consumidor, Ley 29571)</Pending>
        </p>
      </section>
      <section>
        <h2>3. Cuenta de usuario</h2>
        <ul>
          <li>Puedes registrarte con tu correo y una contraseña, o con tu cuenta de Google o Microsoft.</li>
          <li>Eres responsable de mantener la confidencialidad de tu contraseña. Tu contraseña se guarda cifrada con un algoritmo de un solo sentido: nadie en BusPerú puede leerla.</li>
          <li>BusPerú puede suspender una cuenta ante indicios de fraude, suplantación o uso contrario a estos términos. Suspender una cuenta cierra sus sesiones abiertas.</li>
        </ul>
      </section>
      <section>
        <h2>4. Búsqueda y disponibilidad</h2>
        <p>
          Los viajes, horarios, precios y asientos los publica cada empresa y pueden cambiar. La disponibilidad se confirma al reservar: dos personas
          no pueden reservar el mismo asiento.
        </p>
      </section>
      <section>
        <h2>5. Reservas, precio y pago</h2>
        <ul>
          <li>Al reservar eliges tus asientos y registras los datos de los pasajeros.</li>
          <li>Antes de pagar ves el precio de los asientos, los descuentos aplicables y el cargo por servicio de la plataforma.</li>
          <li>Una reserva sin pagar retiene los asientos por un tiempo limitado; si no se paga a tiempo, vence y los asientos se liberan. Ver <Link to="/reservas-y-cancelaciones" className="text-brand-600 underline">Reservas y cancelaciones</Link>.</li>
          <li>Medios de pago y cómo se confirma cada uno: ver <Link to="/pagos" className="text-brand-600 underline">Información de pagos</Link>.</li>
          <li>La reserva queda confirmada cuando el pago se confirma. Recibirás tu código de reserva en la plataforma.</li>
        </ul>
      </section>
      <section>
        <h2>6. Cancelaciones y reembolsos</h2>
        <p>Se rigen por la <Link to="/reservas-y-cancelaciones" className="text-brand-600 underline">política de reservas y cancelaciones</Link>, que describe las reglas que aplica hoy la plataforma.</p>
      </section>
      <section>
        <h2>7. Opiniones</h2>
        <p>Solo pueden opinar los pasajeros con una reserva confirmada o realizada. Las opiniones se moderan antes de publicarse y la empresa puede responderlas. Una empresa no puede crear opiniones en nombre de pasajeros.</p>
      </section>
      <section>
        <h2>8. Uso indebido y fraude</h2>
        <ul>
          <li>No está permitido usar medios de pago ajenos sin autorización, suplantar a otra persona, automatizar reservas para acaparar asientos ni intentar acceder a datos de otros usuarios o empresas.</li>
          <li>BusPerú puede anular reservas asociadas a pagos fraudulentos y conservar la información necesaria para prevenir y denunciar el fraude.</li>
        </ul>
      </section>
      <section>
        <h2>9. Datos personales</h2>
        <p>El tratamiento de tus datos se describe en la <Link to="/privacidad" className="text-brand-600 underline">Política de privacidad</Link>.</p>
      </section>
      <section>
        <h2>10. Soporte, reclamos y quejas</h2>
        <p>
          Puedes pedir ayuda desde <Link to="/customer/support" className="text-brand-600 underline">soporte</Link> o registrar un reclamo o una queja en el{' '}
          <Link to="/libro-de-reclamaciones" className="text-brand-600 underline">Libro de Reclamaciones</Link>. Presentar un reclamo no te impide acudir a
          otras vías de solución de controversias ni es requisito previo para denunciar ante el INDECOPI.
        </p>
      </section>
      <section>
        <h2>11. Propiedad intelectual</h2>
        <p>La marca, el diseño y el software de BusPerú pertenecen a su titular. Los nombres, logotipos y contenidos de cada empresa de transporte pertenecen a esa empresa, que declara tener derecho a publicarlos.</p>
      </section>
      <section>
        <h2>12. Cambios en estos términos</h2>
        <p>Si estos términos cambian, publicaremos la nueva versión con su fecha. Las reservas ya confirmadas se rigen por los términos vigentes al momento de la compra.</p>
      </section>
      <section>
        <h2>13. Ley aplicable</h2>
        <p>
          Estos términos se rigen por las leyes de la República del Perú, sin perjuicio de los derechos que te reconoce el Código de Protección y Defensa del Consumidor (Ley 29571).{' '}
          <Pending>jurisdicción competente</Pending>
        </p>
      </section>
    </LegalDocument>
  );
}

// ================================================================================ Privacidad
export function PrivacyPage() {
  const legal = useLegal();
  return (
    <LegalDocument title="Política de privacidad" description="Cómo trata BusPerú tus datos personales (Ley 29733 y su Reglamento, DS 016-2024-JUS)." updated={UPDATED}>
      <section>
        <h2>1. Responsable del tratamiento</h2>
        <p>
          <ProviderValue value={legal?.business_name} label="razón social" />, RUC <ProviderValue value={legal?.ruc} label="RUC" />, con domicilio en{' '}
          <ProviderValue value={legal?.address} label="domicilio" />. Para cualquier asunto sobre tus datos: <ProviderValue value={legal?.email} label="correo de datos personales" />.
        </p>
        <p><Pending>inscripción del banco de datos en el Registro Nacional de Protección de Datos Personales</Pending></p>
      </section>
      <section>
        <h2>2. Qué datos tratamos</h2>
        <ul>
          <li><strong>Cuenta:</strong> nombres, apellidos, correo, teléfono y la contraseña cifrada. Si entras con Google o Microsoft, el identificador y el correo que ese proveedor nos entrega.</li>
          <li><strong>Reservas:</strong> viaje, asientos, importes y, por cada pasajero, nombre y documento de identidad; y los datos de contacto de la reserva.</li>
          <li><strong>Pagos:</strong> medio de pago, importe y estado. <strong>No recibimos ni guardamos los datos de tu tarjeta</strong>: los procesa Culqi en su propia ventana y solo recibimos un token de un solo uso.</li>
          <li><strong>Soporte, opiniones y Libro de Reclamaciones:</strong> lo que escribas y los datos que exige la hoja de reclamación.</li>
          <li><strong>Datos técnicos:</strong> dirección IP y registros de actividad para seguridad y auditoría.</li>
        </ul>
      </section>
      <section>
        <h2>3. Para qué los usamos</h2>
        <ul>
          <li>Crear y gestionar tu cuenta.</li>
          <li>Gestionar tus reservas, pagos, cancelaciones y reembolsos.</li>
          <li>Entregar a la empresa de transporte los datos de los pasajeros que necesita para prestar el viaje.</li>
          <li>Enviarte avisos sobre tus reservas (por ejemplo, un viaje cancelado).</li>
          <li>Atender soporte, reclamos y quejas.</li>
          <li>Prevenir el fraude y proteger la plataforma.</li>
          <li>Cumplir obligaciones legales.</li>
        </ul>
        <p><Pending>base legal de cada finalidad y tratamiento de comunicaciones comerciales, a validar con asesoría legal</Pending></p>
      </section>
      <section>
        <h2>4. Con quién los compartimos</h2>
        <ul>
          <li><strong>La empresa de transporte</strong> de tu viaje: los datos de la reserva y de los pasajeros.</li>
          <li><strong>Culqi:</strong> procesa los pagos con tarjeta.</li>
          <li><strong>Amazon Web Services:</strong> aloja la plataforma en su región de São Paulo (Brasil), lo que constituye un flujo transfronterizo de datos.</li>
          <li><strong>Proveedor de correo electrónico:</strong> envía los correos de la plataforma. <Pending>proveedor y país definitivos</Pending></li>
          <li><strong>Google o Microsoft:</strong> solo si eliges iniciar sesión con ellos.</li>
        </ul>
        <p>No vendemos tus datos.</p>
      </section>
      <section>
        <h2>5. Cuánto tiempo los conservamos</h2>
        <ul>
          <li>Las hojas del Libro de Reclamaciones: al menos dos (2) años desde su registro (DS 011-2011-PCM, art. 12).</li>
          <li>Reservas y pagos: <Pending>plazo según obligaciones tributarias y contables</Pending></li>
          <li>Datos de la cuenta: mientras la cuenta esté activa. <Pending>plazo tras la baja</Pending></li>
        </ul>
      </section>
      <section>
        <h2>6. Tus derechos</h2>
        <p>
          Puedes ejercer tus derechos de acceso, rectificación, cancelación y oposición, y los demás que reconoce la Ley 29733 y su Reglamento
          (DS 016-2024-JUS), escribiendo a <ProviderValue value={legal?.email} label="correo de datos personales" />. Si no recibes respuesta en el plazo legal,
          puedes acudir a la Autoridad Nacional de Protección de Datos Personales.
        </p>
      </section>
      <section>
        <h2>7. Cómo los protegemos</h2>
        <ul>
          <li>Conexiones cifradas (HTTPS).</li>
          <li>Contraseñas guardadas con un algoritmo de un solo sentido.</li>
          <li>Datos bancarios de las empresas cifrados.</li>
          <li>Acceso limitado por rol: cada empresa solo ve lo suyo.</li>
          <li>Registro de auditoría de las operaciones sensibles.</li>
        </ul>
        <p>Si ocurriera un incidente de seguridad que afecte tus datos, lo comunicaremos conforme exige el Reglamento.</p>
      </section>
      <section>
        <h2>8. Cookies y almacenamiento en tu navegador</h2>
        <p>Ver la <Link to="/cookies" className="text-brand-600 underline">Política de cookies</Link>.</p>
      </section>
    </LegalDocument>
  );
}

// ================================================================================ Cookies
export function CookiesPage() {
  return (
    <LegalDocument title="Política de cookies" description="Qué guarda BusPerú en tu navegador y qué servicios de terceros se cargan." updated={UPDATED}>
      <section>
        <h2>1. BusPerú no usa cookies propias</h2>
        <p>La plataforma no crea cookies propias ni utiliza herramientas de analítica o publicidad.</p>
        <p>Para funcionar, guarda en tu navegador (almacenamiento local, no cookies) únicamente:</p>
        <ul>
          <li><strong>Tu sesión:</strong> un identificador de sesión mientras tienes la sesión iniciada. Se borra al cerrar sesión.</li>
          <li><strong>La reserva en curso:</strong> los asientos y datos que vas eligiendo durante la compra, para no perderlos si recargas la página. Se borra al terminar o cerrar la pestaña.</li>
        </ul>
        <p>Ambos son necesarios para el servicio que pides y no se usan para rastrearte.</p>
      </section>
      <section>
        <h2>2. Servicios de terceros que se cargan en la página</h2>
        <ul>
          <li><strong>Culqi</strong> (pago con tarjeta): su ventana de pago se abre solo cuando pagas con tarjeta y puede usar sus propias cookies. Consulta la política de Culqi.</li>
          <li><strong>Google Fonts</strong> (tipografía): tu navegador descarga la fuente desde servidores de Google, que reciben tu dirección IP.</li>
          <li><strong>Wikimedia Commons</strong> (fotografías de destinos): las imágenes se descargan desde sus servidores, que reciben tu dirección IP.</li>
          <li><strong>OpenStreetMap</strong> (mapas de agencias): el mapa solo se carga cuando pulsas «Ver en mapa».</li>
        </ul>
      </section>
      <section>
        <h2>3. Cómo controlarlo</h2>
        <p>Puedes borrar el almacenamiento del sitio desde la configuración de tu navegador. Si lo haces, tendrás que volver a iniciar sesión.</p>
      </section>
    </LegalDocument>
  );
}

// ================================================================================ Reservas y cancelaciones
export function BookingPolicyPage() {
  const settings = useAsync(() => publicService.settings(), []).data as Record<string, unknown> | null;
  const hold = settings && typeof settings['booking.hold_minutes'] === 'number' ? Number(settings['booking.hold_minutes']) : null;
  const hours = settings && typeof settings['booking.cancellation_hours'] === 'number' ? Number(settings['booking.cancellation_hours']) : null;
  return (
    <LegalDocument title="Política de reservas y cancelaciones" description="Cómo funcionan hoy las reservas, cancelaciones y reembolsos en BusPerú." updated={UPDATED}>
      <section>
        <h2>1. Estados de una reserva</h2>
        <ul>
          <li><strong>Pendiente:</strong> los asientos quedan retenidos mientras completas el pago.</li>
          <li><strong>Confirmada:</strong> el pago se confirmó.</li>
          <li><strong>Vencida:</strong> no se pagó a tiempo y los asientos se liberaron.</li>
          <li><strong>Cancelada:</strong> la cancelaste tú o se canceló el viaje.</li>
          <li><strong>Completada:</strong> el viaje ya se realizó.</li>
        </ul>
      </section>
      <section>
        <h2>2. Tiempo para pagar</h2>
        <p>
          Una reserva pendiente retiene los asientos durante {hold ? <strong>{hold} minutos</strong> : 'el tiempo indicado al reservar'}. Si no se paga en ese plazo, vence
          automáticamente y los asientos vuelven a estar disponibles. Si el pago está en verificación (medios distintos de tarjeta), se revisa antes de confirmar.
        </p>
      </section>
      <section>
        <h2>3. Cancelar una reserva</h2>
        <ul>
          <li>
            Puedes cancelar desde «Mis viajes» hasta <strong>{hours ?? 24} horas antes de la salida</strong>. Si la reserva estaba pagada, se genera una solicitud de
            reembolso por el importe pagado que no haya sido reembolsado antes.
          </li>
          <li>Con {hours ?? 24} horas o menos para la salida, o si el viaje ya está en curso o se realizó, la cancelación no está disponible en la plataforma.</li>
          <li>
            <strong>Si la empresa cancela el viaje</strong>, se cancelan todas sus reservas: las pagadas generan su reembolso y las pendientes no generan cobro.
            Te avisaremos por la plataforma y por correo.
          </li>
        </ul>
      </section>
      <section>
        <h2>4. Reembolsos</h2>
        <p>
          La solicitud de reembolso se crea al cancelar y se procesa después. En pagos con tarjeta, la devolución se realiza a través de Culqi al mismo medio de pago.
          <Pending>plazo de procesamiento de reembolsos y tratamiento del cargo por servicio</Pending>
        </p>
      </section>
      <section>
        <h2>5. Cambios de fecha y reglas propias de cada empresa</h2>
        <p>
          La plataforma no ofrece por ahora cambios de fecha ni aplica reglas distintas por empresa: las reglas anteriores son las mismas para todas.{' '}
          <Pending>política de cambios, no presentación al embarque y equipaje, a definir con las empresas</Pending>
        </p>
      </section>
    </LegalDocument>
  );
}

// ================================================================================ Pagos
export function PaymentsInfoPage() {
  return (
    <LegalDocument title="Información de pagos" description="Medios de pago disponibles en BusPerú y cómo se confirma cada uno." updated={UPDATED}>
      <section>
        <h2>1. Tarjeta de crédito o débito</h2>
        <p>
          El pago con tarjeta se procesa con <strong>Culqi</strong>. Los datos de tu tarjeta se ingresan en la ventana de Culqi y <strong>no pasan por BusPerú</strong>.
          Si el pago se aprueba, la reserva se confirma al instante.
        </p>
      </section>
      <section>
        <h2>2. Yape, Plin, transferencia bancaria o efectivo</h2>
        <p>
          El pago se registra como <strong>pendiente de verificación</strong>. El equipo de BusPerú o la empresa de transporte comprueba que el dinero llegó y
          entonces confirma la reserva. Mientras tanto, la reserva no está confirmada.
        </p>
        <p><Pending>cuentas, números y puntos de pago autorizados para cada medio</Pending></p>
      </section>
      <section>
        <h2>3. Moneda, cargos y comprobantes</h2>
        <p>
          Los precios se muestran en soles (PEN). Antes de pagar ves el precio de los asientos, los descuentos y el cargo por servicio de la plataforma.{' '}
          <Pending>emisión de comprobantes de pago electrónicos</Pending>
        </p>
      </section>
    </LegalDocument>
  );
}

// ================================================================================ Libro de Reclamaciones
const EMPTY_FORM: ComplaintForm = {
  kind: 'RECLAMO',
  consumer_name: '',
  consumer_document_type: 'DNI',
  consumer_document_number: '',
  consumer_address: '',
  consumer_phone: '',
  consumer_email: '',
  is_minor: false,
  guardian_name: '',
  guardian_address: '',
  guardian_phone: '',
  guardian_email: '',
  item_type: 'SERVICIO',
  item_description: '',
  claimed_amount: null,
  booking_code: '',
  company_id: null,
  detail: '',
  request: '',
  accepted: false,
};

export function ComplaintBookPage() {
  usePageMeta({ title: 'Libro de Reclamaciones | BusPerú', description: 'Registra un reclamo o una queja y consulta su estado en el Libro de Reclamaciones virtual de BusPerú.' });
  const legal = useLegal();
  const companies = useAsync(() => publicService.companies(), []);
  const [form, setForm] = useState<ComplaintForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [receipt, setReceipt] = useState<ComplaintReceipt | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const set = <K extends keyof ComplaintForm>(key: K, value: ComplaintForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const text = (key: keyof ComplaintForm) => ({
    value: String(form[key] ?? ''),
    error: errors[key as string],
    onChange: (event: { target: { value: string } }) => set(key, event.target.value as never),
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    setErrors({});
    const blank = (value: string | null | undefined) => (value && value.trim() !== '' ? value.trim() : null);
    try {
      const body: ComplaintForm = {
        ...form,
        guardian_name: form.is_minor ? blank(form.guardian_name) : null,
        guardian_address: form.is_minor ? blank(form.guardian_address) : null,
        guardian_phone: form.is_minor ? blank(form.guardian_phone) : null,
        guardian_email: form.is_minor ? blank(form.guardian_email) : null,
        booking_code: blank(form.booking_code),
        claimed_amount: form.claimed_amount === null || Number.isNaN(Number(form.claimed_amount)) ? null : Number(form.claimed_amount),
      };
      setReceipt(await complaintService.create(body));
      setForm(EMPTY_FORM);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      if (error instanceof ApiError) {
        setErrors((error.fields as Record<string, string>) ?? {});
        setFailure(error.message);
      } else setFailure('No se pudo registrar la hoja. Inténtalo de nuevo.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:py-14">
      <nav aria-label="Ruta" className="text-sm text-muted">
        <Link to="/informacion" className="hover:text-brand-600">Información útil</Link> <span aria-hidden>/</span> Libro de Reclamaciones
      </nav>
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <span className="flex h-14 w-14 items-center justify-center rounded-xl bg-brand-500 text-white" aria-hidden><BookOpen className="h-7 w-7" /></span>
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">Libro de Reclamaciones</h1>
          <p className="text-slate-600">Conforme al Código de Protección y Defensa del Consumidor, BusPerú cuenta con un Libro de Reclamaciones virtual a tu disposición.</p>
        </div>
      </div>

      {receipt ? (
        <Card className="mt-8">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-success-600" aria-hidden />
            <div>
              <h2 className="text-xl font-bold text-ink">Hoja registrada: {receipt.code}</h2>
              <p className="mt-1 text-sm text-slate-600">
                Fecha límite de respuesta: <strong>{formatDate(receipt.due_date)}</strong> (15 días hábiles).{' '}
                {receipt.copy_emailed ? 'Te enviamos una copia a tu correo.' : 'No pudimos enviar la copia por correo: imprímela o guarda el código.'}
              </p>
            </div>
          </div>
          <pre className="mt-5 max-h-[480px] overflow-auto whitespace-pre-wrap rounded-control bg-slate-50 p-4 font-sans text-sm text-slate-700 ring-1 ring-black/5">{receipt.sheet}</pre>
          <div className="mt-4 flex flex-wrap gap-2 print:hidden">
            <Button icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>Imprimir hoja</Button>
            <Button variant="outline" onClick={() => setReceipt(null)}>Registrar otra hoja</Button>
          </div>
        </Card>
      ) : (
        <form onSubmit={(event) => void submit(event)} className="mt-8 space-y-6" noValidate>
          <Card>
            <h2 className="text-lg font-bold text-ink">Proveedor</h2>
            <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
              <div><dt className="text-muted">Razón social</dt><dd><ProviderValue value={legal?.business_name} label="razón social" /></dd></div>
              <div><dt className="text-muted">RUC</dt><dd><ProviderValue value={legal?.ruc} label="RUC" /></dd></div>
              <div><dt className="text-muted">Domicilio</dt><dd><ProviderValue value={legal?.address} label="domicilio" /></dd></div>
            </dl>
          </Card>

          <Card>
            <h2 className="text-lg font-bold text-ink">1. Identificación del consumidor reclamante</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Input label="Nombres y apellidos" required autoComplete="name" {...text('consumer_name')} />
              <div className="grid grid-cols-[130px_1fr] gap-2">
                <Select
                  label="Documento"
                  value={form.consumer_document_type}
                  onChange={(event) => set('consumer_document_type', event.target.value as ComplaintForm['consumer_document_type'])}
                  options={[{ value: 'DNI', label: 'DNI' }, { value: 'CE', label: 'C. E.' }, { value: 'PASAPORTE', label: 'Pasaporte' }, { value: 'RUC', label: 'RUC' }, { value: 'OTRO', label: 'Otro' }]}
                />
                <Input label="Número" required {...text('consumer_document_number')} />
              </div>
              <Input label="Domicilio" required autoComplete="street-address" {...text('consumer_address')} containerClassName="sm:col-span-2" />
              <Input label="Teléfono" required type="tel" autoComplete="tel" {...text('consumer_phone')} />
              <Input label="Correo electrónico" required type="email" autoComplete="email" hint="Te enviaremos aquí la copia de la hoja y la respuesta." {...text('consumer_email')} />
            </div>
            <div className="mt-4">
              <Checkbox label="El consumidor es menor de edad" checked={form.is_minor} onChange={(event) => set('is_minor', event.target.checked)} />
            </div>
            {form.is_minor && (
              <div className="mt-4 grid gap-4 rounded-control bg-slate-50 p-4 sm:grid-cols-2">
                <Input label="Nombre del padre, madre o representante" required {...text('guardian_name')} />
                <Input label="Domicilio" required {...text('guardian_address')} />
                <Input label="Teléfono" required type="tel" {...text('guardian_phone')} />
                <Input label="Correo electrónico" required type="email" {...text('guardian_email')} />
              </div>
            )}
          </Card>

          <Card>
            <h2 className="text-lg font-bold text-ink">2. Identificación del bien contratado</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Select
                label="Tipo"
                value={form.item_type}
                onChange={(event) => set('item_type', event.target.value as ComplaintForm['item_type'])}
                options={[{ value: 'SERVICIO', label: 'Servicio' }, { value: 'PRODUCTO', label: 'Producto' }]}
              />
              <Input
                label="Monto reclamado (S/)"
                type="number"
                min={0}
                step="0.01"
                value={form.claimed_amount === null ? '' : String(form.claimed_amount)}
                error={errors.claimed_amount}
                onChange={(event) => set('claimed_amount', event.target.value === '' ? null : Number(event.target.value))}
              />
              <Textarea label="Descripción" required rows={2} {...text('item_description')} containerClassName="sm:col-span-2" placeholder="Ej.: pasaje Lima – Huánuco del 12/10/2026" />
              <Input label="Código de reserva (opcional)" {...text('booking_code')} hint="Si iniciaste sesión y la reserva es tuya, la hoja se relaciona con la empresa del viaje." />
              <Select
                label="Empresa de transporte relacionada (opcional)"
                value={form.company_id ? String(form.company_id) : ''}
                onChange={(event) => set('company_id', event.target.value ? Number(event.target.value) : null)}
                placeholder="Ninguna"
                options={(companies.data ?? []).map((company) => ({ value: String(company.id), label: company.name }))}
              />
            </div>
          </Card>

          <Card>
            <h2 className="text-lg font-bold text-ink">3. Detalle de la reclamación y pedido del consumidor</h2>
            <fieldset className="mt-4">
              <legend className="text-sm font-medium text-ink">Tipo</legend>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                {([
                  ['RECLAMO', 'Reclamo', 'Disconformidad relacionada a los productos o servicios.'],
                  ['QUEJA', 'Queja', 'Disconformidad no relacionada a los productos o servicios, o malestar o descontento respecto a la atención al público.'],
                ] as const).map(([value, label, hint]) => (
                  <label key={value} className={`cursor-pointer rounded-control p-4 ring-1 ${form.kind === value ? 'bg-brand-50 ring-brand-400' : 'ring-border'}`}>
                    <input type="radio" name="kind" value={value} checked={form.kind === value} onChange={() => set('kind', value)} className="mr-2" />
                    <strong>{label}</strong>
                    <span className="mt-1 block text-xs text-muted">{hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="mt-4 grid gap-4">
              <Textarea label="Detalle" required rows={5} {...text('detail')} />
              <Textarea label="Pedido" required rows={3} {...text('request')} />
            </div>
          </Card>

          <Card>
            <Checkbox
              label="Declaro que los datos consignados son correctos y estoy conforme con el contenido de esta hoja (reemplaza la firma)."
              checked={form.accepted}
              onChange={(event) => set('accepted', event.target.checked)}
            />
            {errors.accepted && <p className="mt-1 text-sm text-danger-600">{errors.accepted}</p>}
            <p className="mt-4 text-xs text-muted">
              La formulación del reclamo no impide acudir a otras vías de solución de controversias ni es requisito previo para interponer una denuncia ante el
              INDECOPI. El proveedor deberá dar respuesta en un plazo no mayor a quince (15) días hábiles.
            </p>
            {failure && <p className="mt-3 rounded-control bg-danger-50 px-3 py-2 text-sm text-danger-700" role="alert">{failure}</p>}
            <Button type="submit" className="mt-4" loading={sending} disabled={!form.accepted}>Registrar hoja</Button>
          </Card>
        </form>
      )}

      <ComplaintLookupCard />
    </div>
  );
}

function ComplaintLookupCard() {
  const [code, setCode] = useState('');
  const [documentNumber, setDocumentNumber] = useState('');
  const [result, setResult] = useState<ComplaintLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const STATUS: Record<ComplaintLookup['status'], string> = { RECEIVED: 'Recibida', IN_REVIEW: 'En revisión', ANSWERED: 'Respondida', CLOSED: 'Cerrada' };

  const lookup = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await complaintService.lookup(code.trim().toUpperCase(), documentNumber.trim()));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo consultar.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="mt-8">
      <h2 className="flex items-center gap-2 text-lg font-bold text-ink"><Search className="h-5 w-5 text-brand-500" aria-hidden /> Consultar una hoja</h2>
      <form onSubmit={(event) => void lookup(event)} className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Input label="Código" placeholder="LR-2026-000001" value={code} onChange={(event) => setCode(event.target.value)} />
        <Input label="Número de documento" value={documentNumber} onChange={(event) => setDocumentNumber(event.target.value)} />
        <Button type="submit" loading={loading} disabled={!code || !documentNumber}>Consultar</Button>
      </form>
      {error && <p className="mt-3 text-sm text-danger-600" role="alert">{error}</p>}
      {result && (
        <div className="mt-4 rounded-control bg-slate-50 p-4 text-sm ring-1 ring-black/5">
          <p><strong>{result.code}</strong> · {result.kind === 'RECLAMO' ? 'Reclamo' : 'Queja'} · Estado: <strong>{STATUS[result.status]}</strong></p>
          <p className="mt-1 text-muted">Registrada el {formatDateTime(result.created_at)} · Fecha límite de respuesta: {formatDate(result.due_date)}</p>
          {result.response && (
            <div className="mt-3 border-t border-border pt-3">
              <p className="font-semibold text-ink">Respuesta ({result.response_at ? formatDateTime(result.response_at) : ''})</p>
              <p className="mt-1 whitespace-pre-line text-slate-700">{result.response}</p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
