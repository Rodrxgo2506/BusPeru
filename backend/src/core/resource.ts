import { Router, type Request } from 'express';
import type { ZodTypeAny } from 'zod';
import { execute, query, queryOne } from '../config/database';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { recordAudit } from '../services/audit.service';
import { ApiError } from '../utils/ApiError';
import { asyncHandler, sendList, sendSuccess } from '../utils/http';
import { buildPagination, parseListQuery, safeColumn, stableOrderBy, parseId } from '../utils/query';

export interface ResourceDefinition {
  /** Physical table name, used for writes. */
  table: string;
  /** Alias used by `selectSql` for the base table. */
  alias: string;
  /** Full `SELECT ... FROM table alias [JOINs]` used for reads, without WHERE/ORDER/LIMIT. */
  selectSql: string;
  /** Permission prefix, e.g. "buses" -> buses.view / buses.create / buses.update / buses.delete. */
  permissionModule: string;
  /** Overrides for permission names that do not follow the module.action convention. */
  permissionOverrides?: Partial<Record<'view' | 'create' | 'update' | 'delete', string>>;
  /** SQL columns matched with LIKE against ?search=. */
  searchColumns: string[];
  /** Map of ?queryKey= to a SQL column allowed for exact filtering. */
  filters: Record<string, string>;
  /** SQL columns allowed in ?sort=. */
  sortColumns: string[];
  defaultSort: string;
  defaultOrder?: 'ASC' | 'DESC';
  /** Columns accepted from the request body on writes. Anything else is ignored. */
  writableColumns: string[];
  createSchema: ZodTypeAny;
  updateSchema: ZodTypeAny;
  /**
   * SQL expression resolving to the owning company id (e.g. "b.company_id").
   * When set, COMPANY_ADMIN/OPERATOR only ever see rows of their own companies.
   */
  companyScopeExpression?: string;
  /** Column on the base table holding the company id, enforced on create/update. */
  companyScopeColumn?: string;
  entityName: string;
  allowDelete?: boolean;
  /**
   * Acciones reservadas al ADMIN de la plataforma aunque el rol tenga el permiso.
   * Se usa en catálogos globales compartidos entre empresas (terminales, tipos de bus,
   * tipos de asiento): un COMPANY_ADMIN tiene `routes.*`/`buses.*` para su operación
   * diaria, pero no debe poder crear, editar ni borrar datos maestros que usan las
   * demás empresas. También bloquea el alta de empresas desde un rol de empresa.
   */
  adminOnlyActions?: Array<'create' | 'update' | 'delete'>;
  /**
   * Columnas que solo el ADMIN de la plataforma puede CAMBIAR, dentro de un recurso que
   * los demás roles sí pueden editar. Es más fino que `adminOnlyActions`: `companies`
   * necesita que una empresa mantenga su ficha (nombre, correo, teléfono, logo) pero no
   * pueda tocar `status` ni `tax_id`, que son estado de plataforma y dato fiscal
   * verificado, no datos de la ficha.
   *
   * Se compara contra el valor anterior: reenviar el mismo valor NO es un cambio y se
   * admite. Hace falta porque el formulario del Portal Empresa devuelve la ficha completa
   * al guardar, así que rechazar la mera presencia de la columna rompería una edición
   * legítima. Es el mismo criterio que ya se aplica al rol propio en `PUT /users/:id`.
   */
  adminOnlyColumns?: string[];
  /** Business rule to run after a successful update (e.g. activating users of an approved company). */
  afterUpdate?: (id: number, previous: Record<string, unknown>, data: Record<string, unknown>) => Promise<void>;
  /** Regla que debe cumplirse ANTES de escribir un cambio; si lanza, no se escribe nada (H-46). */
  beforeUpdate?: (id: number, previous: Record<string, unknown>, data: Record<string, unknown>) => Promise<void>;
  /** Regla previa al alta; si lanza, no se inserta nada (H-46). */
  beforeCreate?: (data: Record<string, unknown>) => Promise<void>;
  /** Regla posterior a un alta correcta (H-46: una empresa creada ya ACTIVE recibe su comisión). */
  afterCreate?: (id: number, data: Record<string, unknown>) => Promise<void>;
  /**
   * Regla previa a un borrado (FASE 17). Si lanza, no se borra nada. Lo que devuelva llega a
   * `afterDelete`: sirve para recoger antes del DELETE lo que la cascada va a hacer desaparecer
   * (por ejemplo, las referencias de imágenes de las filas hijas).
   */
  prepareDelete?: (id: number, previous: Record<string, unknown>) => Promise<unknown>;
  /** Limpieza posterior a un borrado correcto (FASE 17: archivos del almacén). No debe lanzar. */
  afterDelete?: (id: number, previous: Record<string, unknown>, prepared: unknown) => Promise<void>;
  /**
   * Cierra las escrituras de este recurso y explica por dónde se hacen ahora: se responde
   * con un error de negocio que dice a dónde ir, en vez de un 404 mudo.
   *
   * Hoy ningún recurso lo usa. Lo usaba `seats`, que se retiró por completo del CRUD
   * genérico (auditoría FASE 7, hallazgo H-16): los asientos pertenecen a una versión de
   * distribución y se administran desde `bus-layout.routes.ts`.
   */
  writesClosedReason?: string;
  /**
   * Qué puede hacer un CUSTOMER con este recurso por el CRUD genérico (auditoría FASE 9, H-24).
   *
   * Es OBLIGATORIO a propósito: cada recurso nuevo tiene que decidirlo. El CUSTOMER tiene
   * permisos de lectura (`companies.view`, `buses.view`, `routes.view`, `promotions.view`)
   * pensados para el catálogo público, y el CRUD genérico no le aplicaba ningún alcance: un
   * pasajero listaba cupones con su código —también inactivos y de otras empresas—, RUC y
   * correo de empresas, placas de buses y rutas inactivas.
   *
   *   · `none`: ni lectura ni escritura (403). Lo público que un pasajero necesita se sirve por
   *     `publicChannel`, que devuelve solo registros activos y campos publicables; `null`
   *     cuando no hay nada público que servir.
   */
  customerAccess: { mode: 'none'; publicChannel: string | null };
}

