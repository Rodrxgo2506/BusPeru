import './helpers/testEnv';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { execute, queryOne } from '../config/database';
import { env } from '../config/env';
import { isValidEncryptionKey } from '../config/secrets-guard';
import { decryptJson, encryptJson, hasUnreadableCredentials, isEncryptionConfigured } from '../services/encryption.service';
import * as integraciones from '../services/company-integration.service';
import { PROVIDERS } from '../services/integration-catalog';
import { redactKnownSecrets } from '../utils/log-sanitizer';
import { prepareSuite, teardownSuite, type SuiteContext } from './helpers/suite';

/**
 * F17C-SEC-08 · cifrado de credenciales, nonces y rotación de clave.
 *
 * La suite `18-company-integrations` ya defiende lo básico —que nada se guarde en claro, que una
 * fila manipulada no descifre, que otra clave no sirva, que la API no devuelva credenciales, y el
 * aislamiento entre empresas—. Aquí van los huecos que abrió la auditoría SEC-08:
 *
 *   · LA ROTACIÓN, que antes era imposible: cambiar la clave dejaba ilegible para siempre todo lo
 *     escrito, porque el servicio solo conocía una. Ahora admite una clave anterior solo-lectura.
 *   · SEC08-01, que es el hallazgo de verdad: con el sobre ilegible, guardar un campo BORRABA los
 *     demás en silencio y sin vuelta atrás, y el panel invitaba justo a eso al mostrar la
 *     integración como «sin configurar».
 *   · El campo `v` del sobre, que existía para permitir rotar de algoritmo y que nadie miraba.
 *
 * NINGUNA prueba imprime una clave ni una credencial. Las claves son aleatorias y viven en este
 * proceso; `.env` no se toca y ninguna clave real interviene.
 */

const CLAVE_A = crypto.randomBytes(32).toString('hex');
const CLAVE_B = crypto.randomBytes(32).toString('hex');
/** Valor de prueba, inventado aquí mismo. No es una credencial de nadie. */
const SECRETO = { api_key: 'valor-de-prueba-aaaa', client_secret: 'valor-de-prueba-bbbb' };

/** Fija las claves SOLO en la memoria de este proceso. */
function usarClaves(vigente: string, anterior = ''): void {
  (env.integrations as { encryptionKey: string }).encryptionKey = vigente;
  (env.integrations as { previousEncryptionKey: string }).previousEncryptionKey = anterior;
}

const sobreDe = (texto: string) => JSON.parse(texto) as Record<string, string>;
const voltearPrimerByte = (b64: string) => {
  const bytes = Buffer.from(b64, 'base64');
  bytes[0] = bytes[0]! ^ 0xff;
  return bytes.toString('base64');
};

