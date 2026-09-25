import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { after, before, beforeEach, describe, it } from 'node:test';
import ts from 'typescript';
import { execute, query, queryOne } from '../config/database';
import * as layouts from '../services/bus-layout.service';
import { splitStatements } from './helpers/database';
import { at } from './helpers/fixtures';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * F18-02B · compatibilidad con MariaDB 10.11.
 *
 * F18-02A encontró dos incompatibilidades reales al validar sobre un MariaDB 10.11.19 de verdad:
 *
 *  1. Las migraciones 009 y 010 no se podían aplicar (ERROR 1901). MariaDB 10.11 no admite una
 *     columna generada STORED cuya columna base tenga una clave ajena con `ON UPDATE CASCADE`.
 *     009 y 010 pasan a `ON DELETE CASCADE ON UPDATE RESTRICT`, y la 018 ajusta las bases ya
 *     creadas con la versión anterior.
 *  2. `row_number` sin comillas ni alias es un error de sintaxis en 10.11 (ERROR 1064); en 10.4 no.
 *     La distribución física del bus y el seed lo usaban así.
 *
 * Esta batería corre igual sobre 10.4 (desarrollo) y sobre 10.11 (producción). Donde el motor se
 * comporta de forma distinta —crear la forma antigua de la clave— se comprueba EXPLÍCITAMENTE lo
 * que debe pasar en cada uno; no hay ramas que se salten la comprobación.
 */

const MIGRACION_018 = path.resolve(__dirname, '../../../database/migrations/018-fk-on-update-restrict-mariadb-1011.sql');

interface ReglaClave { tabla: string; clave: string; referida: string; al_actualizar: string; al_borrar: string }

async function reglas(nombres: string[]): Promise<ReglaClave[]> {
  return query<ReglaClave>(
    `SELECT table_name AS tabla, constraint_name AS clave, referenced_table_name AS referida,
            update_rule AS al_actualizar, delete_rule AS al_borrar
     FROM information_schema.referential_constraints
     WHERE constraint_schema = DATABASE() AND constraint_name IN (?)
     ORDER BY constraint_name`,
    [nombres],
  );
}

/** Todas las claves ajenas del esquema: sirve para comprobar que nada más cambia. */
async function todasLasClaves(): Promise<string[]> {
  const filas = await query<ReglaClave>(
    `SELECT table_name AS tabla, constraint_name AS clave, referenced_table_name AS referida,
            update_rule AS al_actualizar, delete_rule AS al_borrar
     FROM information_schema.referential_constraints
     WHERE constraint_schema = DATABASE() ORDER BY table_name, constraint_name`,
  );
  return filas.map((f) => `${f.tabla}.${f.clave}→${f.referida} U:${f.al_actualizar} D:${f.al_borrar}`);
}

/** Ejecuta la 018 tal como lo hace el preparador de la base de pruebas. */
async function aplicar018(): Promise<void> {
  for (const sentencia of splitStatements(fs.readFileSync(MIGRACION_018, 'utf8'))) {
    if (/^SELECT/i.test(sentencia)) continue;
    await execute(sentencia);
  }
}

function errno(error: unknown): number | undefined {
  return (error as { errno?: number }).errno;
}

// ---------------------------------------------------------------------------
// Detector estático de `row_number` sin comillas ni alias dentro de SQL
// ---------------------------------------------------------------------------

