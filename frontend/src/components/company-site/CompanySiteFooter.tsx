import { Building2, Mail, MapPin, MessageCircle, Phone } from 'lucide-react';
import { Link } from 'react-router-dom';
import { mediaUrl } from '@/services/api';
import type { PublicCompanyProfile } from '@/types/company-profile';
import { telUrl, whatsappUrl } from '@/utils/company-profile';
import { companySiteNav } from '@/utils/company-site';
import { companySocials, SocialLinks } from './shared';

/**
 * F18-20 · pie corporativo del sitio de la empresa, igual en todas sus páginas. Solo muestra lo que la empresa
 * configuró (nada inventado). Debajo sigue el pie global de BusPerú, con el Libro de Reclamaciones y los legales.
 */
export function CompanySiteFooter({ data, slug }: { data: PublicCompanyProfile; slug: string }) {
  const { company, profile } = data;
  const logo = mediaUrl(company.logo_url);
  const socials = companySocials(data);
  const tel = profile.contact_phone ? telUrl(profile.contact_phone) : null;
  const wa = profile.contact_whatsapp ? whatsappUrl(profile.contact_whatsapp) : null;
  const hasContact = Boolean(tel || wa || profile.contact_email || profile.main_address);

  return (
    <footer className="border-t border-white/10 bg-ink text-slate-300" aria-label={`Pie de página de ${company.name}`}>
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-2 lg:grid-cols-[1.3fr_1fr_1.2fr] lg:px-8">
        <div>
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white">
              {logo ? <img src={logo} alt="" className="max-h-full max-w-full object-contain p-1.5" loading="lazy" /> : <Building2 className="h-6 w-6 text-brand-500" aria-hidden />}
            </span>
            <p className="text-lg font-extrabold text-white">{company.name}</p>
          </div>
          {profile.tagline && <p className="mt-4 max-w-sm text-sm leading-relaxed text-slate-400">{profile.tagline}</p>}
          <SocialLinks socials={socials} tone="dark" className="mt-5" />
        </div>

        <div>
          <h2 className="text-xs font-bold uppercase tracking-[0.18em] text-white">Secciones</h2>
          <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {companySiteNav(slug).map((item) => (
              <li key={item.id}>
                <Link to={item.to} className="transition hover:text-brand-300 focus:outline-none focus-visible:underline">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h2 className="text-xs font-bold uppercase tracking-[0.18em] text-white">Contacto</h2>
          {hasContact ? (
            <ul className="mt-4 space-y-3 text-sm">
              {tel && (
                <li className="flex items-start gap-2.5">
                  <Phone className="mt-0.5 h-4 w-4 shrink-0 text-brand-400" aria-hidden />
                  <a href={tel} className="hover:text-white">{profile.contact_phone}</a>
                </li>
              )}
              {wa && (
                <li className="flex items-start gap-2.5">
                  <MessageCircle className="mt-0.5 h-4 w-4 shrink-0 text-brand-400" aria-hidden />
                  <a href={wa} target="_blank" rel="noopener noreferrer" className="hover:text-white">WhatsApp {profile.contact_whatsapp}</a>
                </li>
              )}
              {profile.contact_email && (
                <li className="flex items-start gap-2.5">
                  <Mail className="mt-0.5 h-4 w-4 shrink-0 text-brand-400" aria-hidden />
                  <a href={`mailto:${profile.contact_email}`} className="break-all hover:text-white">{profile.contact_email}</a>
                </li>
              )}
              {profile.main_address && (
                <li className="flex items-start gap-2.5">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-brand-400" aria-hidden />
                  <span>{profile.main_address}</span>
                </li>
              )}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-slate-400">La empresa aún no ha publicado sus datos de contacto.</p>
          )}
        </div>
      </div>
      <div className="border-t border-white/10">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-4 text-xs text-slate-400 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <p>© {new Date().getFullYear()} {company.name} · Sitio de empresa publicado en BusPerú.</p>
          <Link to="/empresas" className="font-semibold text-slate-300 hover:text-white">Ver todas las empresas</Link>
        </div>
      </div>
    </footer>
  );
}
