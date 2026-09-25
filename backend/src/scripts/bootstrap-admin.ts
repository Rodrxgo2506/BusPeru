/**
 * Alta del PRIMER administrador de la plataforma (F18-02).
 *
 *   Producción:  npm run admin:bootstrap        (node dist/scripts/bootstrap-admin.js)
 *   Desarrollo:  npm run admin:bootstrap:dev    (solo contra una base *_test)
 *
 * Qué hace, en orden, y por qué:
 *   1. No acepta argumentos. Así la contraseña no puede acabar en la línea de órdenes, en el historial
 *      de la consola ni en la lista de procesos.
 *   2. Carga la configuración, lo que ejecuta las guardas existentes: fuera de producción solo se
 *      admite una base `*_test`; en producción la configuración tiene que estar completa y segura. Si
 *      una guarda rechaza la configuración, el proceso termina SIN abrir ninguna conexión.
 *   3. Comprueba la conexión y que no haya ya un administrador. Si lo hay, termina sin pedir nada.
 *   4. Pide correo, nombres, apellidos y la contraseña dos veces. Con una consola interactiva la
 *      contraseña se teclea sin eco; si la entrada llega por tubería, se lee de ella (nunca de un
 *      argumento).
 *   5. Pide escribir el nombre de la base como confirmación explícita de a dónde se va a escribir.
 *   6. Crea el administrador en una sola transacción (`admin-bootstrap.service.ts`).
 *
 * La contraseña no se imprime, no se registra y no aparece en ningún mensaje de error.
 */
import readline from 'readline';

type Linea = () => Promise<string>;

/** Con la entrada por tubería se leen todas las líneas de golpe y se entregan en orden. */
async function lectorDeTuberia(): Promise<Linea> {
  const trozos: Buffer[] = [];
  for await (const trozo of process.stdin) trozos.push(trozo as Buffer);
  const lineas = Buffer.concat(trozos).toString('utf8').split(/\r?\n/);
  let i = 0;
  return async () => {
    if (i >= lineas.length) throw new Error('Faltan datos en la entrada estándar');
    return lineas[i++] ?? '';
  };
}

/** Pregunta visible en una consola interactiva. */
function preguntar(texto: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    rl.question(texto, (respuesta) => {
      rl.close();
      resolve(respuesta);
    });
  });
}

/** Pregunta SIN eco para la contraseña: no se muestra ni un carácter. */
function preguntarOculto(texto: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(texto);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let valor = '';
    const terminar = () => {
      stdin.removeListener('data', alTeclear);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
    };
    const alTeclear = (tecleado: string) => {
      for (const c of tecleado) {
        if (c === '\r' || c === '\n') {
          terminar();
          resolve(valor);
          return;
        }
        if (c === '') {
          terminar();
          reject(new Error('Cancelado por el usuario'));
          return;
        }
        if (c === '' || c === '\b') valor = valor.slice(0, -1);
        else valor += c;
      }
    };
    stdin.on('data', alTeclear);
  });
}

interface Datos {
  email: string;
  first_name: string;
  last_name: string;
  password: string;
  passwordRepetida: string;
  confirmacionBase: string;
}

async function leerDatos(nombreBase: string): Promise<Datos> {
  if (process.stdin.isTTY) {
    return {
      email: (await preguntar('Correo del administrador: ')).trim(),
      first_name: await preguntar('Nombres: '),
      last_name: await preguntar('Apellidos: '),
      password: await preguntarOculto('Contraseña (no se muestra): '),
      passwordRepetida: await preguntarOculto('Repite la contraseña: '),
      confirmacionBase: (await preguntar(`Escribe el nombre de la base (${nombreBase}) para confirmar: `)).trim(),
    };
  }
  const siguiente = await lectorDeTuberia();
  return {
    email: (await siguiente()).trim(),
    first_name: await siguiente(),
    last_name: await siguiente(),
    password: await siguiente(),
    passwordRepetida: await siguiente(),
    confirmacionBase: (await siguiente()).trim(),
  };
}

async function main(): Promise<number> {
  if (process.argv.length > 2) {
    console.error('✖ Este comando no acepta argumentos: los datos se piden de forma interactiva y la contraseña nunca va en la línea de órdenes.');
    return 2;
  }

  // Las guardas de configuración se ejecutan al cargar `env`. Si rechazan la configuración, se
  // termina aquí: todavía no existe el pool y no se ha abierto ninguna conexión.
  let env: typeof import('../config/env').env;
  try {
    ({ env } = await import('../config/env'));
  } catch (error) {
    console.error(`✖ Configuración rechazada: ${(error as Error).message}`);
    return 1;
  }

  const { verifyConnection, pool } = await import('../config/database');
  const servicio = await import('../services/admin-bootstrap.service');
  const { logError } = await import('../utils/logger');

  console.log(`Alta del primer administrador · entorno: ${env.nodeEnv} · base: ${env.db.name}`);
  try {
    await verifyConnection();
    if (await servicio.adminExists()) {
      console.error('✖ Ya existe un administrador. El alta inicial solo se hace una vez y no se ha modificado nada.');
      return 1;
    }

    const datos = await leerDatos(env.db.name);
    if (datos.password !== datos.passwordRepetida) {
      console.error('✖ Las contraseñas no coinciden. No se ha modificado nada.');
      return 1;
    }
    if (datos.confirmacionBase !== env.db.name) {
      console.error('✖ El nombre de la base no coincide con la configurada. No se ha modificado nada.');
      return 1;
    }

    const { id } = await servicio.bootstrapFirstAdmin({
      email: datos.email,
      password: datos.password,
      first_name: datos.first_name,
      last_name: datos.last_name,
    });
    console.log(`✔ Administrador creado (id ${id}). Ya puede iniciar sesión con el correo indicado.`);
    return 0;
  } catch (error) {
    if (error instanceof servicio.AdminBootstrapError) {
      console.error(`✖ ${error.message}`);
      return 1;
    }
    // El objeto de error puede traer la sentencia SQL con sus valores: nunca se imprime tal cual.
    logError('No se pudo completar el alta del primer administrador', error);
    console.error('✖ No se pudo crear el administrador. No se ha modificado nada. El detalle está en el registro de errores.');
    return 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

void main().then((codigo) => {
  process.exitCode = codigo;
});
