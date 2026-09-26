import { Compass } from 'lucide-react';
import { Button } from '@/components/ui';
import { SiteContainer, SiteEmpty, useCompanySite } from '@/components/company-site/shared';
import { usePageMeta } from '@/hooks/usePageMeta';
import { companySitePath } from '@/utils/company-site';

/** F18-20 · sección inexistente dentro del sitio de una empresa (p. ej. `/empresas/x/galeria`: la galería está en Nosotros). */
export function CompanySiteNotFoundPage() {
  const { data, slug } = useCompanySite();
  usePageMeta({ title: `Página no encontrada | ${data.company.name}`, description: `Esta sección no existe en el sitio de ${data.company.name}.` });
  return (
    <SiteContainer className="py-16 sm:py-24">
      <SiteEmpty
        icon={<Compass className="h-7 w-7" />}
        title="Página no encontrada"
        description={`Esta sección no existe en el sitio de ${data.company.name}. Usa el menú para ver Nosotros (con la galería), Servicios, Agencias, Destinos, Flota, Opiniones o Contacto.`}
        action={<Button to={companySitePath(slug)}>Ir al inicio de {data.company.name}</Button>}
      />
    </SiteContainer>
  );
}