const PALABRAS_SQL = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|FROM|ORDER\s+BY|GROUP\s+BY|WHERE)\b/i;
// `row_number` que no va precedido de `.` (alias), acento grave ni barra (acento escapado en una
// plantilla), ni seguido de acento grave o de `(` (la función de ventana ROW_NUMBER()).
const SIN_CITAR = /(?<![.`\\\w])row_number(?![`\\\w]|\s*\()/i;

interface Hallazgo { archivo: string; linea: number; texto: string }

function buscarSinCitar(archivo: string, fuente: string): Hallazgo[] {
  const sf = ts.createSourceFile(archivo, fuente, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hallazgos: Hallazgo[] = [];
  const visitar = (nodo: ts.Node): void => {
    const k = nodo.kind;
    if (
      k === ts.SyntaxKind.StringLiteral || k === ts.SyntaxKind.NoSubstitutionTemplateLiteral
      || k === ts.SyntaxKind.TemplateHead || k === ts.SyntaxKind.TemplateMiddle || k === ts.SyntaxKind.TemplateTail
    ) {
      const texto = nodo.getText(sf);
      if (PALABRAS_SQL.test(texto) && SIN_CITAR.test(texto)) {
        hallazgos.push({ archivo, linea: sf.getLineAndCharacterOfPosition(nodo.getStart(sf)).line + 1, texto: texto.slice(0, 120) });
      }
    }
    ts.forEachChild(nodo, visitar);
  };
  visitar(sf);
  return hallazgos;
}

function archivosTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const ruta = path.join(dir, e.name);
    if (e.isDirectory()) return archivosTs(ruta);
    return e.name.endsWith('.ts') ? [ruta] : [];
  });
}

