import type { Router } from 'express';
import { execute, queryOne } from '../config/database';
import { ApiError } from '../utils/ApiError';
import { createResourceRouter, type ResourceDefinition } from '../core/resource';
import { assertCommissionCanBeInitialized, ensureCompanyCommission } from '../services/company-commission.service';
import * as v from '../validators/resource.validators';

/**
 * F12-01 · un hijo no cambia de empresa a través de su padre.
 *
 * `coupons` y `route_stops` no tienen `company_id`: la empresa la heredan de su promoción o de
 * su ruta, así que `enforceCompanyOwnership` no puede proteger su actualización. Antes, un
 * `PUT /coupons/:id { promotion_id: <promoción de otra empresa> }` ejecutaba el UPDATE y solo
 * DESPUÉS la relectura con alcance respondía 404: el cupón ya estaba en la otra empresa.
 *
 * Se comprueba ANTES de escribir, para cualquier rol: el nuevo padre tiene que existir y ser de
 * la MISMA empresa que el registro actual (NULL = plataforma, en promociones). Si no, 404 —la
 * política de aislamiento: no se confirma que exista el recurso de otra empresa— y no se toca nada.
 * La empresa sale siempre de la base, nunca del cuerpo.
 */
function sameCompanyParent(parentColumn: string, parentSql: string, notFound: string) {
  return async (_id: number, previous: Record<string, unknown>, data: Record<string, unknown>): Promise<void> => {
    if (data[parentColumn] === undefined || Number(data[parentColumn]) === Number(previous[parentColumn])) return;
    const parent = await queryOne<{ company_id: number | null }>(parentSql, [Number(data[parentColumn])]);
    const actual = previous.company_id === null || previous.company_id === undefined ? null : Number(previous.company_id);
    const nuevo = parent?.company_id === null || parent?.company_id === undefined ? null : Number(parent.company_id);
    if (!parent || nuevo !== actual) throw ApiError.notFound(notFound);
  };
}

/**
 * Standard CRUD modules. Permission mapping notes (documented decisions, see README):
 * - bus_types / seat_types reuse the `buses.*` permissions (the schema has no dedicated module).
 * - `seats` ya no es un recurso genérico (auditoría FASE 7, hallazgo H-16): los asientos se leen y
 *   administran por los endpoints de la versión de distribución (`bus-layout.routes.ts`).
 * - locations / route_stops reuse the `routes.*` permissions (cities and terminals are route master data).
 * - refunds reuse `payments.view` / `payments.refund`.
 * - los catálogos sin company_id (bus_types, seat_types, locations) se leen con el permiso
 *   del módulo pero solo el ADMIN de la plataforma puede escribirlos (`adminOnlyActions`).
 * - financial data (settlements, commissions) reuses `reports.view` and `settings.update`.
 */