type Row = Record<string, unknown>;

/** Aplica `customerAccess` antes que el permiso: el permiso del CUSTOMER no abre el CRUD genérico. */
function enforceCustomerAccess(definition: ResourceDefinition) {
  return (req: Request, _res: unknown, next: (error?: unknown) => void): void => {
    if (req.user?.role !== 'CUSTOMER' || definition.customerAccess.mode !== 'none') return next();
    next(ApiError.forbidden(`No tienes acceso a ${definition.entityName.toLowerCase()}`));
  };
}

/** Middleware que exige rol ADMIN para las acciones marcadas como `adminOnlyActions`. */
function requirePlatformAdmin(definition: ResourceDefinition, action: 'create' | 'update' | 'delete') {
  return (req: Request, _res: unknown, next: (error?: unknown) => void): void => {
    if (!definition.adminOnlyActions?.includes(action)) return next();
    if (req.user?.role === 'ADMIN') return next();
    next(ApiError.forbidden(`Solo un administrador de la plataforma puede modificar ${definition.entityName.toLowerCase()}`));
  };
}

function permissionFor(definition: ResourceDefinition, action: 'view' | 'create' | 'update' | 'delete'): string {
  return definition.permissionOverrides?.[action] ?? `${definition.permissionModule}.${action}`;
}

/** ADMIN sees everything; company roles are restricted to their own companies. */
function companyScope(req: Request, definition: ResourceDefinition): { sql: string; params: number[] } | null {
  const user = req.user;
  if (!user || user.role === 'ADMIN' || !definition.companyScopeExpression) return null;
  // Falla cerrado (H-24): un CUSTOMER no pertenece a ninguna empresa. `enforceCustomerAccess`
  // ya lo detiene antes; esto evita que un cambio futuro le devuelva "sin filtro".
  if (user.role === 'CUSTOMER') return { sql: '1 = 0', params: [] };

  if (user.companyIds.length === 0) {
    return { sql: '1 = 0', params: [] };
  }
  const placeholders = user.companyIds.map(() => '?').join(', ');
  return { sql: `${definition.companyScopeExpression} IN (${placeholders})`, params: [...user.companyIds] };
}

/**
 * Impide que un actor que no es ADMIN cambie las columnas reservadas a la plataforma.
 *
 * Compara con la fila anterior en lugar de rechazar la presencia de la clave: el
 * formulario del Portal Empresa reenvía la ficha entera al guardar, así que rechazar por
 * presencia dejaría a una empresa sin poder editar su propio correo o teléfono.
 */
