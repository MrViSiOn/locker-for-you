import {
  createDek,
  decryptBlob,
  decryptName,
  encryptName,
  isDuplicateName,
  sortByName,
  unwrapDek,
  validateName,
} from '@locker/crypto';
import type { NodeDto } from '@locker/shared';

import { ficheros, nodos } from '../api/cliente.js';
import { exigirBoveda } from './boveda.js';
import { cifrarContenido } from './cifrador.js';

/**
 * Operaciones de la boveda: aqui es donde se cifra antes de enviar y se
 * descifra al recibir.
 *
 * Es la unica capa que ve nombres y contenidos en claro. Ni el cliente HTTP
 * ni el servidor los ven nunca.
 */

/** Un nodo con el nombre ya descifrado, listo para pintar. */
export interface NodoLegible {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: 'folder' | 'file';
  readonly nombre: string;
  readonly sizeBytes: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly wrappedDek: string | null;
}

/**
 * Descifra los nombres de un listado.
 *
 * Un nombre que no se pueda descifrar NO tumba el listado entero: se marca y
 * los demas se muestran. Si un solo fichero corrupto dejara la carpeta en
 * blanco, el usuario perderia el acceso a todo lo demas sin motivo.
 */
export async function descifrarListado(lista: readonly NodeDto[]): Promise<NodoLegible[]> {
  const vault = exigirBoveda();

  const descifrados = await Promise.all(
    lista.map(async (nodo) => {
      let nombre: string;
      try {
        nombre = await decryptName(nodo.nameEncrypted, vault.nameKey);
      } catch {
        nombre = '(nombre ilegible)';
      }

      return {
        id: nodo.id,
        parentId: nodo.parentId,
        kind: nodo.kind,
        nombre,
        sizeBytes: nodo.sizeBytes,
        createdAt: nodo.createdAt,
        updatedAt: nodo.updatedAt,
        deletedAt: nodo.deletedAt,
        wrappedDek: nodo.wrappedDek,
      };
    }),
  );

  // El orden lo pone el cliente: el servidor no puede ordenar lo que no lee.
  // Carpetas primero, y dentro de cada grupo por nombre.
  const carpetas = descifrados.filter((n) => n.kind === 'folder');
  const archivos = descifrados.filter((n) => n.kind === 'file');

  return [...sortByName(carpetas, (n) => n.nombre), ...sortByName(archivos, (n) => n.nombre)];
}

export async function listarCarpeta(parentId: string | null): Promise<NodoLegible[]> {
  const { nodes } = await nodos.listar(parentId);
  return descifrarListado(nodes);
}

export async function crearCarpeta(parentId: string | null, nombre: string): Promise<NodoLegible> {
  const vault = exigirBoveda();

  // Se valida aqui porque el servidor NO PUEDE: no lee los nombres. Esta es
  // la unica barrera contra un nombre que se escape del directorio.
  validateName(nombre);

  const creada = await nodos.crearCarpeta(parentId, await encryptName(nombre, vault.nameKey));
  const [legible] = await descifrarListado([creada]);

  return legible as NodoLegible;
}

/**
 * Renombra un nodo.
 *
 * El nombre nuevo se cifra aqui, como el original: el servidor recibe otro
 * bloque opaco y no llega a saber que algo se llamaba de una forma y ahora de
 * otra. Solo ve que un registro cambio.
 */
export async function renombrar(id: string, nombre: string): Promise<NodoLegible> {
  const vault = exigirBoveda();

  // La validacion es cosa del cliente porque el servidor NO PUEDE: no lee los
  // nombres. Esta es la unica barrera contra un nombre que se escape del
  // directorio.
  validateName(nombre);

  const actualizado = await nodos.renombrar(id, await encryptName(nombre, vault.nameKey));
  const [legible] = await descifrarListado([actualizado]);

  return legible as NodoLegible;
}

