import { MessageSquare, Percent, Star, TicketCheck } from 'lucide-react';
import { useState } from 'react';
import { ResourcePage } from '@/components/common/ResourcePage';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, FilterBar, Modal, PageHeader, SearchBar, Select, StatusBadge, TablePagination, TableSkeleton, Textarea, type Column } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { useAsync } from '@/hooks/useAsync';
import { useList } from '@/hooks/useList';
import { ApiError } from '@/services/api';
import { companyService, couponService, promotionService, reviewService } from '@/services';
import type { Coupon, Promotion, Review } from '@/types';
import { formatCurrency, formatDate, formatDateTime, formatNumber } from '@/utils/format';

export function PromotionsPage({ scope }: { scope: 'company' | 'admin' }) {
  const companies = useAsync(() => (scope === 'admin' ? companyService.list({ limit: 200 }) : Promise.resolve({ data: [] })), [scope]);

  const columns: Array<Column<Promotion>> = [
    {
      key: 'name',
      header: 'Promoción',
      sortColumn: 'p.name',
      render: (promotion) => (
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
            <Percent className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block font-semibold text-ink">{promotion.name}</span>
            <span className="block truncate text-xs text-muted">{promotion.description ?? '—'}</span>
          </span>
        </div>
      ),
    },
    {
      key: 'discount',
      header: 'Descuento',
      render: (promotion) => (
        <Badge tone="brand">
          {promotion.discount_type === 'PERCENTAGE' ? `${promotion.discount_value}%` : formatCurrency(promotion.discount_value)}
        </Badge>
      ),
    },
    {
      key: 'period',
      header: 'Vigencia',
      sortColumn: 'p.start_at',
      render: (promotion) => (
        <span className="text-sm text-slate-600">
          {formatDate(promotion.start_at)} — {formatDate(promotion.end_at)}
        </span>
      ),
      hideOnMobile: true,
    },
    { key: 'usage', header: 'Usos', render: (promotion) => `${formatNumber(promotion.usage_count)}${promotion.usage_limit ? ` / ${formatNumber(promotion.usage_limit)}` : ''}` },
    { key: 'coupons', header: 'Cupones', render: (promotion) => formatNumber(promotion.coupons_count ?? 0), hideOnMobile: true },
    ...(scope === 'admin' ? [{ key: 'company', header: 'Empresa', render: (promotion: Promotion) => promotion.company_name ?? 'BusPerú', hideOnMobile: true }] : []),
    { key: 'status', header: 'Estado', render: (promotion) => <StatusBadge status={promotion.status} /> },
  ];

  return (
    <ResourcePage<Promotion>
      title="Promociones"
      description="Crea y administra las campañas de descuento."
      breadcrumbs={[{ label: scope === 'company' ? 'Portal Empresa' : 'Administración' }, { label: 'Promociones' }]}
      loader={(params) => promotionService.list(params)}
      columns={columns}
      permissionModule="promotions"
      entityLabel="Promoción"
      entityGender="f"
      searchPlaceholder="Buscar por nombre o descripción..."
      filters={[
        {
          key: 'status',
          placeholder: 'Todos los estados',
          options: [
            { value: 'DRAFT', label: 'Borrador' },
            { value: 'ACTIVE', label: 'Activa' },
            { value: 'INACTIVE', label: 'Inactiva' },
            { value: 'EXPIRED', label: 'Expirada' },
          ],
        },
      ]}
      formFields={[
        ...(scope === 'admin'
          ? [
              {
                name: 'company_id',
                label: 'Empresa (opcional)',
                type: 'select' as const,
                options: (companies.data?.data ?? []).map((company) => ({ value: company.id, label: company.name })),
                hint: 'Déjalo vacío para una promoción global de BusPerú.',
              },
            ]
          : []),
        { name: 'name', label: 'Nombre', required: true, full: true, placeholder: 'Ej: ¡Viaja más, paga menos!' },
        { name: 'description', label: 'Descripción', type: 'textarea', placeholder: 'Hasta 30% de descuento en rutas seleccionadas' },
        {
          name: 'discount_type',
          label: 'Tipo de descuento',
          type: 'select',
          required: true,
          options: [
            { value: 'PERCENTAGE', label: 'Porcentaje (%)' },
            { value: 'FIXED_AMOUNT', label: 'Monto fijo (S/)' },
          ],
        },
        { name: 'discount_value', label: 'Valor del descuento', type: 'number', step: '0.01', required: true },
        { name: 'minimum_amount', label: 'Compra mínima (S/)', type: 'number', step: '0.01' },
        { name: 'maximum_discount', label: 'Descuento máximo (S/)', type: 'number', step: '0.01' },
        { name: 'start_at', label: 'Inicio', type: 'datetime-local', required: true },
        { name: 'end_at', label: 'Fin', type: 'datetime-local', required: true },
        { name: 'usage_limit', label: 'Límite de usos', type: 'number' },
        {
          name: 'status',
          label: 'Estado',
          type: 'select',
          options: [
            { value: 'DRAFT', label: 'Borrador' },
            { value: 'ACTIVE', label: 'Activa' },
            { value: 'INACTIVE', label: 'Inactiva' },
          ],
        },
      ]}
      onCreate={(values) => promotionService.create(values).then(() => undefined)}
      onUpdate={(id, values) => promotionService.update(id, values).then(() => undefined)}
      onDelete={(id) => promotionService.remove(id).then(() => undefined)}
      emptyTitle="No hay promociones creadas"
      emptyDescription="Crea una promoción para ofrecer descuentos a tus pasajeros."
    />
  );
}

