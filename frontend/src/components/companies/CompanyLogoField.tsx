import { useState } from 'react';
import { ImageUploadField } from '@/components/common/ImageUploadField';
import { CardHeader, ErrorState } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { companyLogoService } from '@/services';
import { ApiError, mediaUrl } from '@/services/api';
import type { CompanyLogo } from '@/types';

/**
 * Logotipo de una empresa: subir, reemplazar y quitar (F17C-COMPANY-LOGO-01 y -02).
 *
 * Una sola pieza para los dos paneles. El Portal Empresa la usa sin `companyId` —la API resuelve la
 * empresa desde la sesión— y el panel ADMIN le pasa la empresa que está editando. La diferencia
 * empieza y acaba en ese parámetro: la validación, los límites y el borrado del archivo anterior
 * viven en el backend, iguales para ambos.
 *
 * No trae tarjeta propia a propósito: cada panel la envuelve como le corresponde.
 */
export function CompanyLogoField({ companyId, description }: { companyId?: number; description: string }) {
  const toast = useToast();
  const logo = useAsync(() => companyLogoService.get(companyId), [companyId]);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<CompanyLogo>, success: string) => {
    setBusy(true);
    try {
      logo.setData(await action());
      toast.success(success);
    } catch (error) {
      toast.error('No se pudo guardar el logotipo', error instanceof ApiError ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <CardHeader title="Logo de empresa" description={description} />
      {logo.error ? (
        <ErrorState error={logo.error} onRetry={logo.reload} />
      ) : (
        <ImageUploadField
          label="Logotipo"
          hint="JPG, PNG o WebP · máx. 2 MB · se recomienda fondo transparente y formato horizontal."
          layout="stacked"
          previewClassName="h-32 max-w-sm"
          currentUrl={mediaUrl(logo.data?.logo_url)}
          busy={busy || logo.loading}
          onSelect={(file) => void run(() => companyLogoService.upload(file, companyId), 'Logotipo actualizado.')}
          onRemove={logo.data?.logo_url ? () => void run(() => companyLogoService.remove(companyId), 'Logotipo retirado.') : undefined}
        />
      )}
    </>
  );
}