function assertAdminOnlyColumnsUnchanged(req: Request, definition: ResourceDefinition, data: Row, previous: Row): void {
  const reserved = definition.adminOnlyColumns;
  if (!reserved || reserved.length === 0 || req.user?.role === 'ADMIN') return;

  // `null`, `undefined` y cadena vacía son el mismo «sin valor» a efectos de comparar.
  const normalize = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

  for (const column of reserved) {
    if (!Object.prototype.hasOwnProperty.call(data, column)) continue;
    if (normalize(data[column]) === normalize(previous[column])) continue;

    throw ApiError.forbidden(
      `Solo un administrador de la plataforma puede cambiar «${column}» de ${definition.entityName.toLowerCase()}`,
    );
  }
}

function pickWritable(definition: ResourceDefinition, body: Row): Row {
  const data: Row = {};
  for (const column of definition.writableColumns) {
    if (Object.prototype.hasOwnProperty.call(body, column)) data[column] = body[column];
  }
  return data;
}

/** Forces the row's company to one the caller actually belongs to. */
function enforceCompanyOwnership(req: Request, definition: ResourceDefinition, data: Row): void {
  const user = req.user!;
  const column = definition.companyScopeColumn;
  if (!column || user.role === 'ADMIN') return;

  const requested = data[column];
  if (requested === undefined || requested === null) {
    const [ownCompany] = user.companyIds;
    if (ownCompany === undefined) throw ApiError.forbidden('Tu usuario no está asociado a ninguna empresa');
    data[column] = ownCompany;
    return;
  }
  if (!user.companyIds.includes(Number(requested))) {
    throw ApiError.forbidden('No puedes operar sobre datos de otra empresa');
  }
}

async function findRowOrFail(req: Request, definition: ResourceDefinition, id: number): Promise<Row> {
  const conditions = [`${definition.alias}.id = ?`];
  const params: unknown[] = [id];

  const scope = companyScope(req, definition);
  if (scope) {
    conditions.push(scope.sql);
    params.push(...scope.params);
  }

  const row = await queryOne<Row>(`${definition.selectSql} WHERE ${conditions.join(' AND ')} LIMIT 1`, params);
  if (!row) throw ApiError.notFound(`${definition.entityName} no encontrado`);
  return row;
}

