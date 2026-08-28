import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

import { nuevoId } from '../auth/credenciales.js';

/**
 * Almacen de blobs cifrados en disco.
 *
 * Aqui no se cifra ni se descifra nada: los bytes llegan ya cifrados desde el
 * navegador y se escriben tal cual. Este modulo solo decide DONDE van y se
 * asegura de que no queden a medias.
 */

/**
 * Los blobs se reparten en subdirectorios por los dos primeros caracteres de
 * su id: /data/blobs/a3/a3f2...
 *
 * Un directorio plano con decenas de miles de entradas degrada el rendimiento
 * del sistema de ficheros y convierte cualquier `ls` en una espera.
 */
function rutaDelBlob(dirBase: string, blobId: string): string {
  return join(dirBase, blobId.slice(0, 2), blobId);
}

export function nuevoBlobId(): string {
  return nuevoId();
}

/**
 * Escribe un blob desde un stream.
 *
 * Se escribe primero a un fichero temporal y solo al final se mueve a su
 * sitio definitivo. Asi, si el proceso muere a mitad de la subida, lo que
 * queda es un temporal identificable y no un blob incompleto que pareceria
 * un fichero valido hasta que alguien intentara descifrarlo.
 *
 * El `rename` dentro del mismo sistema de ficheros es atomico: el blob
 * aparece entero o no aparece.
 */
export async function escribirBlob(
  dirBase: string,
  blobId: string,
  origen: Readable,
  limiteBytes: number,
): Promise<number> {
  const destino = rutaDelBlob(dirBase, blobId);
  const temporal = `${destino}.parcial`;

  await mkdir(dirname(destino), { recursive: true });

  let escritos = 0;
  let excedido = false;

  /**
   * Contador intercalado en el propio pipeline.
   *
   * Va como Transform y no como un listener de 'data' sobre el origen: un
   * listener adicional pone el stream en modo flowing por su cuenta y
   * compite con el pipeline por los datos, con lo que el limite puede no
   * aplicarse nunca. Dentro del pipeline, cada byte pasa por aqui.
   */
  const contador = new Transform({
    transform(trozo: Buffer, _codificacion, siguiente) {
      escritos += trozo.length;

      if (escritos > limiteBytes) {
        excedido = true;
        // Se corta en cuanto se pasa del limite, sin esperar al final:
        // si no, alguien podria llenar el disco mandando un fichero enorme
        // y el rechazo llegaria cuando ya no sirve de nada.
        siguiente(new Error('limite_superado'));
        return;
      }

      siguiente(null, trozo);
    },
  });

  try {
    await pipeline(origen, contador, createWriteStream(temporal));
  } catch (error) {
    await rm(temporal, { force: true });

    // Vaciar lo que quede del origen antes de responder. Sin esto la
    // conexion se queda a medias esperando un cuerpo que ya nadie va a
    // leer, y la peticion no termina nunca: el cliente ve un cuelgue en
    // lugar de un error claro.
    origen.resume();
    origen.destroy();

    if (excedido) {
      throw new BlobDemasiadoGrande(limiteBytes);
    }
    throw error;
  }

  await rename(temporal, destino);
  return escritos;
}

export class BlobDemasiadoGrande extends Error {
  constructor(readonly limiteBytes: number) {
    super(`El fichero supera el limite de ${String(limiteBytes)} bytes.`);
    this.name = 'BlobDemasiadoGrande';
  }
}

/** Devuelve un stream de lectura del blob, o null si no existe. */
export function leerBlob(dirBase: string, blobId: string): Readable | null {
  const ruta = rutaDelBlob(dirBase, blobId);

  if (!existsSync(ruta)) {
    return null;
  }

  return createReadStream(ruta);
}

export async function tamanoDelBlob(dirBase: string, blobId: string): Promise<number | null> {
  try {
    return (await stat(rutaDelBlob(dirBase, blobId))).size;
  } catch {
    return null;
  }
}

/**
 * Borra un blob. No falla si ya no estaba.
 *
 * Que no falle es deliberado: al borrar una carpeta con muchos ficheros, un
 * blob que ya no exista no debe abortar el borrado de los demas y dejar el
 * trabajo a medias.
 */
export async function borrarBlob(dirBase: string, blobId: string): Promise<void> {
  await rm(rutaDelBlob(dirBase, blobId), { force: true });
}

export function existeBlob(dirBase: string, blobId: string): boolean {
  return existsSync(rutaDelBlob(dirBase, blobId));
}
