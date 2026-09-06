import type { Router } from 'express';
import { execute } from '../config/database';
import { createResourceRouter, type ResourceDefinition } from '../core/resource';
import * as v from '../validators/resource.validators';

/**
 * Standard CRUD modules. Permission mapping notes (documented decisions, see README):
 * - bus_types / seat_types / seats reuse the `buses.*` permissions (the schema has no dedicated module).
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
     * Al aprobar una empresa se activan sus usuarios PENDING. Sin esto el registro de
     * empresa quedaba sin salida: la empresa pasaba a ACTIVE pero su administrador seguía
     * en PENDING y no podía iniciar sesión nunca.
     */
    afterUpdate: async (companyId, previous, data) => {
      if (data.status !== 'ACTIVE' || previous.status === 'ACTIVE') return;
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
    entityName: 'Bus',
    permissionModule: 'buses',
    selectSql: `SELECT b.*, bt.name AS bus_type_name, co.name AS company_name,
      (SELECT COUNT(*) FROM seats s WHERE s.bus_id = b.id) AS seats_count
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
    table: 'seats',
    alias: 's',
    entityName: 'Asiento',
    permissionModule: 'buses',
    selectSql: `SELECT s.*, st.name AS seat_type_name, bu.code AS bus_code, bu.company_id
      FROM seats s
      JOIN buses bu ON bu.id = s.bus_id
      LEFT JOIN seat_types st ON st.id = s.seat_type_id`,
    searchColumns: ['s.seat_number'],
    filters: { bus_id: 's.bus_id', status: 's.status', seat_type_id: 's.seat_type_id' },
    sortColumns: ['s.seat_number', 's.row_number'],
    defaultSort: 's.row_number',
    defaultOrder: 'ASC',
    writableColumns: [
      'bus_id', 'seat_type_id', 'seat_number', 'row_number', 'column_number', 'is_window', 'is_aisle', 'status',
    ],
    createSchema: v.createSeatSchema,
    updateSchema: v.updateSeatSchema,
    companyScopeExpression: 'bu.company_id',
  },
  {
    table: 'locations',
    alias: 'l',
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
  },
  {
    table: 'promotions',
    alias: 'p',
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
  },
  {
    table: 'notification_templates',
    alias: 'nt',
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
  { path: '/seats', router: createResourceRouter(definitions[4]!) },
  { path: '/locations', router: createResourceRouter(definitions[5]!) },
  { path: '/routes', router: createResourceRouter(definitions[6]!) },
  { path: '/route-stops', router: createResourceRouter(definitions[7]!) },
  { path: '/promotions', router: createResourceRouter(definitions[8]!) },
  { path: '/coupons', router: createResourceRouter(definitions[9]!) },
  { path: '/notification-templates', router: createResourceRouter(definitions[10]!) },
  { path: '/system-settings', router: createResourceRouter(definitions[11]!) },
  { path: '/commissions', router: createResourceRouter(definitions[12]!) },
];