export function createResourceRouter(definition: ResourceDefinition): Router {
  const router = Router();
  router.use(authenticate);
  // H-24: antes de cualquier permiso, lectura o escritura.
  router.use(enforceCustomerAccess(definition) as never);

  router.get(
    '/',
    requirePermission(permissionFor(definition, 'view')),
    asyncHandler(async (req, res) => {
      const listQuery = parseListQuery(req.query as Record<string, unknown>);
      const conditions: string[] = [];
      const params: unknown[] = [];

      const scope = companyScope(req, definition);
      if (scope) {
        conditions.push(scope.sql);
        params.push(...scope.params);
      }

      for (const [key, column] of Object.entries(definition.filters)) {
        const value = listQuery.filters[key];
        if (value !== undefined) {
          conditions.push(`${column} = ?`);
          params.push(value);
        }
      }

      if (listQuery.search && definition.searchColumns.length > 0) {
        const like = definition.searchColumns.map((column) => `${column} LIKE ?`).join(' OR ');
        conditions.push(`(${like})`);
        params.push(...definition.searchColumns.map(() => `%${listQuery.search}%`));
      }

      const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
      const sortColumn = safeColumn(listQuery.sort, definition.sortColumns, definition.defaultSort);
      const order = listQuery.sort ? listQuery.order : (definition.defaultOrder ?? 'DESC');

      const countSql = `SELECT COUNT(*) AS total FROM (${definition.selectSql}${where}) AS scoped`;
      const countRow = await queryOne<{ total: number }>(countSql, params);
      const total = Number(countRow?.total ?? 0);

      const rows = await query<Row>(
        `${definition.selectSql}${where} ORDER BY ${stableOrderBy(sortColumn, order, definition.alias)} LIMIT ? OFFSET ?`,
        [...params, listQuery.limit, listQuery.offset],
      );

      sendList(res, rows, buildPagination(total, listQuery.page, listQuery.limit));
    }),
  );

  router.get(
    '/:id',
    requirePermission(permissionFor(definition, 'view')),
    asyncHandler(async (req, res) => {
      const row = await findRowOrFail(req, definition, parseId(req.params.id));
      sendSuccess(res, row);
    }),
  );

  /** Corta la escritura antes de validar nada: el recurso ya no se escribe por aquí. */
  const assertWritable = () => {
    if (definition.writesClosedReason) throw ApiError.badRequest(definition.writesClosedReason);
  };

  router.post(
    '/',
    (_req, _res, next) => { try { assertWritable(); next(); } catch (error) { next(error); } },
    requirePermission(permissionFor(definition, 'create')),
    requirePlatformAdmin(definition, 'create') as never,
    validate(definition.createSchema),
    asyncHandler(async (req, res) => {
      const data = pickWritable(definition, req.body as Row);
      enforceCompanyOwnership(req, definition, data);

      const columns = Object.keys(data);
      if (columns.length === 0) throw ApiError.badRequest('No se enviaron datos para crear el registro');
      await definition.beforeCreate?.(data);

      const result = await execute(
        `INSERT INTO ${definition.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map((column) => data[column]),
      );

      // Si la fila recién creada queda fuera del alcance de quien la crea, el INSERT
      // habría dejado un registro huérfano invisible. Se revierte y se responde 403.
      let created: Row;
      try {
        created = await findRowOrFail(req, definition, result.insertId);
      } catch {
        await execute(`DELETE FROM ${definition.table} WHERE id = ?`, [result.insertId]);
        throw ApiError.forbidden(`No puedes crear ${definition.entityName.toLowerCase()} fuera de tu empresa`);
      }
      await definition.afterCreate?.(result.insertId, data);

      await recordAudit(req, {
        action: 'CREATE',
        entityType: definition.table,
        entityId: result.insertId,
        description: `Creó ${definition.entityName}`,
        newValues: data,
      });
      sendSuccess(res, created, 201);
    }),
  );

  router.put(
    '/:id',
    (_req, _res, next) => { try { assertWritable(); next(); } catch (error) { next(error); } },
    requirePermission(permissionFor(definition, 'update')),
    requirePlatformAdmin(definition, 'update') as never,
    validate(definition.updateSchema),
    asyncHandler(async (req, res) => {
      const id = parseId(req.params.id);
      const previous = await findRowOrFail(req, definition, id);

      const data = pickWritable(definition, req.body as Row);
      assertAdminOnlyColumnsUnchanged(req, definition, data, previous);
      if (definition.companyScopeColumn && data[definition.companyScopeColumn] !== undefined) {
        enforceCompanyOwnership(req, definition, data);
      }

      const columns = Object.keys(data);
      if (columns.length === 0) throw ApiError.badRequest('No se enviaron cambios');
      await definition.beforeUpdate?.(id, previous, data);

      await execute(
        `UPDATE ${definition.table} SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`,
        [...columns.map((column) => data[column]), id],
      );

      await definition.afterUpdate?.(id, previous, data);

      const updated = await findRowOrFail(req, definition, id);
      await recordAudit(req, {
        action: 'UPDATE',
        entityType: definition.table,
        entityId: id,
        description: `Actualizó ${definition.entityName}`,
        oldValues: previous,
        newValues: data,
      });
      sendSuccess(res, updated);
    }),
  );

  if (definition.allowDelete !== false) {
    router.delete(
      '/:id',
      (_req, _res, next) => { try { assertWritable(); next(); } catch (error) { next(error); } },
      requirePermission(permissionFor(definition, 'delete')),
      requirePlatformAdmin(definition, 'delete') as never,
      asyncHandler(async (req, res) => {
        const id = parseId(req.params.id);
        const previous = await findRowOrFail(req, definition, id);
        const prepared = await definition.prepareDelete?.(id, previous);

        await execute(`DELETE FROM ${definition.table} WHERE id = ?`, [id]);
        await recordAudit(req, {
          action: 'DELETE',
          entityType: definition.table,
          entityId: id,
          description: `Eliminó ${definition.entityName}`,
          oldValues: previous,
        });
        await definition.afterDelete?.(id, previous, prepared);
        sendSuccess(res, { id });
      }),
    );
  }

  return router;
}
