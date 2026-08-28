import type { NodeDto } from '@locker/shared';

import { creariaCiclo, type Db } from '../db/index.js';
import { borrarBlob } from './almacen.js';
import { buscarNodo, NodoError } from './repositorio.js';

/**
 * Papelera de 30 dias (decidido en DRAPPS-1048).
 *
 * Borrar es un soft delete: se marca `deleted_at` y el nodo desaparece de los
 * listados, pero sigue en la base de datos y su blob sigue en disco. Solo la
 * purga, pasados 30 dias, lo elimina de verdad.
 *
 * El motivo es que en una boveda de claves privadas un borrado accidental es
 * irreversible y doloroso: el coste de un flag y una tarea de purga es
 * ridiculo comparado con perder una clave que no se puede volver a generar.
 */

export const DIAS_DE_RETENCION = 30;

/**
 * Manda un nodo a la papelera, con toda su descendencia.
 *
 * Marcar SOLO el nodo raiz seria un error sutil: sus hijos seguirian con
 * `deleted_at` a NULL y apareceria n en cualquier consulta que no pase por el
 * padre, colgando de una carpeta invisible.
 */
export function mandarAPapelera(db: Db, userId: string, nodeId: string): number {
  const nodo = buscarNodo(db, userId, nodeId);
  if (nodo === undefined) {
    throw new NodoError('El nodo no existe.', 'no_encontrado', 404);
  }

  const ahora = new Date().toISOString();

  const marcar = db.transaction(() => {
    return db
      .prepare(
        `WITH RECURSIVE descendencia(id) AS (
           SELECT id FROM nodes WHERE id = ? AND user_id = ?
           UNION ALL
           SELECT n.id FROM nodes n JOIN descendencia d ON n.parent_id = d.id
         )
         UPDATE nodes SET deleted_at = ?, updated_at = ?
         WHERE id IN (SELECT id FROM descendencia) AND deleted_at IS NULL`,
      )
      .run(nodeId, userId, ahora, ahora).changes;
  });

  return marcar();
}

/** Lo que hay en la papelera, lo mas reciente primero. */
export function listarPapelera(db: Db, userId: string): NodeDto[] {
  const filas = db
    .prepare(
      `SELECT * FROM nodes
       WHERE user_id = ? AND deleted_at IS NOT NULL
       ORDER BY deleted_at DESC`,
    )
    .all(userId) as {
    id: string;
    parent_id: string | null;
    kind: 'folder' | 'file';
    name_encrypted: string;
    blob_id: string | null;
    wrapped_dek: string | null;
    size_bytes: number | null;
    deleted_at: string | null;
    created_at: string;
    updated_at: string;
  }[];

  return filas.map((fila) => ({
    id: fila.id,
    parentId: fila.parent_id,
    kind: fila.kind,
    nameEncrypted: fila.name_encrypted,
    blobId: fila.blob_id,
    wrappedDek: fila.wrapped_dek,
    sizeBytes: fila.size_bytes,
    createdAt: fila.created_at,
    updatedAt: fila.updated_at,
    deletedAt: fila.deleted_at,
  }));
}

/**
 * Restaura un nodo de la papelera, con su descendencia.
 *
 * Si la carpeta que lo contenia ya no existe --o sigue en la papelera--, el
 * nodo vuelve a la raiz. Restaurarlo dentro de un padre invisible lo dejaria
 * inalcanzable: el usuario veria "restaurado" y no encontraria nada.
 */
export function restaurar(db: Db, userId: string, nodeId: string): NodeDto {
  const nodo = db
    .prepare(
      'SELECT id, parent_id FROM nodes WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL',
    )
    .get(nodeId, userId) as { id: string; parent_id: string | null } | undefined;

  if (nodo === undefined) {
    throw new NodoError('Ese nodo no esta en la papelera.', 'no_encontrado', 404);
  }

  const padreVisible =
    nodo.parent_id === null ? null : (buscarNodo(db, userId, nodo.parent_id)?.id ?? null);

  const ahora = new Date().toISOString();

  db.transaction(() => {
    db.prepare(
      `WITH RECURSIVE descendencia(id) AS (
         SELECT id FROM nodes WHERE id = ? AND user_id = ?
         UNION ALL
         SELECT n.id FROM nodes n JOIN descendencia d ON n.parent_id = d.id
       )
       UPDATE nodes SET deleted_at = NULL, updated_at = ?
       WHERE id IN (SELECT id FROM descendencia)`,
    ).run(nodeId, userId, ahora);

    // El padre se ajusta solo en el nodo restaurado; su descendencia
    // conserva la estructura que tenia.
    db.prepare('UPDATE nodes SET parent_id = ? WHERE id = ?').run(padreVisible, nodeId);
  })();

  return buscarNodo(db, userId, nodeId) as NodeDto;
}

