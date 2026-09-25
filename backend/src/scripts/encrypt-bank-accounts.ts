/**
 * F18-07 · cifrado de los datos bancarios existentes (acompaña a la migración 019).
 *
 *   npm run bank:encrypt -- --verificar
 *   npm run bank:encrypt -- --cifrar
 *   npm run bank:encrypt -- --purgar-texto-plano --base=<nombre de la base>
 *   npm run bank:encrypt -- --revertir --base=<nombre de la base>
 *   npm run bank:encrypt -- --recifrar          (F18-07A: rotación, pasa todo a la clave vigente)
 *
 * Orden en un entorno con datos: migración 019 → `--cifrar` → `--verificar` → desplegar la API
 * nueva → `--purgar-texto-plano`. Los pasos que borran o reponen texto en claro exigen repetir el
 * nombre de la base, como el alta del primer administrador: una orden pegada contra la base
 * equivocada no hace nada.
 *
 * Solo imprime recuentos. Ningún número de cuenta, CCI, sobre ni clave sale por pantalla.
 */
const USO = 'uso: --verificar | --cifrar | --recifrar | --purgar-texto-plano --base=<base> | --revertir --base=<base>';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const modo = ['--verificar', '--cifrar', '--recifrar', '--purgar-texto-plano', '--revertir'].find((m) => args.includes(m));
  if (!modo || args.filter((a) => a.startsWith('--') && !a.startsWith('--base=')).length !== 1) {
    console.error(`✖ ${USO}`);
    return 2;
  }

  let env: typeof import('../config/env').env;
  try {
    ({ env } = await import('../config/env'));
  } catch (error) {
    console.error(`✖ Configuración rechazada: ${(error as Error).message}`);
    return 1;
  }
  const base = args.find((a) => a.startsWith('--base='))?.slice('--base='.length);
  if ((modo === '--purgar-texto-plano' || modo === '--revertir') && base !== env.db.name) {
    console.error(`✖ ${modo} exige --base=<nombre de la base configurada> y no coincide. No se ha modificado nada.`);
    return 2;
  }

  const { verifyConnection, pool } = await import('../config/database');
  const migracion = await import('../services/bank-account-migration.service');
  const { logError } = await import('../utils/logger');
  console.log(`Datos bancarios · ${modo} · entorno ${env.nodeEnv} · base ${env.db.name}`);
  try {
    await verifyConnection();
    if (modo === '--cifrar') {
      const r = await migracion.encryptPending();
      console.log(`✔ revisadas ${r.revisadas} · cifradas ${r.cifradas} · ya estaban cifradas ${r.yaCifradas} (el texto en claro se conserva hasta la purga)`);
    } else if (modo === '--verificar') {
      const r = await migracion.verify();
      console.log(`cuentas ${r.cuentas} · cifradas ${r.cifradas} · con texto en claro ${r.conTextoPlano} · sin cifrar ${r.sinCifrar} · ilegibles ${r.ilegibles} · discrepancias ${r.discrepancias} · solo con la clave anterior ${r.conClaveAnterior}`);
      return r.sinCifrar || r.ilegibles || r.discrepancias ? 1 : 0;
    } else if (modo === '--recifrar') {
      const r = await migracion.reencryptWithCurrentKey();
      console.log(`✔ revisadas ${r.revisadas} · re-cifradas con la clave vigente ${r.recifradas} · ya estaban con ella ${r.yaConLaVigente}`);
    } else if (modo === '--purgar-texto-plano') {
      const r = await migracion.purgePlaintext();
      console.log(`✔ columnas en claro vaciadas en ${r.vaciadas} cuentas (verificación previa: ${r.verificacion.cuentas} cuentas, 0 incidencias)`);
    } else {
      const r = await migracion.revert();
      console.log(`✔ texto en claro repuesto en ${r.repuestas} cuentas · ilegibles ${r.ilegibles}`);
      return r.ilegibles ? 1 : 0;
    }
    return 0;
  } catch (error) {
    if (error instanceof migracion.BankMigrationError) {
      console.error(`✖ ${error.message}`);
      return 1;
    }
    logError('No se pudo completar la migración de datos bancarios', error);
    console.error('✖ Error inesperado. El detalle (saneado) está en el registro de errores.');
    return 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

void main().then((codigo) => {
  process.exitCode = codigo;
});