const definitions: ResourceDefinition[] = [
  {
    table: 'companies',
    alias: 'c',
    // H-24 · ficha pública solo de empresas ACTIVE: nombre, logo, descripción y valoración; sin RUC, correo ni estado.
    customerAccess: { mode: 'none', publicChannel: '/public/companies' },
    entityName: 'Empresa',
    permissionModule: 'companies',
    selectSql: `SELECT c.*, (SELECT COUNT(*) FROM buses b WHERE b.company_id = c.id) AS buses_count,
      (SELECT COUNT(*) FROM routes r WHERE r.company_id = c.id) AS routes_count
      FROM companies c`,
    searchColumns: ['c.name', 'c.legal_name', 'c.tax_id', 'c.email'],
    filters: { status: 'c.status' },
    sortColumns: ['c.name', 'c.created_at', 'c.status'],
    defaultSort: 'c.created_at',
    writableColumns: ['name', 'legal_name', 'tax_id', 'email', 'phone', 'logo_url', 'description', 'status'],
    createSchema: v.createCompanySchema,
    updateSchema: v.updateCompanySchema,
    companyScopeExpression: 'c.id',
    // Un rol de empresa puede editar su propia ficha, pero no dar de alta ni borrar empresas.
    adminOnlyActions: ['create', 'delete'],
    /**
     * Ni cambiar su estado ni su RUC. `status` es la sanción de la plataforma: sin esto un
     * COMPANY_ADMIN deshacía su propia suspensión con una petición, porque suspender la
     * empresa no le quita la sesión. `tax_id` es el dato fiscal que verifica §6: cambiarlo
     * después de aprobar los documentos desligaría la verificación de la identidad
     * verificada.
     */
    adminOnlyColumns: ['status', 'tax_id'],
    /**
     * Al aprobar una empresa se activan sus usuarios PENDING. Sin esto el registro de
     * empresa quedaba sin salida: la empresa pasaba a ACTIVE pero su administrador seguía
     * en PENDING y no podía iniciar sesión nunca.
     */
    /**
     * H-46 · al aprobar una empresa se le COPIA `platform.default_commission` como su propia tasa,
     * salvo que ya tuviera una (una reactivación la conserva). Se comprueba antes de escribir que
     * el valor por defecto sea utilizable, para no dejar una empresa ACTIVE que no puede vender.
     */
    beforeUpdate: async (companyId, previous, data) => {
      if (data.status === 'ACTIVE' && previous.status !== 'ACTIVE') await assertCommissionCanBeInitialized(companyId);
    },
    beforeCreate: async (data) => {
      if (data.status === 'ACTIVE') await assertCommissionCanBeInitialized(null);
    },
    afterCreate: async (companyId, data) => {
      if (data.status === 'ACTIVE') await ensureCompanyCommission(companyId);
    },
    afterUpdate: async (companyId, previous, data) => {
      if (data.status !== 'ACTIVE' || previous.status === 'ACTIVE') return;
      await ensureCompanyCommission(companyId);
      await execute(
        `UPDATE users u
         JOIN company_users cu ON cu.user_id = u.id
         SET u.status = 'ACTIVE'
         WHERE cu.company_id = ? AND u.status = 'PENDING'`,
        [companyId],
      );
    },
  },
  {
    table: 'bus_types',
    alias: 'bt',
    // H-24 · el tipo de bus llega como `bus_type_name` en la búsqueda y el detalle del viaje.
    customerAccess: { mode: 'none', publicChannel: '/public/trips' },
    entityName: 'Tipo de bus',
    permissionModule: 'buses',
    selectSql: 'SELECT bt.* FROM bus_types bt',
    searchColumns: ['bt.name'],
    filters: { status: 'bt.status' },
    sortColumns: ['bt.name', 'bt.created_at'],
    defaultSort: 'bt.name',
    defaultOrder: 'ASC',
    writableColumns: ['name', 'description', 'default_capacity', 'status'],
    createSchema: v.createBusTypeSchema,
    updateSchema: v.updateBusTypeSchema,
    // Catálogo global compartido por todas las empresas.
    adminOnlyActions: ['create', 'update', 'delete'],
  },
  {
    table: 'buses',
    alias: 'b',
    // H-24 · el viaje público trae servicio, comodidades y su distribución (`/public/trips/:id/layout`); nunca placa ni código interno.
    customerAccess: { mode: 'none', publicChannel: '/public/trips' },
    entityName: 'Bus',
    permissionModule: 'buses',
    // `seats_count` ES EL DE LA VERSIÓN VIGENTE, NO EL ACUMULADO. Desde la migración 010 un bus
    // no tiene un juego de asientos sino una versión publicada y todo su histórico archivado,
    // y cada versión conserva los suyos porque `booking_seats` apunta a ellos. Contar por
    // `s.bus_id` sumaba las tres versiones de un bus reformado dos veces y hacía crecer la
    // cifra con cada publicación.
    //
    // EL FALLBACK NO INVENTA CAPACIDAD. Un bus que todavía no tiene ninguna versión —uno recién
    // dado de alta, o los que siembra `seed.ts`, cuyos asientos quedan con `layout_id` nulo—
    // cae a la cuenta de siempre, restringida a los asientos sin versión. Así el dato anterior
    // a la migración se sigue viendo igual, y en cuanto el bus tiene versiones manda la
    // publicada. `buses.capacity` no interviene: es la caché de capacidad y sigue intacta.
    selectSql: `SELECT b.*, bt.name AS bus_type_name, co.name AS company_name,
      (CASE
         WHEN EXISTS (SELECT 1 FROM bus_layouts bl WHERE bl.bus_id = b.id)
           THEN (SELECT COUNT(*) FROM seats s
                   JOIN bus_layouts pl ON pl.id = s.layout_id
                  WHERE pl.bus_id = b.id AND pl.status = 'PUBLISHED')
         ELSE (SELECT COUNT(*) FROM seats s WHERE s.bus_id = b.id AND s.layout_id IS NULL)
       END) AS seats_count
      FROM buses b
      LEFT JOIN bus_types bt ON bt.id = b.bus_type_id
      JOIN companies co ON co.id = b.company_id`,
    searchColumns: ['b.code', 'b.plate_number', 'b.brand', 'b.model'],
    filters: { status: 'b.status', company_id: 'b.company_id', bus_type_id: 'b.bus_type_id' },
    sortColumns: ['b.code', 'b.plate_number', 'b.capacity', 'b.created_at'],
    defaultSort: 'b.code',
    defaultOrder: 'ASC',
    writableColumns: [
      'company_id', 'bus_type_id', 'code', 'plate_number', 'brand', 'model', 'year', 'capacity', 'amenities', 'status',
    ],
    createSchema: v.createBusSchema,
    updateSchema: v.updateBusSchema,
    companyScopeExpression: 'b.company_id',
    companyScopeColumn: 'company_id',
  },
  {
    table: 'seat_types',
    alias: 'st',
    // H-24 · el tipo y precio de cada asiento llegan en `/public/trips/:id/seats`.
    customerAccess: { mode: 'none', publicChannel: '/public/trips' },
    entityName: 'Tipo de asiento',
    permissionModule: 'buses',
    selectSql: 'SELECT st.* FROM seat_types st',
    searchColumns: ['st.name'],
    filters: {},
    sortColumns: ['st.name', 'st.created_at'],
    defaultSort: 'st.name',
    defaultOrder: 'ASC',
    writableColumns: ['name', 'description'],
    createSchema: v.createSeatTypeSchema,
    updateSchema: v.updateSeatTypeSchema,
    // Catálogo global compartido por todas las empresas.
    adminOnlyActions: ['create', 'update', 'delete'],
  },
  {
    table: 'locations',
    alias: 'l',
    // H-24 · terminales y ciudades activas: `/public/terminals` y `/public/cities`.
    customerAccess: { mode: 'none', publicChannel: '/public/terminals' },
    entityName: 'Ubicación',
    permissionModule: 'routes',
    selectSql: 'SELECT l.* FROM locations l',
    searchColumns: ['l.name', 'l.city', 'l.department', 'l.address'],
    filters: { status: 'l.status', type: 'l.type', city: 'l.city', department: 'l.department' },
    sortColumns: ['l.name', 'l.city', 'l.created_at'],
    defaultSort: 'l.name',
    defaultOrder: 'ASC',
    writableColumns: [
      'name', 'city', 'province', 'department', 'country_code', 'latitude', 'longitude', 'type', 'address', 'status',
    ],
    createSchema: v.createLocationSchema,
    updateSchema: v.updateLocationSchema,
    // Las terminales no tienen company_id: son datos maestros que usan todas las empresas.
    adminOnlyActions: ['create', 'update', 'delete'],
  },
  {
    table: 'routes',
    alias: 'r',
    // H-24 · origen, destino, distancia y duración llegan en la búsqueda de viajes.
    customerAccess: { mode: 'none', publicChannel: '/public/trips' },
    entityName: 'Ruta',
    permissionModule: 'routes',
    selectSql: `SELECT r.*, ol.name AS origin_name, ol.city AS origin_city,
      dl.name AS destination_name, dl.city AS destination_city, co.name AS company_name,
      (SELECT COUNT(*) FROM trips t WHERE t.route_id = r.id) AS trips_count,
      (SELECT COUNT(*) FROM route_stops rs WHERE rs.route_id = r.id) AS stops_count
      FROM routes r
      JOIN locations ol ON ol.id = r.origin_location_id
      JOIN locations dl ON dl.id = r.destination_location_id
      JOIN companies co ON co.id = r.company_id`,
    searchColumns: ['r.name', 'ol.city', 'dl.city', 'ol.name', 'dl.name'],
    filters: { status: 'r.status', company_id: 'r.company_id', origin_location_id: 'r.origin_location_id', destination_location_id: 'r.destination_location_id' },
    sortColumns: ['r.created_at', 'r.distance_km', 'r.name'],
    defaultSort: 'r.created_at',
    writableColumns: [
      'company_id', 'origin_location_id', 'destination_location_id', 'name', 'distance_km', 'estimated_duration_minutes', 'status',
    ],
    createSchema: v.createRouteSchema,
    updateSchema: v.updateRouteSchema,
    companyScopeExpression: 'r.company_id',
    companyScopeColumn: 'company_id',
  },
  {
    table: 'route_stops',
    alias: 'rs',
    // H-24 · no hay paradas en la vista pública; lo que ve el pasajero es el viaje.
    customerAccess: { mode: 'none', publicChannel: '/public/trips' },
    entityName: 'Parada',
    permissionModule: 'routes',
    selectSql: `SELECT rs.*, l.name AS location_name, l.city AS location_city, r.company_id
      FROM route_stops rs
      JOIN locations l ON l.id = rs.location_id
      JOIN routes r ON r.id = rs.route_id`,
    searchColumns: ['l.name', 'l.city'],
    filters: { route_id: 'rs.route_id', location_id: 'rs.location_id' },
    sortColumns: ['rs.stop_order'],
    defaultSort: 'rs.stop_order',
    defaultOrder: 'ASC',
    writableColumns: ['route_id', 'location_id', 'stop_order', 'arrival_offset_minutes', 'departure_offset_minutes'],
    createSchema: v.createRouteStopSchema,
    updateSchema: v.updateRouteStopSchema,
    companyScopeExpression: 'r.company_id',
    beforeUpdate: sameCompanyParent('route_id', 'SELECT company_id FROM routes WHERE id = ? LIMIT 1', 'Ruta no encontrada'),
  },
  {
    table: 'promotions',
    alias: 'p',
    // H-24 · solo promociones ACTIVE y vigentes, sin límites de uso ni configuración.
    customerAccess: { mode: 'none', publicChannel: '/public/promotions' },
    entityName: 'Promoción',
    permissionModule: 'promotions',
    selectSql: `SELECT p.*, co.name AS company_name,
      (SELECT COUNT(*) FROM coupons c WHERE c.promotion_id = p.id) AS coupons_count
      FROM promotions p
      LEFT JOIN companies co ON co.id = p.company_id`,
    searchColumns: ['p.name', 'p.description'],
    filters: { status: 'p.status', company_id: 'p.company_id', discount_type: 'p.discount_type' },
    sortColumns: ['p.created_at', 'p.start_at', 'p.end_at', 'p.name'],
    defaultSort: 'p.created_at',
    writableColumns: [
      'company_id', 'name', 'description', 'discount_type', 'discount_value', 'minimum_amount', 'maximum_discount',
      'start_at', 'end_at', 'usage_limit', 'status',
    ],
    createSchema: v.createPromotionSchema,
    updateSchema: v.updatePromotionSchema,
    companyScopeExpression: 'p.company_id',
    companyScopeColumn: 'company_id',
  },
  {
    table: 'coupons',
    alias: 'c',
    // H-24 · los códigos no se publican: el pasajero escribe el suyo al reservar (`coupon_code`) y el backend lo valida.
    customerAccess: { mode: 'none', publicChannel: null },
    entityName: 'Cupón',
    permissionModule: 'promotions',
    selectSql: `SELECT c.*, p.name AS promotion_name, p.discount_type, p.discount_value, p.company_id
      FROM coupons c
      JOIN promotions p ON p.id = c.promotion_id`,
    searchColumns: ['c.code', 'p.name'],
    filters: { status: 'c.status', promotion_id: 'c.promotion_id' },
    sortColumns: ['c.created_at', 'c.code', 'c.usage_count'],
    defaultSort: 'c.created_at',
    writableColumns: ['promotion_id', 'code', 'usage_limit', 'per_user_limit', 'status'],
    createSchema: v.createCouponSchema,
    updateSchema: v.updateCouponSchema,
    companyScopeExpression: 'p.company_id',
    beforeUpdate: sameCompanyParent('promotion_id', 'SELECT company_id FROM promotions WHERE id = ? LIMIT 1', 'Promoción no encontrada'),
  },
  {
    table: 'notification_templates',
    alias: 'nt',
    // H-24 · configuración interna.
    customerAccess: { mode: 'none', publicChannel: null },
    entityName: 'Plantilla de notificación',
    permissionModule: 'settings',
    permissionOverrides: { create: 'settings.update', delete: 'settings.update' },
    selectSql: 'SELECT nt.* FROM notification_templates nt',
    searchColumns: ['nt.name', 'nt.subject', 'nt.title'],
    filters: { type: 'nt.type', status: 'nt.status' },
    sortColumns: ['nt.name', 'nt.created_at'],
    defaultSort: 'nt.name',
    defaultOrder: 'ASC',
    writableColumns: ['name', 'type', 'subject', 'title', 'body', 'variables', 'status'],
    createSchema: v.createNotificationTemplateSchema,
    updateSchema: v.updateNotificationTemplateSchema,
  },
  {
    table: 'system_settings',
    alias: 'ss',
    // H-24 · solo los ajustes marcados como públicos.
    customerAccess: { mode: 'none', publicChannel: '/public/settings' },
    entityName: 'Configuración',
    permissionModule: 'settings',
    permissionOverrides: { create: 'settings.update', delete: 'settings.update' },
    selectSql: 'SELECT ss.* FROM system_settings ss',
    searchColumns: ['ss.setting_key', 'ss.description'],
    filters: { setting_type: 'ss.setting_type', is_public: 'ss.is_public' },
    sortColumns: ['ss.setting_key', 'ss.updated_at'],
    defaultSort: 'ss.setting_key',
    defaultOrder: 'ASC',
    writableColumns: ['setting_key', 'setting_value', 'setting_type', 'description', 'is_public'],
    createSchema: v.createSystemSettingSchema,
    updateSchema: v.updateSystemSettingSchema,
  },
  {
    table: 'company_commission_settings',
    alias: 'cs',
    // H-24 · dato financiero interno.
    customerAccess: { mode: 'none', publicChannel: null },
    entityName: 'Comisión',
    permissionModule: 'settings',
    permissionOverrides: { view: 'reports.view', create: 'settings.update', update: 'settings.update', delete: 'settings.update' },
    selectSql: `SELECT cs.*, co.name AS company_name
      FROM company_commission_settings cs
      JOIN companies co ON co.id = cs.company_id`,
    searchColumns: ['co.name'],
    filters: { status: 'cs.status', company_id: 'cs.company_id', commission_type: 'cs.commission_type' },
    sortColumns: ['cs.effective_from', 'cs.created_at'],
    defaultSort: 'cs.effective_from',
    writableColumns: ['company_id', 'commission_type', 'commission_value', 'effective_from', 'effective_until', 'status'],
    createSchema: v.createCommissionSchema,
    updateSchema: v.updateCommissionSchema,
    companyScopeExpression: 'cs.company_id',
    companyScopeColumn: 'company_id',
  },
];

export const resourceRouters: Array<{ path: string; router: Router }> = [
  { path: '/companies', router: createResourceRouter(definitions[0]!) },
  { path: '/bus-types', router: createResourceRouter(definitions[1]!) },
  { path: '/buses', router: createResourceRouter(definitions[2]!) },
  { path: '/seat-types', router: createResourceRouter(definitions[3]!) },
  { path: '/locations', router: createResourceRouter(definitions[4]!) },
  { path: '/routes', router: createResourceRouter(definitions[5]!) },
  { path: '/route-stops', router: createResourceRouter(definitions[6]!) },
  { path: '/promotions', router: createResourceRouter(definitions[7]!) },
  { path: '/coupons', router: createResourceRouter(definitions[8]!) },
  { path: '/notification-templates', router: createResourceRouter(definitions[9]!) },
  { path: '/system-settings', router: createResourceRouter(definitions[10]!) },
  { path: '/commissions', router: createResourceRouter(definitions[11]!) },
];