/**
 * Mueve un nodo a otra carpeta.
 *
 * Aqui no se cifra nada: la estructura del arbol SI la conoce el servidor
 * -- es lo que le permite responder "que hay en esta carpeta" sin leer un
 * solo nombre -- asi que mover es cambiar un parent_id y nada mas.
 *
 * Los ciclos (meter una carpeta dentro de si misma) y el exceso de
 * profundidad los rechaza el servidor, que es quien tiene el arbol entero:
 * el cliente solo ve la carpeta en la que esta.
 */
export async function mover(id: string, destino: string | null): Promise<NodoLegible> {
  const movido = await nodos.mover(id, destino);
  const [legible] = await descifrarListado([movido]);

  return legible as NodoLegible;
}

export interface OpcionesDeSubida {
  senal?: AbortSignal | undefined;
  /** Fraccion 0..1 del cifrado, que ocurre entero antes de enviar nada. */
  alCifrar?: ((fraccion: number) => void) | undefined;
  /** Fraccion 0..1 de los bytes ya enviados. */
  alSubir?: ((fraccion: number) => void) | undefined;
}

/**
 * Sube un fichero: lo cifra en el navegador y manda bytes opacos.
 *
 * El progreso distingue CIFRAR de SUBIR a proposito, y son dos barras y no
 * una: en un fichero grande el cifrado tarda, y una sola barra parada
 * durante ese rato parece un cuelgue. Ademas separa dos cosas que al usuario
 * le importan de forma muy distinta: mientras avanza la primera, no ha
 * salido nada de su equipo.
 */
export async function subirFichero(
  archivo: File,
  parentId: string | null,
  opciones: OpcionesDeSubida = {},
): Promise<NodoLegible> {
  const vault = exigirBoveda();

  validateName(archivo.name);

  const { dek, wrappedDek } = await createDek(vault);
  const contenido = new Uint8Array(await archivo.arrayBuffer());

  // El cifrado se va a otro hilo cuando el navegador deja. El motivo real
  // esta en cifrador.worker.ts, y no es el que parece.
  const cifrado = await cifrarContenido(contenido, dek, opciones.alCifrar);

  const nodo = await ficheros.subir({
    contenidoCifrado: cifrado,
    nameEncrypted: await encryptName(archivo.name, vault.nameKey),
    wrappedDek,
    parentId,
    senal: opciones.senal,
    alProgresar: opciones.alSubir,
  });

  const [legible] = await descifrarListado([nodo]);
  return legible as NodoLegible;
}

/**
 * Descarga y descifra un fichero.
 *
 * Si la verificacion falla, lanza y NO devuelve nada: entregar un fichero a
 * medio descifrar como si fuera bueno haria creer al usuario que su clave
 * privada esta corrupta cuando en realidad esta intacta.
 */
export async function descargarFichero(nodo: NodoLegible): Promise<Uint8Array> {
  const vault = exigirBoveda();

  if (nodo.wrappedDek === null) {
    throw new Error('Este nodo no es un fichero.');
  }

  const cifrado = await ficheros.descargar(nodo.id);
  const dek = await unwrapDek(vault, nodo.wrappedDek);

  return decryptBlob(cifrado, dek);
}

/**
 * Entrega el fichero descifrado al usuario.
 *
 * La URL del blob se revoca en cuanto arranca la descarga: mientras vive,
 * cualquier codigo de la pagina podria leerla y sacar el contenido en claro.
 */
export function guardarEnDisco(nombre: string, contenido: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([contenido as BlobPart]));

  const enlace = document.createElement('a');
  enlace.href = url;
  enlace.download = nombre;
  enlace.click();

  URL.revokeObjectURL(url);
}

/** El servidor no puede detectar duplicados: los nombres van cifrados. */
export function nombreDuplicado(nombre: string, existentes: readonly NodoLegible[]): boolean {
  return isDuplicateName(
    nombre,
    existentes.map((n) => n.nombre),
  );
}
