import { Globe, Mail, MapPin, MessageCircle, Phone, PhoneOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CompanyContactForm, contactFormAvailable } from '@/components/company-site/CompanyContactForm';
import { CompanyPageHero } from '@/components/company-site/CompanyPageHero';
import { BlockHeading, companySocials, SiteContainer, SiteEmpty, SocialLinks, useCompanyPageMeta, useCompanySite } from '@/components/company-site/shared';
import { safeExternalUrl, telUrl, whatsappUrl } from '@/utils/company-profile';
import { companySitePath, heroImagePath } from '@/utils/company-site';

/**
 * F18-20 · Contacto: formulario «Contáctanos» (izquierda) y los canales publicados por la empresa (derecha). Solo
 * se muestra lo configurado; nunca datos inventados.
 */
export function CompanyContactPage() {
  const { data, slug } = useCompanySite();
  useCompanyPageMeta('contacto', data, slug);
  const { company, profile } = data;
  const socials = companySocials(data);
  const website = safeExternalUrl(profile.website_url);
  const tel = profile.contact_phone ? telUrl(profile.contact_phone) : null;
  const wa = profile.contact_whatsapp ? whatsappUrl(profile.contact_whatsapp) : null;

  const rows: Array<{ icon: ReactNode; label: string; value: ReactNode }> = [];
  if (profile.contact_phone) rows.push({ icon: <Phone className="h-5 w-5" />, label: 'Teléfono', value: tel ? <a href={tel} className="hover:text-brand-600 hover:underline">{profile.contact_phone}</a> : profile.contact_phone });
  if (wa) rows.push({ icon: <MessageCircle className="h-5 w-5" />, label: 'WhatsApp', value: <a href={wa} target="_blank" rel="noopener noreferrer" className="hover:text-brand-600 hover:underline">{profile.contact_whatsapp}</a> });
  if (profile.contact_email) rows.push({ icon: <Mail className="h-5 w-5" />, label: 'Correo electrónico', value: <a href={`mailto:${profile.contact_email}`} className="break-all hover:text-brand-600 hover:underline">{profile.contact_email}</a> });
  if (website) rows.push({ icon: <Globe className="h-5 w-5" />, label: 'Sitio web', value: <a href={website} target="_blank" rel="noopener noreferrer" className="break-all hover:text-brand-600 hover:underline">{new URL(website).host}</a> });
  if (profile.main_address) rows.push({ icon: <MapPin className="h-5 w-5" />, label: 'Dirección principal', value: profile.main_address });

  const form = contactFormAvailable(data);

  return (
    <>
      <CompanyPageHero
        image={heroImagePath('contacto', profile)}
        eyebrow={company.name}
        title="Contacto"
        subtitle="Escríbenos o llámanos: te ayudamos con tu viaje."
        breadcrumb={[{ label: 'Inicio', to: companySitePath(slug) }, { label: 'Contacto' }]}
      />
      <section className="py-14 sm:py-20" aria-label="Formas de contacto">
        <SiteContainer>
          {!form && rows.length === 0 && socials.length === 0 ? (
            <SiteEmpty
              icon={<PhoneOff className="h-7 w-7" />}
              title="Datos de contacto en preparación"
              description={`${company.name} aún no ha publicado sus canales de contacto.`}
              action={<Link to="/ayuda" className="font-semibold text-brand-600 hover:underline">Ir a la ayuda de BusPerú</Link>}
            />
          ) : (
            <div className={form ? 'grid gap-10 lg:grid-cols-[1.35fr_1fr] lg:gap-12' : 'mx-auto max-w-2xl'}>
              {form && (
                <div className="rounded-3xl bg-white p-6 shadow-elevated ring-1 ring-black/5 sm:p-8">
                  <BlockHeading eyebrow="Escríbenos" title="Contáctanos" />
                  <div className="mt-6">
                    <CompanyContactForm data={data} subject="Consulta" idPrefix="contacto" />
                  </div>
                </div>
              )}
              <div>
                <h2 className="text-xl font-extrabold text-ink">Información de contacto</h2>
                {rows.length > 0 ? (
                  <ul className="mt-5 space-y-3">
                    {rows.map((row) => (
                      <li key={row.label} className="flex items-start gap-4 rounded-2xl bg-slate-50 p-4 ring-1 ring-black/5">
                        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-500 text-white" aria-hidden>{row.icon}</span>
                        <div className="min-w-0">
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted">{row.label}</p>
                          <p className="mt-0.5 font-semibold text-ink">{row.value}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-4 text-sm text-muted">La empresa aún no ha publicado teléfono, correo ni dirección.</p>
                )}
                {socials.length > 0 && (
                  <div className="mt-8">
                    <h3 className="text-sm font-bold uppercase tracking-wide text-ink">Síguenos</h3>
                    <SocialLinks socials={socials} className="mt-3" />
                  </div>
                )}
                <p className="mt-8 text-sm text-slate-600">
                  ¿Un reclamo sobre una compra? Usa el <Link to="/libro-de-reclamaciones" className="font-semibold text-brand-600 hover:underline">Libro de Reclamaciones</Link> de BusPerú.
                </p>
              </div>
            </div>
          )}
        </SiteContainer>
      </section>
    </>
  );
}