describe('SEC-08 · cifrado y rotación de claves', () => {
  let ctx: SuiteContext;
  let claveOriginal = '';
  let anteriorOriginal = '';
  const proveedor = PROVIDERS[0]!;

  before(async () => {
    ctx = await prepareSuite();
    claveOriginal = env.integrations.encryptionKey;
    anteriorOriginal = env.integrations.previousEncryptionKey;
  });
  after(async () => {
    usarClaves(claveOriginal, anteriorOriginal);
    await teardownSuite();
  });

  beforeEach(async () => {
    usarClaves(CLAVE_A);
    await execute('DELETE FROM company_integrations');
  });

  /* ================================================== el sobre */
  describe('el sobre guardado', () => {
    it('lleva AES-256-GCM con nonce de 12 bytes y etiqueta de 16', async () => {
      const sobre = sobreDe(encryptJson(SECRETO));

      assert.equal(sobre.alg, 'AES-256-GCM');
      assert.equal(Number(sobre.v), 1, 'la versión debe quedar escrita para poder rotar de formato');
      assert.equal(Buffer.from(sobre.iv!, 'base64').length, 12, 'GCM usa nonce de 96 bits');
      assert.equal(Buffer.from(sobre.tag!, 'base64').length, 16, 'la etiqueta completa, sin truncar');
    });

    it('no deja ni rastro del contenido en claro', () => {
      const sobre = encryptJson(SECRETO);
      for (const valor of Object.values(SECRETO)) {
        assert.ok(!sobre.includes(valor), 'el sobre no puede contener el valor original');
      }
      assert.deepEqual(decryptJson(sobre), SECRETO, 'y aun así tiene que poder recuperarse entero');
    });

    it('conserva intactos los caracteres que suelen romper capas intermedias', () => {
      // Comillas, barras, comodines de LIKE y dos puntos: nada de esto se concatena en SQL ni
      // actúa como delimitador, porque el sobre es JSON y el valor viaja parametrizado.
      const raro = { api_key: `'"\\%_:;|::<>&\n\t{}[]`, client_secret: 'ñÁ€漢字🚌' };
      assert.deepEqual(decryptJson(encryptJson(raro)), raro);
    });
  });

  /* ================================================== nonces */
  describe('nonces', () => {
    /**
     * Que en 1000 cifrados no se repita un nonce NO demuestra unicidad: con 96 bits aleatorios la
     * probabilidad de choque en esa muestra es despreciable, así que el resultado sería el mismo
     * aunque el generador fuese mediocre. Lo que esta prueba descarta es lo que de verdad pasa en
     * la práctica: un nonce fijo, uno global, o uno derivado del identificador del registro. La
     * garantía real viene del diseño —`crypto.randomBytes` nuevo en cada escritura—, no del conteo.
     */
    for (const cantidad of [100, 500, 1000]) {
      it(`${cantidad} cifrados del mismo contenido dan ${cantidad} nonces distintos`, () => {
        const nonces = new Set<string>();
        const textos = new Set<string>();
        for (let i = 0; i < cantidad; i += 1) {
          const sobre = sobreDe(encryptJson(SECRETO));
          nonces.add(sobre.iv!);
          textos.add(sobre.data!);
        }
        assert.equal(nonces.size, cantidad, 'un nonce repetido bajo la misma clave rompe GCM por completo');
        assert.equal(textos.size, cantidad, 'el mismo texto cifrado dos veces no puede dar el mismo resultado');
      });
    }

    it('cifrar en paralelo tampoco repite nonces', async () => {
      const sobres = await Promise.all(Array.from({ length: 200 }, async () => encryptJson(SECRETO)));
      const nonces = new Set(sobres.map((s) => sobreDe(s).iv!));
      assert.equal(nonces.size, sobres.length);
    });

    it('un nonce repetido entre claves DISTINTAS no es un defecto', () => {
      // La unicidad que exige GCM es por clave. Se deja escrito para que nadie lo reporte como
      // fallo: lo que importa es que bajo una misma clave no se repita.
      const sobre = sobreDe(encryptJson(SECRETO));
      usarClaves(CLAVE_B);
      const otro = sobreDe(encryptJson(SECRETO));
      assert.ok(sobre.iv !== otro.iv, 'aun así, en la práctica tampoco coinciden');
    });
  });

  /* ================================================== manipulación */
  describe('manipulación del sobre', () => {
    for (const [etiqueta, alterar] of [
      ['el texto cifrado', (s: Record<string, string>) => ({ ...s, data: voltearPrimerByte(s.data!) })],
      ['el nonce', (s: Record<string, string>) => ({ ...s, iv: voltearPrimerByte(s.iv!) })],
      ['la etiqueta', (s: Record<string, string>) => ({ ...s, tag: voltearPrimerByte(s.tag!) })],
      ['el último byte del texto', (s: Record<string, string>) => {
        const b = Buffer.from(s.data!, 'base64');
        b[b.length - 1] = b[b.length - 1]! ^ 0x01;
        return { ...s, data: b.toString('base64') };
      }],
      ['el algoritmo declarado', (s: Record<string, string>) => ({ ...s, alg: 'AES-128-GCM' })],
      ['la versión, a una desconocida', (s: Record<string, string>) => ({ ...s, v: 2 })],
      ['el texto, truncándolo', (s: Record<string, string>) => ({ ...s, data: s.data!.slice(0, -8) })],
      ['la etiqueta, truncándola', (s: Record<string, string>) => ({ ...s, tag: s.tag!.slice(0, 8) })],
      ['el nonce, vaciándolo', (s: Record<string, string>) => ({ ...s, iv: '' })],
    ] as const) {
      it(`alterar ${etiqueta} impide descifrar`, () => {
        const original = sobreDe(encryptJson(SECRETO));
        const alterado = JSON.stringify(alterar(original as never));

        assert.equal(decryptJson(alterado), null, 'la etiqueta se valida ANTES de devolver nada');
        assert.equal(hasUnreadableCredentials(alterado), true, 'y el sistema sabe que hay algo que no puede leer');
      });
    }

    for (const [etiqueta, entrada] of [
      ['una cadena vacía', ''],
      ['un JSON roto', '{no es json'],
      ['un array', '[]'],
      ['un objeto sin nuestros campos', '{"hola":1}'],
      ['base64 imposible en el texto', '{"v":1,"alg":"AES-256-GCM","iv":"AAAA","tag":"AAAA","data":"!!!!"}'],
    ] as const) {
      it(`${etiqueta} se rechaza sin lanzar`, () => {
        assert.doesNotThrow(() => decryptJson(entrada));
        assert.equal(decryptJson(entrada), null);
      });
    }

    it('una versión futura no se intenta abrir con las reglas de hoy', () => {
      // El campo `v` estaba escrito pero nadie lo comprobaba: un sobre `v:2` se habría procesado
      // como si fuera v1. Ahora se rechaza de plano, que es lo que permite cambiar de formato.
      const sobre = sobreDe(encryptJson(SECRETO));
      assert.equal(decryptJson(JSON.stringify({ ...sobre, v: 2 })), null);
      assert.equal(decryptJson(JSON.stringify({ ...sobre, v: 999 })), null);
      assert.deepEqual(decryptJson(JSON.stringify({ ...sobre, v: 1 })), SECRETO, 'la versión vigente sigue abriéndose');
    });
  });

  /* ================================================== claves */
  describe('la clave', () => {
    for (const [etiqueta, valor, aceptada] of [
      ['32 bytes en hex', CLAVE_A, true],
      ['32 bytes en base64', Buffer.from(CLAVE_A, 'hex').toString('base64'), true],
      ['hex de 63 caracteres', CLAVE_A.slice(0, 63), false],
      ['cadena corta', 'clave-corta', false],
      ['vacía', '', false],
      ['44 caracteres que no son base64', '!'.repeat(44), false],
    ] as const) {
      it(`${etiqueta}: ${aceptada ? 'se acepta' : 'se rechaza'}`, () => {
        usarClaves(valor);
        assert.equal(isEncryptionConfigured(), aceptada);
      });
    }

    it('sin clave no se descifra nada y tampoco se rompe el proceso', () => {
      const sobre = encryptJson(SECRETO);
      usarClaves('');

      assert.equal(isEncryptionConfigured(), false);
      assert.doesNotThrow(() => decryptJson(sobre));
      assert.equal(decryptJson(sobre), null, 'jamás se devuelve el ciphertext como si fuera el contenido');
      assert.equal(hasUnreadableCredentials(sobre), true);
    });

    it('no existe clave por defecto ni de reserva', () => {
      // Si hubiera un valor de respaldo escondido, quitar la clave seguiría descifrando.
      const sobre = encryptJson(SECRETO);
      for (const intento of ['', '   ', 'changeme', 'development', 'secret']) {
        usarClaves(intento);
        assert.equal(decryptJson(sobre), null, `«${intento}» no puede servir como clave`);
      }
    });

    it('la guarda de producción exige el formato exacto', () => {
      assert.equal(isValidEncryptionKey(CLAVE_A), true);
      assert.equal(isValidEncryptionKey(Buffer.from(CLAVE_A, 'hex').toString('base64')), true);
      assert.equal(isValidEncryptionKey(CLAVE_A.slice(0, 63)), false);
      assert.equal(isValidEncryptionKey('!'.repeat(44)), false);
      assert.equal(isValidEncryptionKey(''), false);
    });
  });

  /* ================================================== rotación */
  describe('rotación de clave', () => {
    it('con la clave anterior configurada, lo antiguo se sigue leyendo', () => {
      const viejo = encryptJson(SECRETO);

      usarClaves(CLAVE_B, CLAVE_A);

      assert.deepEqual(decryptJson(viejo), SECRETO, 'sin esto, rotar la clave destruiría todo lo guardado');
      assert.equal(hasUnreadableCredentials(viejo), false);
    });

    it('lo nuevo se escribe siempre con la clave vigente', () => {
      usarClaves(CLAVE_B, CLAVE_A);
      const nuevo = encryptJson(SECRETO);

      usarClaves(CLAVE_B);
      assert.deepEqual(decryptJson(nuevo), SECRETO, 'la clave vigente basta para lo recién escrito');

      usarClaves(CLAVE_A);
      assert.equal(decryptJson(nuevo), null, 'la clave antigua no abre lo nuevo');
    });

    it('durante una rotación a medias conviven los dos grupos de datos', () => {
      const conA = encryptJson(SECRETO);
      usarClaves(CLAVE_B, CLAVE_A);
      const conB = encryptJson({ api_key: 'valor-de-prueba-cccc' });

      assert.deepEqual(decryptJson(conA), SECRETO, 'los registros aún no migrados');
      assert.deepEqual(decryptJson(conB), { api_key: 'valor-de-prueba-cccc' }, 'y los ya migrados');
    });

    it('retirar la clave anterior antes de tiempo deja lo viejo ilegible, sin destruirlo', () => {
      const viejo = encryptJson(SECRETO);
      usarClaves(CLAVE_B);

      assert.equal(decryptJson(viejo), null);
      assert.equal(hasUnreadableCredentials(viejo), true, 'el sistema debe SABER que hay algo que no lee');
      // El sobre no se toca: volviendo a poner la clave anterior, se recupera.
      usarClaves(CLAVE_B, CLAVE_A);
      assert.deepEqual(decryptJson(viejo), SECRETO);
    });

    it('una clave anterior mal formada no impide leer lo cifrado con la vigente', () => {
      usarClaves(CLAVE_A, 'esto-no-es-una-clave');
      const sobre = encryptJson(SECRETO);
      assert.deepEqual(decryptJson(sobre), SECRETO);
    });

    it('no hay vuelta atrás silenciosa: lo reescrito queda bajo la clave nueva', () => {
      const viejo = encryptJson(SECRETO);
      usarClaves(CLAVE_B, CLAVE_A);
      const reescrito = encryptJson(decryptJson(viejo)!);

      usarClaves(CLAVE_A);
      assert.equal(decryptJson(reescrito), null, 'un registro ya migrado no vuelve a depender de la clave vieja');
    });
  });

  /* ================================================== SEC08-01 */
  describe('SEC08-01 · no se escribe encima de un sobre ilegible', () => {
    const scope = () => ({ kind: 'COMPANY' as const, companyId: ctx.fixtures.companyA });
    const guardado = () =>
      queryOne<{ credentials: string | null }>(
        'SELECT credentials FROM company_integrations WHERE company_id = ? AND provider = ?',
        [ctx.fixtures.companyA, proveedor.provider],
      );

    const configurarTodo = async () => {
      const todos: Record<string, unknown> = {};
      for (const campo of proveedor.fields) todos[campo.name] = `valor-de-prueba-${campo.name}`;
      await integraciones.save(scope(), proveedor.provider, todos);
      return (await guardado())!.credentials!;
    };

    /**
     * REGRESIÓN DEL HALLAZGO. Antes: con el sobre ilegible, `save` no distinguía «no había nada»
     * de «no lo puedo leer», así que guardar un campo escribía un sobre nuevo con SOLO ese campo
     * y el original desaparecía. Ni recuperando la clave correcta volvían los demás.
     */
    it('guardar un campo con el sobre ilegible se rechaza y no toca la base', async () => {
      const original = await configurarTodo();
      usarClaves(CLAVE_B); // clave cambiada sin re-cifrar, y sin declarar la anterior

      const primero = proveedor.fields[0]!.name;
      await assert.rejects(
        () => integraciones.save(scope(), proveedor.provider, { [primero]: 'valor-de-prueba-nuevo' }),
        (error: { statusCode?: number }) => error.statusCode === 409,
        'debe negarse en vez de sobrescribir',
      );

      assert.equal((await guardado())!.credentials, original, 'el sobre original sigue byte a byte igual');

      usarClaves(CLAVE_A);
      const recuperado = await integraciones.detail(scope(), proveedor.provider);
      assert.deepEqual(
        recuperado.configured_fields.sort(),
        proveedor.fields.map((c) => c.name).sort(),
        'con la clave correcta de vuelta, no se ha perdido nada',
      );
    });

    it('con la clave anterior declarada, guardar un campo conserva los demás y re-cifra', async () => {
      await configurarTodo();
      usarClaves(CLAVE_B, CLAVE_A); // rotación bien hecha

      const primero = proveedor.fields[0]!.name;
      await integraciones.save(scope(), proveedor.provider, { [primero]: 'valor-de-prueba-nuevo' });

      const vista = await integraciones.detail(scope(), proveedor.provider);
      assert.deepEqual(
        vista.configured_fields.sort(),
        proveedor.fields.map((c) => c.name).sort(),
        'los campos no tecleados se conservan',
      );

      usarClaves(CLAVE_B);
      const soloConLaNueva = await integraciones.detail(scope(), proveedor.provider);
      assert.equal(soloConLaNueva.configured_fields.length, proveedor.fields.length,
        'y el registro ya no depende de la clave antigua: la reescritura lo migró');
    });

    it('una fila alterada tampoco se sobrescribe a ciegas', async () => {
      const original = await configurarTodo();
      const roto = JSON.stringify({ ...sobreDe(original), tag: voltearPrimerByte(sobreDe(original).tag!) });
      await execute('UPDATE company_integrations SET credentials = ? WHERE company_id = ? AND provider = ?',
        [roto, ctx.fixtures.companyA, proveedor.provider]);

      await assert.rejects(
        () => integraciones.save(scope(), proveedor.provider, { [proveedor.fields[0]!.name]: 'valor-de-prueba-x' }),
        (error: { statusCode?: number }) => error.statusCode === 409,
      );
    });

    it('desconectar sigue siendo la vía explícita para empezar de cero', async () => {
      await configurarTodo();
      usarClaves(CLAVE_B);

      // Borrar es una decisión consciente del usuario, y por eso sí se permite.
      await integraciones.disconnect(scope(), proveedor.provider);
      assert.equal((await guardado())!.credentials, null, 'desconectar borra las credenciales');

      const tras = await integraciones.save(scope(), proveedor.provider, { [proveedor.fields[0]!.name]: 'valor-de-prueba-z' });
      assert.deepEqual(tras.view.configured_fields, [proveedor.fields[0]!.name], 'y después se puede configurar de nuevo');
    });

    it('un registro nuevo, sin nada guardado, se crea sin estorbos', async () => {
      const vista = await integraciones.save(scope(), proveedor.provider, { [proveedor.fields[0]!.name]: 'valor-de-prueba-y' });
      assert.equal(vista.created, true, 'no confundir «no hay nada» con «no se puede leer»');
    });
  });

  /* ================================================== concurrencia */
  describe('concurrencia', () => {
    const scope = () => ({ kind: 'COMPANY' as const, companyId: ctx.fixtures.companyA });

    it('varios guardados a la vez dejan un sobre válido y descifrable', async () => {
      const campo = proveedor.fields[0]!.name;
      await Promise.all(
        Array.from({ length: 8 }, async (_unused, i) =>
          integraciones.save(scope(), proveedor.provider, { [campo]: `valor-de-prueba-${i}` }).catch(() => undefined)),
      );

      const fila = await queryOne<{ credentials: string | null }>(
        'SELECT credentials FROM company_integrations WHERE company_id = ? AND provider = ?',
        [ctx.fixtures.companyA, proveedor.provider],
      );
      assert.ok(fila?.credentials, 'debe quedar exactamente una fila con contenido');
      const contenido = decryptJson(fila.credentials);
      assert.ok(contenido !== null, 'el sobre resultante no puede quedar corrupto');
      assert.equal(typeof contenido[campo], 'string');
    });

    it('descifrar en paralelo devuelve siempre lo mismo', async () => {
      const sobre = encryptJson(SECRETO);
      const resultados = await Promise.all(Array.from({ length: 50 }, async () => decryptJson(sobre)));
      for (const resultado of resultados) assert.deepEqual(resultado, SECRETO);
    });
  });

  /* ================================================== secretos fuera de los registros */
  describe('nada de esto acaba en un registro', () => {
    it('el saneador de trazas tapa las dos claves', () => {
      usarClaves(CLAVE_A, CLAVE_B);
      const texto = `una traza cualquiera con ${CLAVE_A} y también ${CLAVE_B} dentro`;
      const limpio = redactKnownSecrets(texto);

      assert.ok(!limpio.includes(CLAVE_A), 'la clave vigente no puede quedar en un registro');
      assert.ok(!limpio.includes(CLAVE_B), 'ni la anterior durante una rotación');
    });

    it('el error de un sobre ilegible no cuenta nada del fallo criptográfico', async () => {
      const todos: Record<string, unknown> = {};
      for (const campo of proveedor.fields) todos[campo.name] = `valor-de-prueba-${campo.name}`;
      await integraciones.save({ kind: 'COMPANY', companyId: ctx.fixtures.companyA }, proveedor.provider, todos);
      usarClaves(CLAVE_B);

      const error = await integraciones
        .save({ kind: 'COMPANY', companyId: ctx.fixtures.companyA }, proveedor.provider, { [proveedor.fields[0]!.name]: 'x' })
        .then(() => null, (e: Error) => e);

      const mensaje = String(error?.message ?? '');
      assert.ok(mensaje.length > 0);
      for (const prohibido of [CLAVE_A, CLAVE_B, ...Object.values(SECRETO)]) {
        assert.ok(!mensaje.includes(prohibido), 'el mensaje no puede llevar claves ni credenciales');
      }
      assert.ok(!/auth ?tag|unable to authenticate|bad decrypt/i.test(mensaje), 'ni el detalle técnico del descifrado');
    });

    it('la base no guarda la clave junto al dato', async () => {
      await integraciones.save({ kind: 'COMPANY', companyId: ctx.fixtures.companyA }, proveedor.provider,
        { [proveedor.fields[0]!.name]: 'valor-de-prueba-w' });

      const fila = await queryOne<Record<string, unknown>>(
        'SELECT * FROM company_integrations WHERE company_id = ?', [ctx.fixtures.companyA]);
      const volcado = JSON.stringify(fila);
      assert.ok(!volcado.includes(CLAVE_A), 'la clave vive en la configuración del servidor, nunca en la base');
      assert.ok(!volcado.includes('valor-de-prueba-w'), 'y el valor nunca en claro');
    });
  });
});
