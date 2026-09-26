import { CheckCircle2, Mail, MessageCircle, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button, Input, Textarea } from '@/components/ui';
import type { PublicCompanyProfile } from '@/types/company-profile';
import { CONTACT_LIMITS, contactMailto, contactWhatsapp, isSafeEmail, validateContact, type ContactDraft, type ContactErrors } from '@/utils/company-site';

const EMPTY: ContactDraft = { name: '', phone: '', email: '', message: '' };

/** ¿Tiene la empresa algún canal al que el formulario pueda entregar el mensaje? */
export function contactFormAvailable(data: PublicCompanyProfile): boolean {
  return isSafeEmail(data.profile.contact_email) || Boolean(contactWhatsapp(data.profile.contact_whatsapp, EMPTY));
}

/**
 * F18-20 · formulario de contacto del sitio de empresa («¿Necesitas ayuda?» en Inicio, «Contáctanos» en Contacto).
 *
 * BusPerú no tiene (ni se crea en esta fase) un buzón de mensajes para empresas: el formulario valida y ENTREGA el
 * mensaje por el canal que la empresa publicó — abre el correo del visitante con el texto listo (`mailto:`) o
 * WhatsApp. No se guarda nada en BusPerú y así se le dice al visitante.
 */
export function CompanyContactForm({ data, subject, idPrefix }: { data: PublicCompanyProfile; subject: string; idPrefix: string }) {
  const [draft, setDraft] = useState<ContactDraft>(EMPTY);
  const [errors, setErrors] = useState<ContactErrors>({});
  const [sent, setSent] = useState<'email' | 'whatsapp' | null>(null);
  const email = isSafeEmail(data.profile.contact_email) ? data.profile.contact_email : null;
  const hasWhatsapp = Boolean(contactWhatsapp(data.profile.contact_whatsapp, EMPTY));

  const set = (field: keyof ContactDraft) => (value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }));
    setSent(null);
  };

  const check = (): boolean => {
    const found = validateContact(draft);
    setErrors(found);
    if (Object.keys(found).length) {
      const first = (['name', 'phone', 'email', 'message'] as const).find((field) => found[field]);
      if (first) document.getElementById(`${idPrefix}-${first}`)?.focus();
      return false;
    }
    return true;
  };

  const sendEmail = (event: FormEvent) => {
    event.preventDefault();
    if (!check()) return;
    const url = contactMailto(email, data.company.name, subject, draft);
    if (url) {
      window.location.href = url;
      setSent('email');
    } else if (hasWhatsapp) {
      sendWhatsapp();
    }
  };

  const sendWhatsapp = () => {
    if (!check()) return;
    const url = contactWhatsapp(data.profile.contact_whatsapp, draft);
    if (url) {
      window.open(url, '_blank', 'noopener,noreferrer');
      setSent('whatsapp');
    }
  };

  const errorCount = Object.values(errors).filter(Boolean).length;

  return (
    <form noValidate onSubmit={sendEmail} aria-describedby={`${idPrefix}-privacy`} className="space-y-4">
      {errorCount > 0 && (
        <p role="alert" className="rounded-control bg-danger-50 px-3 py-2 text-sm font-medium text-danger-700">
          Revisa {errorCount === 1 ? 'el campo marcado' : `los ${errorCount} campos marcados`} para poder enviar tu mensaje.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Input id={`${idPrefix}-name`} label="Nombre" required autoComplete="name" maxLength={CONTACT_LIMITS.name} value={draft.name} onChange={(e) => set('name')(e.target.value)} error={errors.name} />
        <Input id={`${idPrefix}-phone`} label="Teléfono" type="tel" inputMode="tel" autoComplete="tel" maxLength={CONTACT_LIMITS.phone} value={draft.phone} onChange={(e) => set('phone')(e.target.value)} error={errors.phone} />
      </div>
      <Input id={`${idPrefix}-email`} label="Correo electrónico" type="email" autoComplete="email" maxLength={CONTACT_LIMITS.email} value={draft.email} onChange={(e) => set('email')(e.target.value)} error={errors.email} hint="Indica tu correo o tu teléfono para que puedan responderte." />
      <Textarea id={`${idPrefix}-message`} label="Comentario" required rows={5} maxLength={CONTACT_LIMITS.messageMax} value={draft.message} onChange={(e) => set('message')(e.target.value)} error={errors.message} />

      <div className="flex flex-wrap gap-3">
        {email ? (
          <>
            <Button type="submit" icon={<Mail className="h-4 w-4" />}>Enviar</Button>
            {hasWhatsapp && (
              <Button type="button" variant="outline" icon={<MessageCircle className="h-4 w-4" />} onClick={sendWhatsapp}>
                Enviar por WhatsApp
              </Button>
            )}
          </>
        ) : (
          <Button type="submit" icon={<MessageCircle className="h-4 w-4" />}>Enviar por WhatsApp</Button>
        )}
      </div>

      {sent && (
        <p role="status" className="flex items-start gap-2 rounded-control bg-success-50 px-3 py-2 text-sm text-success-700">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {sent === 'email'
            ? `Abrimos tu aplicación de correo con el mensaje listo para ${data.company.name}. Si no se abrió, escríbeles a ${email}.`
            : `Abrimos WhatsApp con tu mensaje para ${data.company.name}.`}
        </p>
      )}
      <p id={`${idPrefix}-privacy`} className="flex items-start gap-2 text-xs text-muted">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" aria-hidden />
        Tu mensaje se envía directamente a {data.company.name} desde tu correo o tu WhatsApp. BusPerú no guarda este formulario.
      </p>
    </form>
  );
}
