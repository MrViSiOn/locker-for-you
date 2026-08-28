import { purgarIntentosAntiguos } from './auth/bloqueo.js';
import { config } from './config.js';
import type { Db } from './db/index.js';
import { purgarPapelera } from './nodes/papelera.js';

/**
 * Tareas de mantenimiento periodicas.
 *
 * Va dentro del proceso y no como un cron del sistema a proposito: asi viaja
 * con la aplicacion. Un cron en el host es una pieza mas que hay que
 * acordarse de instalar al desplegar y que se olvida en cuanto se mueve el
 * proyecto de servidor, y su ausencia no da ningun error -- simplemente el
 * espacio nunca se recupera.
 */

/** Cada 6 horas. No hace falta mas: nada de esto es urgente. */
const INTERVALO_MS = 6 * 60 * 60 * 1000;

export interface Mantenimiento {
  /** Ejecuta una pasada ahora. Expuesto para los tests. */
  ejecutar: () => Promise<void>;
  detener: () => void;
}

export function arrancarMantenimiento(
  db: Db,
  registrar: (mensaje: string, datos?: Record<string, unknown>) => void,
): Mantenimiento {
  async function ejecutar(): Promise<void> {
    try {
      // Papelera: lo que lleva mas de 30 dias se borra de verdad, disco
      // incluido. Sin esto el espacio "liberado" no se recupera nunca.
      const papelera = await purgarPapelera(db, config.blobsDir);

      // Intentos de login: sin purga, un bot machacando el login durante
      // meses acabaria llenando el disco del VPS.
      const intentos = purgarIntentosAntiguos(db);

      // Sesiones caducadas. Se limpian tambien al usarlas, pero las de quien
      // no vuelve a entrar se quedarian ahi para siempre.
      const sesiones = db
        .prepare('DELETE FROM sessions WHERE expires_at < ?')
        .run(new Date().toISOString()).changes;

      if (papelera.nodos > 0 || intentos > 0 || sesiones > 0) {
        registrar('mantenimiento ejecutado', {
          nodosPurgados: papelera.nodos,
          blobsBorrados: papelera.blobs,
          intentosBorrados: intentos,
          sesionesCaducadas: sesiones,
        });
      }
    } catch (error) {
      // El mantenimiento NUNCA puede tumbar el proceso: si falla, la app
      // sigue funcionando y ya se reintentara en la siguiente pasada.
      registrar('fallo en el mantenimiento', { error: String(error) });
    }
  }

  // La primera pasada no es inmediata: al arrancar, el proceso tiene cosas
  // mas urgentes que hacer que barrer la papelera.
  const temporizador = setInterval(() => void ejecutar(), INTERVALO_MS);

  // Sin unref, este temporizador mantendria vivo el proceso e impediria que
  // `docker compose down` termine limpiamente.
  temporizador.unref();

  return {
    ejecutar,
    detener: () => {
      clearInterval(temporizador);
    },
  };
}