describe('F18-02B · compatibilidad con MariaDB 10.11', () => {
  let ctx: SuiteContext;
  let version = '';

  before(async () => {
    ctx = await prepareSuite();
    version = String((await queryOne<{ v: string }>('SELECT VERSION() AS v'))?.v);
  });
  after(teardownSuite);

  // =========================================================================
  describe('Migraciones 009, 010 y 018: esquema resultante', () => {
    it('company_scope y published_scope siguen siendo columnas generadas STORED con la misma expresión', async () => {
      const columnas = await query<{ tabla: string; columna: string; extra: string; expresion: string }>(
        `SELECT table_name AS tabla, column_name AS columna, extra, generation_expression AS expresion
         FROM information_schema.columns
         WHERE table_schema = DATABASE()
           AND ((table_name = 'company_integrations' AND column_name = 'company_scope')
             OR (table_name = 'bus_layouts' AND column_name = 'published_scope'))
         ORDER BY table_name`,
      );
      assert.equal(columnas.length, 2);
      const [layout, integracion] = columnas;
      assert.match(String(layout?.extra), /STORED GENERATED/i);
      assert.equal(String(layout?.expresion).toLowerCase().replace(/\s+/g, ' '), "if(`status` = 'published',`bus_id`,null)");
      assert.match(String(integracion?.extra), /STORED GENERATED/i);
      assert.equal(String(integracion?.expresion).toLowerCase(), 'coalesce(`company_id`,0)');
    });

    it('fk_integrations_company y fk_bus_layouts_bus: ON DELETE CASCADE y ON UPDATE RESTRICT', async () => {
      assert.deepEqual(await reglas(['fk_integrations_company', 'fk_bus_layouts_bus']), [
        { tabla: 'bus_layouts', clave: 'fk_bus_layouts_bus', referida: 'buses', al_actualizar: 'RESTRICT', al_borrar: 'CASCADE' },
        { tabla: 'company_integrations', clave: 'fk_integrations_company', referida: 'companies', al_actualizar: 'RESTRICT', al_borrar: 'CASCADE' },
      ]);
    });

    it('las claves que apuntan a bus_layouts.id no cambian (id no es base de ninguna columna generada)', async () => {
      assert.deepEqual(await reglas(['fk_bus_layout_decks_layout', 'fk_seats_layout', 'fk_seats_deck', 'fk_trips_bus_layout']), [
        { tabla: 'bus_layout_decks', clave: 'fk_bus_layout_decks_layout', referida: 'bus_layouts', al_actualizar: 'CASCADE', al_borrar: 'CASCADE' },
        { tabla: 'seats', clave: 'fk_seats_deck', referida: 'bus_layout_decks', al_actualizar: 'CASCADE', al_borrar: 'CASCADE' },
        { tabla: 'seats', clave: 'fk_seats_layout', referida: 'bus_layouts', al_actualizar: 'CASCADE', al_borrar: 'CASCADE' },
        { tabla: 'trips', clave: 'fk_trips_bus_layout', referida: 'bus_layouts', al_actualizar: 'CASCADE', al_borrar: 'RESTRICT' },
      ]);
    });

    it('los índices únicos sobre las columnas generadas siguen en su sitio', async () => {
      const indices = await query<{ tabla: string; indice: string; columnas: string; no_unico: number }>(
        `SELECT table_name AS tabla, index_name AS indice, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columnas,
                MAX(non_unique) AS no_unico
         FROM information_schema.statistics
         WHERE table_schema = DATABASE() AND index_name IN ('uq_integration_scope_provider', 'uq_layout_published_bus')
         GROUP BY table_name, index_name ORDER BY table_name`,
      );
      assert.deepEqual(indices.map((i) => [i.tabla, i.indice, i.columnas, Number(i.no_unico)]), [
        ['bus_layouts', 'uq_layout_published_bus', 'published_scope', 0],
        ['company_integrations', 'uq_integration_scope_provider', 'company_scope,provider', 0],
      ]);
    });
  });

  // =========================================================================
  describe('Comportamiento de las claves corregidas', () => {
    let empresa = 0;
    let bus = 0;

    beforeEach(async () => {
      const e = await execute("INSERT INTO companies (name, legal_name, tax_id, email, status) VALUES ('Empresa F18', 'Empresa F18 SAC', '20999999991', 'f18@test.pe', 'ACTIVE')");
      empresa = e.insertId;
      const tipo = await queryOne<{ id: number }>('SELECT bus_type_id AS id FROM buses WHERE id = ?', [ctx.fixtures.busA]);
      const b = await execute(
        "INSERT INTO buses (company_id, bus_type_id, code, plate_number, capacity, status) VALUES (?, ?, 'F18-001', 'F18-111', 0, 'ACTIVE')",
        [empresa, tipo?.id ?? null],
      );
      bus = b.insertId;
    });

    // Sin tablas intermedias de por medio: lo que no borre la cascada lo borra esta limpieza.
    async function limpiar(): Promise<void> {
      await execute('DELETE FROM company_integrations WHERE company_id = ? OR (company_id IS NULL AND provider LIKE ?)', [empresa, 'F18-%']);
      await execute('DELETE FROM buses WHERE id = ?', [bus]);
      await execute('DELETE FROM companies WHERE id = ?', [empresa]);
    }

    it('ON DELETE CASCADE: borrar la empresa borra sus integraciones', async () => {
      await execute("INSERT INTO company_integrations (company_id, provider, category, status) VALUES (?, 'F18-PASARELA', 'PAYMENT_GATEWAY', 'DISCONNECTED')", [empresa]);
      await execute('DELETE FROM buses WHERE id = ?', [bus]);
      await execute('DELETE FROM companies WHERE id = ?', [empresa]);
      const quedan = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM company_integrations WHERE company_id = ?', [empresa]);
      assert.equal(Number(quedan?.n), 0);
    });

    it('ON DELETE CASCADE: borrar el bus borra sus versiones de distribución y sus pisos', async () => {
      const borrador = await layouts.createDraft(bus, { decks: [{ deck_number: 1, name: 'Piso 1', row_count: 2, column_count: 2 }] });
      await execute('DELETE FROM buses WHERE id = ?', [bus]);
      const versiones = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM bus_layouts WHERE bus_id = ?', [bus]);
      const pisos = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM bus_layout_decks WHERE layout_id = ?', [borrador.id]);
      assert.equal(Number(versiones?.n), 0);
      assert.equal(Number(pisos?.n), 0);
      await limpiar();
    });

    it('ON UPDATE RESTRICT: no se puede cambiar el id de una empresa con integraciones ni el de un bus con versiones', async () => {
      await execute("INSERT INTO company_integrations (company_id, provider, category, status) VALUES (?, 'F18-PASARELA', 'PAYMENT_GATEWAY', 'DISCONNECTED')", [empresa]);
      await layouts.createDraft(bus, {});
      await assert.rejects(() => execute('UPDATE buses SET id = id + 1000000 WHERE id = ?', [bus]), (error: unknown) => errno(error) === 1451);
      await execute('DELETE FROM bus_layouts WHERE bus_id = ?', [bus]);
      await execute('DELETE FROM buses WHERE id = ?', [bus]);
      await assert.rejects(() => execute('UPDATE companies SET id = id + 1000000 WHERE id = ?', [empresa]), (error: unknown) => errno(error) === 1451);
      const sigue = await queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM companies WHERE id = ?', [empresa]);
      assert.equal(Number(sigue?.n), 1, 'la empresa conserva su id');
      await limpiar();
    });

    it('las columnas generadas siguen garantizando la unicidad para la que existen', async () => {
      await execute("INSERT INTO company_integrations (company_id, provider, category, status) VALUES (NULL, 'F18-PLATAFORMA', 'OTHER', 'DISCONNECTED')");
      await assert.rejects(
        () => execute("INSERT INTO company_integrations (company_id, provider, category, status) VALUES (NULL, 'F18-PLATAFORMA', 'OTHER', 'DISCONNECTED')"),
        (error: unknown) => errno(error) === 1062,
        'dos integraciones de plataforma del mismo proveedor',
      );
      await execute("INSERT INTO bus_layouts (bus_id, version, status, name, seat_count, published_at) VALUES (?, 1, 'PUBLISHED', 'v1', 0, NOW())", [bus]);
      await assert.rejects(
        () => execute("INSERT INTO bus_layouts (bus_id, version, status, name, seat_count, published_at) VALUES (?, 2, 'PUBLISHED', 'v2', 0, NOW())", [bus]),
        (error: unknown) => errno(error) === 1062,
        'dos versiones publicadas del mismo bus',
      );
      await execute('DELETE FROM bus_layouts WHERE bus_id = ?', [bus]);
      await limpiar();
    });
  });

  // =========================================================================
  describe('Migración 018', () => {
    it('es reejecutable: dos pasadas más no cambian ninguna clave ni duplican nada', async () => {
      const antes = await todasLasClaves();
      await aplicar018();
      await aplicar018();
      assert.deepEqual(await todasLasClaves(), antes);
      const repetidas = await query<{ clave: string; n: number }>(
        `SELECT constraint_name AS clave, COUNT(*) AS n FROM information_schema.table_constraints
         WHERE table_schema = DATABASE() AND constraint_type = 'FOREIGN KEY'
         GROUP BY table_name, constraint_name HAVING COUNT(*) > 1`,
      );
      assert.deepEqual(repetidas, []);
    });

    it('sobre una base con la forma antigua de la clave la deja en RESTRICT, y rehace una clave que falte', async () => {
      const antes = await todasLasClaves();
      const casos = [
        { tabla: 'company_integrations', clave: 'fk_integrations_company', columna: 'company_id', referida: 'companies' },
        { tabla: 'bus_layouts', clave: 'fk_bus_layouts_bus', columna: 'bus_id', referida: 'buses' },
      ];
      for (const c of casos) {
        await execute(`ALTER TABLE \`${c.tabla}\` DROP FOREIGN KEY \`${c.clave}\``);
        const antigua = `ALTER TABLE \`${c.tabla}\` ADD CONSTRAINT \`${c.clave}\` FOREIGN KEY (\`${c.columna}\`) REFERENCES \`${c.referida}\` (\`id\`) ON DELETE CASCADE ON UPDATE CASCADE`;
        if (version.startsWith('10.4.')) {
          // En 10.4 la forma antigua existe: es la de toda base creada antes de F18-02B.
          await execute(antigua);
          assert.deepEqual((await reglas([c.clave])).map((r) => r.al_actualizar), ['CASCADE']);
        } else {
          // En 10.11 esa forma es justo lo que el motor rechaza (el fallo de F18-02A). La clave
          // queda quitada: la 018 tiene que rehacerla, como tras una ejecución interrumpida.
          await assert.rejects(() => execute(antigua), (error: unknown) => errno(error) === 1901);
          assert.deepEqual(await reglas([c.clave]), []);
        }
      }
      await aplicar018();
      assert.deepEqual(await todasLasClaves(), antes, 'el esquema vuelve exactamente a su estado');
      assert.deepEqual((await reglas(casos.map((c) => c.clave))).map((r) => [r.clave, r.al_actualizar, r.al_borrar]), [
        ['fk_bus_layouts_bus', 'RESTRICT', 'CASCADE'],
        ['fk_integrations_company', 'RESTRICT', 'CASCADE'],
      ]);
    });
  });

  // =========================================================================
  describe('Columnas JSON: llegan como texto en cualquier motor', () => {
    // En MariaDB 10.5+ el servidor marca estas columnas con el formato `json` y el driver las
    // devolvía ya convertidas en objeto; el código espera texto (lo que da 10.4).
    it('las nueve columnas JSON del esquema se leen como cadena, también con prepared statements', async () => {
      const columnas = await query<{ tabla: string; columna: string }>(
        `SELECT table_name AS tabla, SUBSTRING_INDEX(SUBSTRING_INDEX(check_clause, '\`', 2), '\`', -1) AS columna
         FROM information_schema.check_constraints
         WHERE constraint_schema = DATABASE() AND check_clause LIKE 'json_valid%' ORDER BY 1, 2`,
      );
      assert.equal(columnas.length, 9);

      await execute("UPDATE buses SET amenities = '{\"wifi\":true}' WHERE id = ?", [ctx.fixtures.busA]);
      const texto = await queryOne<{ a: unknown }>('SELECT amenities AS a FROM buses WHERE id = ?', [ctx.fixtures.busA]);
      assert.equal(typeof texto?.a, 'string');
      assert.deepEqual(JSON.parse(String(texto?.a)), { wifi: true });
    });

    it('fusionar payment_data conserva lo que ya había guardado en la base', async () => {
      const { mergePaymentData } = await import('../services/booking.service');
      const fila = await queryOne<{ d: unknown }>("SELECT JSON_OBJECT('culqi_charge_id', 'chr_previo') AS d");
      assert.equal(typeof fila?.d, 'string');
      assert.deepEqual(JSON.parse(mergePaymentData(fila?.d, { verificado: true })), { culqi_charge_id: 'chr_previo', verificado: true });
    });
  });

  // =========================================================================
  describe('row_number: portabilidad del SQL', () => {
    it('el detector encuentra un row_number sin citar y respeta las formas válidas', () => {
      const muestra = [
        "const a = 'SELECT row_number FROM seats';",
        'const b = `SELECT id FROM seats ORDER BY row_number ASC`;',
        "const c = 'SELECT `row_number` FROM seats';",
        'const d = `SELECT \\`row_number\\` FROM seats`;',
        "const e = 'SELECT s.row_number FROM seats s';",
        "const f = 'SELECT ROW_NUMBER() OVER (ORDER BY id) FROM seats';",
        'const g = { row_number: 1 };',
        "const h = 'row_number';",
      ].join('\n');
      assert.deepEqual(buscarSinCitar('muestra.ts', muestra).map((h) => h.linea), [1, 2]);
    });

    it('ningún SQL del backend (código, seed ni pruebas) usa row_number sin comillas ni alias', () => {
      const raiz = path.resolve(__dirname, '..');
      const propio = path.resolve(__filename);
      const hallazgos = archivosTs(raiz)
        .filter((archivo) => path.resolve(archivo) !== propio)
        .flatMap((archivo) => buscarSinCitar(path.relative(raiz, archivo), fs.readFileSync(archivo, 'utf8')));
      assert.deepEqual(hallazgos, []);
    });

    describe('operaciones de la distribución física sobre el motor actual', () => {
      beforeEach(async () => {
        await execute('DELETE FROM financial_transactions');
        await execute('DELETE FROM payments');
        await execute('DELETE FROM booking_seats');
        await execute('DELETE FROM bookings');
        await execute('UPDATE trips SET bus_layout_id = ? WHERE bus_id = ?', [ctx.fixtures.layoutA, ctx.fixtures.busA]);
        await execute('UPDATE trips SET bus_layout_id = ? WHERE bus_id = ?', [ctx.fixtures.layoutB, ctx.fixtures.busB]);
        await execute('DELETE FROM bus_layout_elements');
        await execute('DELETE FROM seats WHERE layout_id NOT IN (?, ?)', [ctx.fixtures.layoutA, ctx.fixtures.layoutB]);
        await execute('DELETE FROM bus_layouts WHERE id NOT IN (?, ?)', [ctx.fixtures.layoutA, ctx.fixtures.layoutB]);
        await execute("UPDATE bus_layouts SET status = 'PUBLISHED' WHERE id IN (?, ?)", [ctx.fixtures.layoutA, ctx.fixtures.layoutB]);
      });

      it('alta, edición, clonado, versiones, asientos, elementos y publicación', async () => {
        // Clonado: copia asientos y elementos con INSERT … SELECT.
        const clon = await layouts.cloneForEdit(ctx.fixtures.layoutA);
        assert.equal(clon.status, 'DRAFT');
        const piso = at(await layouts.listDecks(clon.id), 0);
        await layouts.updateDeck(piso.id, { row_count: 6, column_count: 4 });

        // Elementos: alta, edición y listado ordenado por fila.
        const bano = await layouts.createElement(piso.id, { element_type: 'BATHROOM', row_number: 5, column_number: 1 });
        assert.equal(bano.row_number, 5);
        const movido = await layouts.updateElement(bano.id, { row_number: 5, column_number: 4, label: 'Baño' });
        assert.deepEqual([movido.row_number, movido.column_number, movido.label], [5, 4, 'Baño']);
        assert.deepEqual((await layouts.listElements(piso.id)).map((e) => [e.row_number, e.column_number]), [[5, 4]]);

        // Asientos: alta y edición, con el tipo de uno existente.
        const tipo = await queryOne<{ id: number }>('SELECT seat_type_id AS id FROM seats WHERE layout_id = ? LIMIT 1', [ctx.fixtures.layoutA]);
        const asiento = await layouts.createSeat(piso.id, { seat_number: '50', row_number: 6, column_number: 1, seat_type_id: tipo?.id ?? null });
        assert.equal(asiento.row_number, 6);
        const editado = await layouts.updateSeat(asiento.id, { seat_number: '50', row_number: 6, column_number: 2, seat_type_id: tipo?.id ?? null });
        assert.deepEqual([editado.row_number, editado.column_number], [6, 2]);
        const asientos = await layouts.listSeats(piso.id);
        assert.equal(asientos.length, ctx.fixtures.seatsA.length + 1);
        assert.ok(asientos.every((s) => typeof s.row_number === 'number'), 'la columna sigue llamándose row_number en el resultado');

        // Árbol completo y publicación de la nueva versión.
        const arbol = await layouts.getLayoutTree(clon.id);
        assert.ok(arbol?.seats.some((s) => s.seat_number === '50' && s.row_number === 6 && s.column_number === 2));
        assert.ok(arbol?.elements.some((e) => e.element_type === 'BATHROOM' && e.row_number === 5));
        const publicada = await layouts.publishLayout(clon.id);
        assert.equal(publicada.status, 'PUBLISHED');

        const versiones = await layouts.listLayouts(ctx.fixtures.busA);
        assert.deepEqual(versiones.map((v) => [v.id, v.status]).sort(), [[ctx.fixtures.layoutA, 'ARCHIVED'], [clon.id, 'PUBLISHED']].sort());
        assert.equal((await layouts.getPublishedLayout(ctx.fixtures.busA))?.id, clon.id);
      });
    });
  });
});