/**
 * Borra de verdad un nodo y su descendencia: base de datos y disco.
 *
 * EL ORDEN IMPORTA. Primero la transaccion de SQLite, que recoge los blobs
 * afectados y elimina las filas; despues los ficheros. Al reves, un fallo a
 * mitad dejaria nodos apuntando a blobs que ya no existen, y eso se
 * manifiesta como "mi fichero ha desaparecido" -- que en una boveda de claves
 * da un susto considerable y ademas es irreparable.
 */
export async function borrarDefinitivamente(
  db: Db,
  dirBlobs: string,
  userId: string,
  nodeId: string,
): Promise<{ nodos: number; blobs: number }> {
  const aBorrar = db
    .prepare(
      `WITH RECURSIVE descendencia(id) AS (
         SELECT id FROM nodes WHERE id = ? AND user_id = ?
         UNION ALL
         SELECT n.id FROM nodes n JOIN descendencia d ON n.parent_id = d.id
       )
       SELECT nodes.id, nodes.blob_id FROM nodes
       JOIN descendencia ON nodes.id = descendencia.id`,
    )
    .all(nodeId, userId) as { id: string; blob_id: string | null }[];

  if (aBorrar.length === 0) {
    throw new NodoError('El nodo no existe.', 'no_encontrado', 404);
  }

  // 1. Base de datos, en una transaccion. El ON DELETE CASCADE del esquema
  //    se encarga de la descendencia.
  db.transaction(() => {
    db.prepare('DELETE FROM nodes WHERE id = ? AND user_id = ?').run(nodeId, userId);
  })();

  // 2. Y solo entonces, el disco.
  const blobs = aBorrar.map((n) => n.blob_id).filter((id): id is string => id !== null);
  for (const blobId of blobs) {
    await borrarBlob(dirBlobs, blobId);
  }

  return { nodos: aBorrar.length, blobs: blobs.length };
}

/** Vacia la papelera entera. */
export async function vaciarPapelera(
  db: Db,
  dirBlobs: string,
  userId: string,
): Promise<{ nodos: number; blobs: number }> {
  const raices = db
    .prepare(
      `SELECT id FROM nodes
       WHERE user_id = ? AND deleted_at IS NOT NULL
         AND (parent_id IS NULL OR parent_id NOT IN (
           SELECT id FROM nodes WHERE user_id = ? AND deleted_at IS NOT NULL
         ))`,
    )
    .all(userId, userId) as { id: string }[];

  let nodos = 0;
  let blobs = 0;

  for (const raiz of raices) {
    const resultado = await borrarDefinitivamente(db, dirBlobs, userId, raiz.id);
    nodos += resultado.nodos;
    blobs += resultado.blobs;
  }

  return { nodos, blobs };
}

/**
 * Purga lo que lleve mas de 30 dias en la papelera.
 *
 * Se ejecuta periodicamente. Sin ella la papelera crece sin freno y el
 * espacio "liberado" nunca se recupera de verdad.
 */
export async function purgarPapelera(
  db: Db,
  dirBlobs: string,
  dias = DIAS_DE_RETENCION,
): Promise<{ nodos: number; blobs: number }> {
  const corte = new Date(Date.now() - dias * 24 * 60 * 60_000).toISOString();

  const caducados = db
    .prepare(
      `SELECT id, user_id FROM nodes
       WHERE deleted_at IS NOT NULL AND deleted_at < ?
         AND (parent_id IS NULL OR parent_id NOT IN (
           SELECT id FROM nodes WHERE deleted_at IS NOT NULL AND deleted_at < ?
         ))`,
    )
    .all(corte, corte) as { id: string; user_id: string }[];

  let nodos = 0;
  let blobs = 0;

  for (const nodo of caducados) {
    try {
      const resultado = await borrarDefinitivamente(db, dirBlobs, nodo.user_id, nodo.id);
      nodos += resultado.nodos;
      blobs += resultado.blobs;
    } catch {
      // Un nodo que falle no puede abortar la purga entera: los demas
      // seguirian ocupando disco indefinidamente.
    }
  }

  return { nodos, blobs };
}

/** Reexportado para que las rutas comprueben ciclos sin importar de db. */
export { creariaCiclo };
