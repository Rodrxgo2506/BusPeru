import { useState } from 'react';
import { ImageUploadField } from '@/components/common/ImageUploadField';
import { Card, CardHeader, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import { useBranding } from '@/context/BrandingContext';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { brandingService } from '@/services';
import { ApiError, mediaUrl } from '@/services/api';
import type { BrandingAsset } from '@/types';

/**
 * Configuración › Identidad visual (FASE 17). Logo, favicon, logo móvil e imagen Open Graph.
 *
 * Cada pieza se sube con el almacén seguro compartido y se guarda como referencia en
 * `system_settings`. Al guardar se aplica en caliente (logo y favicon) sin recargar ni reconstruir.
 */

const ASSETS: Array<{ asset: BrandingAsset; title: string; description: string; hint: string; accept?: string; maxBytes?: number }> = [
  {
    asset: 'logo',
    title: 'Logo principal',
    description: 'Cabecera y pie de la web, pantallas de acceso y paneles.',
    hint: 'PNG o WebP con fondo transparente · máx. 5 MB · alto recomendado 80 px.',
  },
  {
    asset: 'logo_mobile',
    title: 'Logo móvil',
    description: 'Versión compacta para pantallas pequeñas. Si no hay, se usa el principal.',
    hint: 'PNG o WebP · máx. 5 MB.',
  },
  {
    asset: 'favicon',
    title: 'Favicon',
    description: 'Icono de la pestaña del navegador.',
    hint: 'PNG o ICO cuadrado (48×48 o mayor) · máx. 512 KB.',
    accept: 'image/png,image/x-icon,.ico',
    maxBytes: 512 * 1024,
  },
  {
    asset: 'og_image',
    title: 'Imagen Open Graph',
    description: 'Vista previa al compartir enlaces. Algunos servicios que no ejecutan JavaScript pueden no leerla.',
    hint: 'JPG o PNG · 1200×630 px · máx. 5 MB.',
  },
];

export function BrandingPage() {
  const toast = useToast();
  const { apply } = useBranding();
  const branding = useAsync(() => brandingService.get(), []);
  const [busy, setBusy] = useState<BrandingAsset | null>(null);

  const run = async (asset: BrandingAsset, action: () => ReturnType<typeof brandingService.get>, success: string) => {
    setBusy(asset);
    try {
      const references = await action();
      branding.setData(references);
      apply(references);
      toast.success(success);
    } catch (error) {
      toast.error('No se pudo guardar', error instanceof ApiError ? error.message : undefined);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Identidad visual"
        description="Logo, favicon e imagen para compartir. Los cambios se ven en la web sin reconstruir la aplicación."
        breadcrumbs={[{ label: 'Configuración' }, { label: 'Identidad visual' }]}
      />
      {branding.loading ? (
        <LoadingState className="min-h-[60vh]" />
      ) : branding.error || !branding.data ? (
        <Card padded={false}>
          <ErrorState error={branding.error} onRetry={branding.reload} />
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {ASSETS.map((item) => (
            <Card key={item.asset}>
              <CardHeader title={item.title} description={item.description} />
              <ImageUploadField
                label={item.title}
                hint={item.hint}
                accept={item.accept}
                maxBytes={item.maxBytes}
                currentUrl={mediaUrl(branding.data?.[item.asset])}
                busy={busy === item.asset}
                onSelect={(file) => void run(item.asset, () => brandingService.upload(item.asset, file), `${item.title} actualizado.`)}
                onRemove={() => void run(item.asset, () => brandingService.remove(item.asset), `${item.title} quitado.`)}
              />
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
