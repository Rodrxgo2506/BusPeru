import '../test/helpers/testEnv';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { api, del, get, patch, post, put } from './helpers/api';
import { execute, queryOne } from '../config/database';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * F17C-SEC-02B · SEC02-01 — los textos de la distribución no se truncan en silencio.
 *
 * QUÉ PASABA. La auditoría activa F17C-SEC-02 mandó un `seat_number` de 200 caracteres por
 * `PATCH /layout-seats/:id`: la API respondía **200** y la base guardaba **10**, porque solo
 * `createSeat` comprobaba la longitud y el servidor no corre con `STRICT_TRANS_TABLES`. Lo
 * mismo con `bus_layouts.name`, `bus_layout_decks.name` y `bus_layout_elements.label`, los
 * tres `varchar(100)`: entraban 300 caracteres y quedaban 100.
 *
 * QUÉ SE COMPRUEBA AQUÍ. Que el tope exacto de cada columna se acepta, que un carácter más se
 * rechaza con 400, y —lo importante— que tras el rechazo la fila conserva su valor ANTERIOR:
 * ni truncado, ni escritura parcial. Y que los límites nuevos no se han comido el aislamiento
 * entre empresas: una empresa ajena sigue recibiendo 403 mande un valor válido o inválido.
 */
describe('SEC02-01 · límites de texto en la distribución del bus', () => {
  let ctx: SuiteContext;
  let layoutId = 0;
  let deckId = 0;
  let seatId = 0;
  let elementId = 0;
  /** Borradores que crea esta suite; se retiran al terminar para no dejarlos acumulados. */
  const borradores: number[] = [];

  /** Cadena de exactamente `n` caracteres. */
  const texto = (n: number): string => 'A'.repeat(n);

  before(async () => {
    ctx = await prepareSuite();
  });

  after(async () => {
    for (const id of borradores) {
      await execute('DELETE FROM seats WHERE layout_id = ?', [id]);
      await execute('DELETE FROM bus_layout_elements WHERE deck_id IN (SELECT id FROM bus_layout_decks WHERE layout_id = ?)', [id]);
      await execute('DELETE FROM bus_layout_decks WHERE layout_id = ?', [id]);
      await execute("DELETE FROM bus_layouts WHERE id = ? AND status = 'DRAFT'", [id]);
    }
    borradores.length = 0;
    await teardownSuite();
  });

  /**
   * Cada caso trabaja sobre un borrador NUEVO del bus de la empresa A: las versiones
   * publicadas de las fixtures no se tocan, y ningún caso hereda el estado del anterior.
   */
  beforeEach(async () => {
    const borrador = await post('/buses/' + ctx.fixtures.busA + '/layouts', { name: 'SEC02B' }, ctx.sessions.companyAdmin.token);
    assert.equal(borrador.status, 201, JSON.stringify(borrador.body));
    layoutId = Number(borrador.body.data.id);
    borradores.push(layoutId);

    // Un borrador nace con su piso 1; se le da rejilla para poder colocar asientos y elementos.
    const pisos = await get(`/layouts/${layoutId}/decks`, ctx.sessions.companyAdmin.token);
    deckId = Number(pisos.body.data[0].id);
    const rejilla = await patch(`/decks/${deckId}`, { row_count: 6, column_count: 4 }, ctx.sessions.companyAdmin.token);
    assert.equal(rejilla.status, 200, JSON.stringify(rejilla.body));

    const asiento = await post(`/decks/${deckId}/seats`, { seat_number: '1', row_number: 1, column_number: 1 }, ctx.sessions.companyAdmin.token);
    assert.equal(asiento.status, 201, JSON.stringify(asiento.body));
    seatId = Number(asiento.body.data.id);

    const elemento = await post(
      `/decks/${deckId}/elements`,
      { element_type: 'STAIRS', row_number: 3, column_number: 1, label: 'inicial' },
      ctx.sessions.companyAdmin.token,
    );
    assert.equal(elemento.status, 201, JSON.stringify(elemento.body));
    elementId = Number(elemento.body.data.id);
  });

  const guardado = async (sql: string, id: number): Promise<string | null> => {
    const fila = await queryOne<{ valor: string | null }>(sql, [id]);
    return fila?.valor ?? null;
  };

  const seatNumber = () => guardado('SELECT seat_number AS valor FROM seats WHERE id = ?', seatId);
  const deckName = () => guardado('SELECT name AS valor FROM bus_layout_decks WHERE id = ?', deckId);
  const layoutName = () => guardado('SELECT name AS valor FROM bus_layouts WHERE id = ?', layoutId);
  const elementLabel = () => guardado('SELECT label AS valor FROM bus_layout_elements WHERE id = ?', elementId);

  /* ============================================================ A · crear asiento */
  describe('A · seat_number al crear (varchar 10)', () => {
    it('10 caracteres: se acepta y se guarda entero', async () => {
      const r = await post(`/decks/${deckId}/seats`, { seat_number: texto(10), row_number: 2, column_number: 1 }, ctx.sessions.companyAdmin.token);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const fila = await queryOne<{ seat_number: string }>('SELECT seat_number FROM seats WHERE id = ?', [Number(r.body.data.id)]);
      assert.equal(fila?.seat_number, texto(10));
    });

    it('11 caracteres: 400 y no se crea nada', async () => {
      const antes = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM seats WHERE layout_id = ?', [layoutId]);
      const r = await post(`/decks/${deckId}/seats`, { seat_number: texto(11), row_number: 2, column_number: 1 }, ctx.sessions.companyAdmin.token);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(String(r.body.message), /no puede pasar de 10 caracteres/i);
      const despues = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM seats WHERE layout_id = ?', [layoutId]);
      assert.equal(Number(despues?.total), Number(antes?.total), 'no debe haberse creado ningún asiento');
    });
  });

  /* ============================================================ B · editar asiento */
  describe('B · seat_number al editar (varchar 10)', () => {
    it('10 caracteres: se acepta y se guarda entero', async () => {
      const r = await patch(`/layout-seats/${seatId}`, { seat_number: texto(10) }, ctx.sessions.companyAdmin.token);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(await seatNumber(), texto(10));
    });

    it('11 caracteres: 400 y el asiento conserva su número', async () => {
      const previo = await seatNumber();
      const r = await patch(`/layout-seats/${seatId}`, { seat_number: texto(11) }, ctx.sessions.companyAdmin.token);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(await seatNumber(), previo, 'el número anterior debe seguir intacto');
    });

    /**
     * EL CASO EXACTO DE LA AUDITORÍA. Antes del arreglo esto devolvía 200 y la base se quedaba
     * con 10 caracteres de los 200 enviados. Si alguien vuelve a quitar la comprobación, este
     * test lo caza.
     */
    it('200 caracteres: 400, y NO quedan 10 caracteres truncados', async () => {
      const previo = await seatNumber();
      const r = await patch(`/layout-seats/${seatId}`, { seat_number: texto(200) }, ctx.sessions.companyAdmin.token);
      assert.equal(r.status, 400, JSON.stringify(r.body));

      const actual = await seatNumber();
      assert.equal(actual, previo, 'el asiento debe conservar exactamente su valor anterior');
      assert.notEqual(actual, texto(10), 'no puede haber quedado el valor truncado a 10');
      assert.ok((actual ?? '').length <= 10);
    });

    it('espacios alrededor: se recortan antes de medir, como al crear', async () => {
      const r = await patch(`/layout-seats/${seatId}`, { seat_number: `   ${texto(10)}   ` }, ctx.sessions.companyAdmin.token);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(await seatNumber(), texto(10));
    });

    it('caracteres Unicode: un valor que MySQL no podría guardar entero se rechaza', async () => {
      const previo = await seatNumber();
      // 11 acentuadas: 11 puntos de código, más de los 10 que admite la columna.
      const r = await patch(`/layout-seats/${seatId}`, { seat_number: 'ñ'.repeat(11) }, ctx.sessions.companyAdmin.token);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(await seatNumber(), previo);
    });
  });

  /* ============================================================ C · nombre de versión */
  describe('C · bus_layouts.name (varchar 100)', () => {
    it('100 caracteres: se acepta y se guarda entero', async () => {
      const r = await post('/buses/' + ctx.fixtures.busA + '/layouts', { name: texto(100) }, ctx.sessions.companyAdmin.token);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      borradores.push(Number(r.body.data.id));
      const fila = await queryOne<{ name: string }>('SELECT name FROM bus_layouts WHERE id = ?', [Number(r.body.data.id)]);
      assert.equal(fila?.name, texto(100));
    });

    it('101 caracteres: 400 y no se crea ninguna versión', async () => {
      const antes = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM bus_layouts WHERE bus_id = ?', [ctx.fixtures.busA]);
      const r = await post('/buses/' + ctx.fixtures.busA + '/layouts', { name: texto(101) }, ctx.sessions.companyAdmin.token);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(String(r.body.message), /no puede pasar de 100 caracteres/i);
      const despues = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM bus_layouts WHERE bus_id = ?', [ctx.fixtures.busA]);
      assert.equal(Number(despues?.total), Number(antes?.total));
    });

    it('300 caracteres: 400 y no quedan 100 truncados', async () => {
      // Se cuenta ANTES y DESPUÉS: otro caso de este bloque crea de forma legítima una versión
      // llamada con 100 caracteres, y un conteo absoluto la confundiría con un truncado.
      const conNombreTope = async (): Promise<number> => {
        const fila = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM bus_layouts WHERE name = ?', [texto(100)]);
        return Number(fila?.total ?? 0);
      };
      const antes = await conNombreTope();
      const r = await post('/buses/' + ctx.fixtures.busA + '/layouts', { name: texto(300) }, ctx.sessions.companyAdmin.token);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(await conNombreTope(), antes, 'no puede haberse guardado una versión con el nombre recortado');
    });

    it('el nombre de un piso inicial también se mide', async () => {
      const r = await post(
        '/buses/' + ctx.fixtures.busA + '/layouts',
        { name: 'SEC02B', decks: [{ deck_number: 1, name: texto(101) }] },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(String(r.body.message), /nombre del piso/i);
    });
  });

  /* ============================================================ D · nombre de piso */
  describe('D · bus_layout_decks.name (varchar 100)', () => {
    it('100 caracteres al editar: se acepta y se guarda entero', async () => {
      const r = await patch(`/decks/${deckId}`, { name: texto(100) }, ctx.sessions.companyAdmin.token);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(await deckName(), texto(100));
    });

    it('101 caracteres al editar: 400 y el piso conserva su nombre', async () => {
      const previo = await deckName();
      const r = await patch(`/decks/${deckId}`, { name: texto(101) }, ctx.sessions.companyAdmin.token);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(await deckName(), previo);
    });

    it('101 caracteres al crear: 400 y no se crea el piso', async () => {
      const r = await post(`/layouts/${layoutId}/decks`, { deck_number: 2, name: texto(101), row_count: 2, column_count: 2 }, ctx.sessions.companyAdmin.token);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      const creado = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM bus_layout_decks WHERE layout_id = ? AND deck_number = 2', [layoutId]);
      assert.equal(Number(creado?.total), 0);
    });

    it('100 caracteres al crear: se acepta', async () => {
      const r = await post(`/layouts/${layoutId}/decks`, { deck_number: 2, name: texto(100), row_count: 2, column_count: 2 }, ctx.sessions.companyAdmin.token);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const fila = await queryOne<{ name: string }>('SELECT name FROM bus_layout_decks WHERE id = ?', [Number(r.body.data.id)]);
      assert.equal(fila?.name, texto(100));
    });
  });

  /* ============================================================ E · etiqueta de elemento */
  describe('E · bus_layout_elements.label (varchar 100)', () => {
    it('100 caracteres al editar: se acepta y se guarda entero', async () => {
      const r = await patch(`/elements/${elementId}`, { label: texto(100) }, ctx.sessions.companyAdmin.token);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(await elementLabel(), texto(100));
    });

    it('101 caracteres al editar: 400 y el elemento conserva su etiqueta', async () => {
      const previo = await elementLabel();
      const r = await patch(`/elements/${elementId}`, { label: texto(101) }, ctx.sessions.companyAdmin.token);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(await elementLabel(), previo);
    });

    it('101 caracteres al crear: 400 y no se crea el elemento', async () => {
      const antes = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM bus_layout_elements WHERE deck_id = ?', [deckId]);
      const r = await post(
        `/decks/${deckId}/elements`,
        { element_type: 'BATHROOM', row_number: 5, column_number: 1, label: texto(101) },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(r.status, 400, JSON.stringify(r.body));
      const despues = await queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM bus_layout_elements WHERE deck_id = ?', [deckId]);
      assert.equal(Number(despues?.total), Number(antes?.total));
    });

    it('100 caracteres al crear: se acepta', async () => {
      const r = await post(
        `/decks/${deckId}/elements`,
        { element_type: 'BATHROOM', row_number: 5, column_number: 1, label: texto(100) },
        ctx.sessions.companyAdmin.token,
      );
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const fila = await queryOne<{ label: string }>('SELECT label FROM bus_layout_elements WHERE id = ?', [Number(r.body.data.id)]);
      assert.equal(fila?.label, texto(100));
    });
  });

  /* ============================================================ F · nada se trunca */
  it('F · ningún texto de la distribución quedó recortado al tope de su columna', async () => {
    for (const [tabla, columna, tope] of [
      ['bus_layouts', 'name', 100],
      ['bus_layout_decks', 'name', 100],
      ['bus_layout_elements', 'label', 100],
      ['seats', 'seat_number', 10],
    ] as const) {
      const fila = await queryOne<{ total: number }>(
        `SELECT COUNT(*) AS total FROM ${tabla} WHERE CHAR_LENGTH(${columna}) > ?`,
        [tope],
      );
      assert.equal(Number(fila?.total), 0, `${tabla}.${columna} no debería pasar de ${tope}`);
    }
  });

  /* ============================================================ G+H · el aislamiento sigue */
  describe('G · los límites nuevos no abren ni debilitan el aislamiento', () => {
    it('la empresa B recibe 403 con un valor VÁLIDO sobre recursos de la empresa A', async () => {
      const token = ctx.sessions.companyAdminB.token;
      for (const [metodo, ruta, body] of [
        ['patch', `/layout-seats/${seatId}`, { seat_number: texto(10) }],
        ['patch', `/decks/${deckId}`, { name: texto(100) }],
        ['patch', `/elements/${elementId}`, { label: texto(100) }],
        ['post', `/decks/${deckId}/seats`, { seat_number: '9', row_number: 4, column_number: 1 }],
      ] as const) {
        const r = metodo === 'patch' ? await patch(ruta, body, token) : await post(ruta, body, token);
        assert.equal(r.status, 403, `${metodo} ${ruta}: ${JSON.stringify(r.body)}`);
      }
    });

    it('la empresa B recibe 403 con un valor INVÁLIDO: el límite no revela nada', async () => {
      const token = ctx.sessions.companyAdminB.token;
      for (const [ruta, body] of [
        [`/layout-seats/${seatId}`, { seat_number: texto(200) }],
        [`/decks/${deckId}`, { name: texto(300) }],
        [`/elements/${elementId}`, { label: texto(300) }],
      ] as const) {
        const r = await patch(ruta, body, token);
        assert.equal(r.status, 403, `${ruta}: ${JSON.stringify(r.body)}`);
        assert.match(String(r.body.message), /otra empresa/i, 'el motivo debe ser la empresa, no la longitud');
      }
    });

    it('un asiento de la empresa A sigue sin poder moverse a un piso de la empresa B', async () => {
      const ajeno = await queryOne<{ id: number }>(
        `SELECT d.id FROM bus_layout_decks d
         JOIN bus_layouts bl ON bl.id = d.layout_id
         JOIN buses b ON b.id = bl.bus_id
         WHERE b.company_id = ? LIMIT 1`,
        [ctx.fixtures.companyB],
      );
      assert.ok(ajeno, 'la empresa B debería tener algún piso');
      const r = await patch(`/layout-seats/${seatId}`, { deck_id: ajeno.id }, ctx.sessions.companyAdmin.token);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(String(r.body.message), /otra versi[óo]n/i);

      const fila = await queryOne<{ deck_id: number }>('SELECT deck_id FROM seats WHERE id = ?', [seatId]);
      assert.equal(Number(fila?.deck_id), deckId, 'el asiento no puede haberse movido');
    });
  });
});