export function CouponsPage() {
  const promotions = useAsync(() => promotionService.list({ limit: 200 }), []);

  const columns: Array<Column<Coupon>> = [
    {
      key: 'code',
      header: 'Cupón',
      sortColumn: 'c.code',
      render: (coupon) => (
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
            <TicketCheck className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block font-mono font-bold text-ink">{coupon.code}</span>
            <span className="block truncate text-xs text-muted">{coupon.promotion_name}</span>
          </span>
        </div>
      ),
    },
    {
      key: 'discount',
      header: 'Descuento',
      render: (coupon) =>
        coupon.discount_type ? (
          <Badge tone="brand">{coupon.discount_type === 'PERCENTAGE' ? `${coupon.discount_value}%` : formatCurrency(coupon.discount_value ?? 0)}</Badge>
        ) : (
          '—'
        ),
    },
    { key: 'usage', header: 'Usos', sortColumn: 'c.usage_count', render: (coupon) => `${formatNumber(coupon.usage_count)}${coupon.usage_limit ? ` / ${formatNumber(coupon.usage_limit)}` : ''}` },
    { key: 'per_user', header: 'Límite por usuario', render: (coupon) => coupon.per_user_limit ?? 'Sin límite', hideOnMobile: true },
    { key: 'status', header: 'Estado', render: (coupon) => <StatusBadge status={coupon.status} /> },
  ];

  return (
    <ResourcePage<Coupon>
      title="Cupones"
      description="Códigos que los pasajeros pueden aplicar al comprar."
      breadcrumbs={[{ label: 'Administración' }, { label: 'Cupones' }]}
      loader={(params) => couponService.list(params)}
      columns={columns}
      permissionModule="promotions"
      entityLabel="Cupón"
      searchPlaceholder="Buscar por código o promoción..."
      filters={[
        {
          key: 'status',
          placeholder: 'Todos los estados',
          options: [
            { value: 'ACTIVE', label: 'Activo' },
            { value: 'INACTIVE', label: 'Inactivo' },
            { value: 'EXPIRED', label: 'Expirado' },
          ],
        },
      ]}
      formFields={[
        {
          name: 'promotion_id',
          label: 'Promoción',
          type: 'select',
          required: true,
          options: (promotions.data?.data ?? []).map((promotion) => ({ value: promotion.id, label: promotion.name })),
        },
        { name: 'code', label: 'Código', required: true, placeholder: 'Ej: VIAJA20' },
        { name: 'usage_limit', label: 'Límite total de usos', type: 'number' },
        { name: 'per_user_limit', label: 'Límite por usuario', type: 'number' },
        {
          name: 'status',
          label: 'Estado',
          type: 'select',
          options: [
            { value: 'ACTIVE', label: 'Activo' },
            { value: 'INACTIVE', label: 'Inactivo' },
            { value: 'EXPIRED', label: 'Expirado' },
          ],
        },
      ]}
      onCreate={(values) => couponService.create(values).then(() => undefined)}
      onUpdate={(id, values) => couponService.update(id, values).then(() => undefined)}
      onDelete={(id) => couponService.remove(id).then(() => undefined)}
      emptyTitle="No hay cupones creados"
      emptyDescription="Crea cupones vinculados a una promoción activa."
    />
  );
}

export function ReviewsPage({ scope }: { scope: 'company' | 'admin' }) {
  const toast = useToast();
  const { hasPermission } = useAuth();
  const list = useList<Review>((params) => reviewService.list(params));
  const [responding, setResponding] = useState<Review | null>(null);
  const [response, setResponse] = useState('');
  const [sending, setSending] = useState(false);

  const moderate = async (review: Review, status: 'PUBLISHED' | 'HIDDEN' | 'REJECTED') => {
    try {
      await reviewService.update(review.id, { status });
      toast.success('Reseña actualizada correctamente.');
      list.reload();
    } catch (error) {
      toast.error('No se pudo actualizar', error instanceof ApiError ? error.message : undefined);
    }
  };

  const sendResponse = async () => {
    if (!responding || !response.trim()) return;
    setSending(true);
    try {
      await reviewService.respond(responding.id, response);
      toast.success('Respuesta publicada.');
      setResponding(null);
      setResponse('');
      list.reload();
    } catch (error) {
      toast.error('No se pudo responder', error instanceof ApiError ? error.message : undefined);
    } finally {
      setSending(false);
    }
  };

  const columns: Array<Column<Review>> = [
    {
      key: 'review',
      header: 'Reseña',
      render: (review) => (
        <div className="min-w-0 max-w-md">
          <div className="flex items-center gap-1">
            {Array.from({ length: 5 }).map((_, index) => (
              <Star key={index} className={index < review.rating ? 'h-3.5 w-3.5 fill-warning-500 text-warning-500' : 'h-3.5 w-3.5 text-slate-300'} />
            ))}
          </div>
          <p className="mt-1 font-medium text-ink">{review.title ?? 'Sin título'}</p>
          <p className="line-clamp-2 text-sm text-muted">{review.comment ?? '—'}</p>
        </div>
      ),
    },
    {
      key: 'user',
      header: 'Pasajero',
      render: (review) => (
        <div>
          <p className="font-medium text-ink">
            {review.first_name} {review.last_name}
          </p>
          <p className="text-xs text-muted">{review.booking_code}</p>
        </div>
      ),
      hideOnMobile: true,
    },
    {
      key: 'trip',
      header: 'Viaje',
      render: (review) => (
        <span className="text-slate-600">
          {review.origin_city} → {review.destination_city}
        </span>
      ),
      hideOnMobile: true,
    },
    ...(scope === 'admin' ? [{ key: 'company', header: 'Empresa', render: (review: Review) => review.company_name ?? '—', hideOnMobile: true }] : []),
    { key: 'date', header: 'Fecha', sortColumn: 'rv.created_at', render: (review) => formatDateTime(review.created_at), hideOnMobile: true },
    { key: 'status', header: 'Estado', render: (review) => <StatusBadge status={review.status} /> },
    {
      key: 'actions',
      header: 'Acciones',
      headerClassName: 'text-right',
      className: 'text-right',
      render: (review) => (
        <div className="flex justify-end gap-2">
          {hasPermission('reviews.update') && (
            <>
              <Button
                size="sm"
                variant="ghost"
                icon={<MessageSquare className="h-4 w-4" />}
                onClick={() => {
                  setResponding(review);
                  setResponse('');
                }}
              >
                Responder
              </Button>
              {review.status !== 'PUBLISHED' && (
                <Button size="sm" variant="success" onClick={() => void moderate(review, 'PUBLISHED')}>
                  Publicar
                </Button>
              )}
              {review.status === 'PUBLISHED' && (
                <Button size="sm" variant="secondary" onClick={() => void moderate(review, 'HIDDEN')}>
                  Ocultar
                </Button>
              )}
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Reseñas" description="Modera y responde las opiniones de los pasajeros." breadcrumbs={[{ label: scope === 'company' ? 'Portal Empresa' : 'Administración' }, { label: 'Reseñas' }]} />

      <Card padded={false}>
        <div className="border-b border-border p-4">
          <FilterBar>
            <SearchBar className="min-w-0 flex-1 sm:max-w-sm" placeholder="Buscar por título, comentario o pasajero..." value={list.search} onChange={(event) => list.setSearch(event.target.value)} />
            <Select
              options={[
                { value: 'PENDING', label: 'Pendiente' },
                { value: 'PUBLISHED', label: 'Publicada' },
                { value: 'HIDDEN', label: 'Oculta' },
                { value: 'REJECTED', label: 'Rechazada' },
              ]}
              placeholder="Todos los estados"
              value={list.filters.status ?? ''}
              onChange={(event) => list.setFilter('status', event.target.value || null)}
              containerClassName="w-full sm:w-auto sm:min-w-[180px]"
            />
            <Select
              options={[5, 4, 3, 2, 1].map((rating) => ({ value: String(rating), label: `${rating} estrellas` }))}
              placeholder="Todas las calificaciones"
              value={list.filters.rating ?? ''}
              onChange={(event) => list.setFilter('rating', event.target.value || null)}
              containerClassName="w-full sm:w-auto sm:min-w-[180px]"
            />
          </FilterBar>
        </div>

        {list.error ? (
          <ErrorState error={list.error} onRetry={list.reload} />
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={list.rows}
              rowKey={(review) => review.id}
              sort={list.sort}
              onSort={list.toggleSort}
              loading={list.loading}
              loadingState={<TableSkeleton />}
              emptyState={<EmptyState title="No hay reseñas" description="Las opiniones de los pasajeros aparecerán aquí tras sus viajes." icon={<Star className="h-7 w-7" />} />}
            />
            {!list.loading && list.rows.length > 0 && <TablePagination pagination={list.pagination} onPageChange={list.setPage} />}
          </>
        )}
      </Card>

      <Modal
        open={responding !== null}
        onClose={() => setResponding(null)}
        title="Responder reseña"
        description={responding?.title ?? undefined}
        footer={
          <>
            <Button variant="secondary" onClick={() => setResponding(null)}>
              Cancelar
            </Button>
            <Button onClick={() => void sendResponse()} loading={sending} disabled={!response.trim()}>
              Publicar respuesta
            </Button>
          </>
        }
      >
        <p className="mb-4 rounded-card bg-slate-50 p-4 text-sm text-slate-600">{responding?.comment ?? 'Sin comentario'}</p>
        <Textarea label="Tu respuesta" placeholder="Gracias por tu comentario..." value={response} onChange={(event) => setResponse(event.target.value)} rows={5} />
      </Modal>
    </>
  );
}
