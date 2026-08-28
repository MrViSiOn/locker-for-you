import { DEFAULT_LIMITS, type NodeDto } from '@locker/shared';

import { nuevoId } from '../auth/credenciales.js';
import { creariaCiclo, type Db } from '../db/index.js';

/**
 * Acceso al arbol de nodos.
 *
 * Desde aqui el arbol es un grafo de nodos con nombres opacos: el servidor no
 * sabe como se llama nada de lo que mueve. Lo que SI puede -- y debe --
 * comprobar es la coherencia estructural: que los padres existan, que sean del
 * mismo usuario, que no se formen ciclos y que el arbol no crezca sin limite.
 *
 * REGLA INVIOLABLE: toda consulta filtra por user_id. Sin excepciones. Es la
 * frontera entre cuentas, y hoy que solo hay una es facil olvidarla; el dia
 * que haya dos, olvidarla significa que un usuario ve la boveda de otro.
 */

export class NodoError extends Error {
  constructor(
    message: string,
    readonly codigo: string,
    readonly estado: number,
  ) {
    super(message);
    this.name = 'NodoError';
  }
}

interface FilaNodo {
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
}

function aDto(fila: FilaNodo): NodeDto {
  return {
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
  };
}

/** Lista el contenido visible de una carpeta. La papelera no aparece aqui. */
export function listarHijos(db: Db, userId: string, parentId: string | null): NodeDto[] {
  // parent_id IS ? no funciona en SQLite para comparar con NULL, asi que la
  // raiz necesita su propia consulta.
  const filas = (
    parentId === null
      ? db
          .prepare(
            `SELECT * FROM nodes
             WHERE user_id = ? AND parent_id IS NULL AND deleted_at IS NULL
             ORDER BY kind DESC, created_at`,
          )
          .all(userId)
      : db
          .prepare(
            `SELECT * FROM nodes
             WHERE user_id = ? AND parent_id = ? AND deleted_at IS NULL
             ORDER BY kind DESC, created_at`,
          )
          .all(userId, parentId)
  ) as FilaNodo[];

  // El orden por kind DESC deja las carpetas antes que los ficheros, como en
  // cualquier explorador. El orden fino lo pone el cliente sobre los nombres
  // ya descifrados: el servidor no puede ordenar lo que no lee.
  return filas.map(aDto);
}

/** Busca un nodo del usuario. Devuelve undefined si no existe o no es suyo. */
export function buscarNodo(
  db: Db,
  userId: string,
  nodeId: string,
  incluirBorrados = false,
): NodeDto | undefined {
  const fila = db
    .prepare(
      incluirBorrados
        ? 'SELECT * FROM nodes WHERE id = ? AND user_id = ?'
        : 'SELECT * FROM nodes WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    )
    .get(nodeId, userId) as FilaNodo | undefined;

  return fila === undefined ? undefined : aDto(fila);
}

/**
 * Comprueba que un padre es valido para este usuario.
 *
 * Sin esta comprobacion, con multiusuario alguien podria colgar sus nodos del
 * arbol de otro pasando un parentId ajeno: no leeria nada suyo, pero le
 * llenaria la boveda de basura invisible.
 */
function exigirPadreValido(db: Db, userId: string, parentId: string | null): void {
  if (parentId === null) {
    return;
  }

  const padre = buscarNodo(db, userId, parentId);

  if (padre === undefined) {
    throw new NodoError('La carpeta de destino no existe.', 'padre_no_encontrado', 404);
  }

  if (padre.kind !== 'folder') {
    throw new NodoError(
      'No se pueden meter nodos dentro de un fichero.',
      'padre_no_es_carpeta',
      400,
    );
  }
}

/**
 * Profundidad de un nodo contando desde la raiz.
 *
 * Se limita para que el recorrido recursivo del subarbol (y el ZIP del
 * cliente) no puedan dispararse con un arbol absurdamente profundo.
 */
function profundidad(db: Db, nodeId: string | null): number {
  if (nodeId === null) {
    return 0;
  }

  const fila = db
    .prepare(
      `WITH RECURSIVE camino(id, nivel) AS (
         SELECT id, 1 FROM nodes WHERE id = ?
         UNION ALL
         SELECT n.parent_id, c.nivel + 1 FROM nodes n JOIN camino c ON n.id = c.id
         WHERE n.parent_id IS NOT NULL
       )
       SELECT MAX(nivel) AS nivel FROM camino`,
    )
    .get(nodeId) as { nivel: number | null };

  return fila.nivel ?? 0;
}

function exigirProfundidad(db: Db, parentId: string | null): void {
  if (profundidad(db, parentId) >= DEFAULT_LIMITS.maxDepth) {
    throw new NodoError(
      `No se pueden anidar mas de ${String(DEFAULT_LIMITS.maxDepth)} niveles de carpetas.`,
      'demasiada_profundidad',
      400,
    );
  }
}

export function crearCarpeta(
  db: Db,
  userId: string,
  parentId: string | null,
  nameEncrypted: string,
): NodeDto {
  exigirPadreValido(db, userId, parentId);
  exigirProfundidad(db, parentId);

  const id = nuevoId();
  const ahora = new Date().toISOString();

  db.prepare(
    `INSERT INTO nodes (id, user_id, parent_id, kind, name_encrypted, created_at, updated_at)
     VALUES (?, ?, ?, 'folder', ?, ?, ?)`,
  ).run(id, userId, parentId, nameEncrypted, ahora, ahora);

  return buscarNodo(db, userId, id) as NodeDto;
}

export function crearFichero(
  db: Db,
  userId: string,
  datos: {
    parentId: string | null;
    nameEncrypted: string;
    blobId: string;
    wrappedDek: string;
    sizeBytes: number;
  },
): NodeDto {
  exigirPadreValido(db, userId, datos.parentId);
  exigirProfundidad(db, datos.parentId);

  const id = nuevoId();
  const ahora = new Date().toISOString();

  db.prepare(
    `INSERT INTO nodes (id, user_id, parent_id, kind, name_encrypted, blob_id,
                        wrapped_dek, size_bytes, created_at, updated_at)
     VALUES (?, ?, ?, 'file', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    datos.parentId,
    datos.nameEncrypted,
    datos.blobId,
    datos.wrappedDek,
    datos.sizeBytes,
    ahora,
    ahora,
  );

  return buscarNodo(db, userId, id) as NodeDto;
}

/** Renombra un nodo. El servidor no sabe ni el nombre viejo ni el nuevo. */
export function renombrar(db: Db, userId: string, nodeId: string, nameEncrypted: string): NodeDto {
  const nodo = buscarNodo(db, userId, nodeId);
  if (nodo === undefined) {
    throw new NodoError('El nodo no existe.', 'no_encontrado', 404);
  }

  db.prepare(
    'UPDATE nodes SET name_encrypted = ?, updated_at = ? WHERE id = ? AND user_id = ?',
  ).run(nameEncrypted, new Date().toISOString(), nodeId, userId);

  return buscarNodo(db, userId, nodeId) as NodeDto;
}

/**
 * Mueve un nodo a otra carpeta.
 *
 * La comprobacion de ciclos es lo importante de esta funcion. Sin ella, mover
 * una carpeta dentro de su propia descendencia la desconecta del arbol junto
 * con todo lo que contiene: deja de aparecer en cualquier listado y sus
 * ficheros se vuelven inalcanzables, aunque sigan ocupando disco. No hay
 * error, no hay aviso: simplemente desaparecen.
 */
export function mover(db: Db, userId: string, nodeId: string, nuevoPadre: string | null): NodeDto {
  const nodo = buscarNodo(db, userId, nodeId);
  if (nodo === undefined) {
    throw new NodoError('El nodo no existe.', 'no_encontrado', 404);
  }

  exigirPadreValido(db, userId, nuevoPadre);

  if (creariaCiclo(db, nodeId, nuevoPadre)) {
    throw new NodoError(
      'No se puede mover una carpeta dentro de si misma ni de una subcarpeta suya.',
      'ciclo',
      400,
    );
  }

  exigirProfundidad(db, nuevoPadre);

  db.prepare('UPDATE nodes SET parent_id = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(
    nuevoPadre,
    new Date().toISOString(),
    nodeId,
    userId,
  );

  return buscarNodo(db, userId, nodeId) as NodeDto;
}

/**
 * Devuelve el subarbol completo de un nodo, el propio nodo incluido.
 *
 * Lo necesita el ZIP en bulk (DRAPPS-1051): como el servidor no puede
 * comprimir lo que no descifra, el cliente pide el subarbol entero de una vez
 * y se encarga el.
 */
export function subarbol(db: Db, userId: string, nodeId: string): NodeDto[] {
  const raiz = buscarNodo(db, userId, nodeId);
  if (raiz === undefined) {
    throw new NodoError('El nodo no existe.', 'no_encontrado', 404);
  }

  const filas = db
    .prepare(
      `WITH RECURSIVE descendencia(id) AS (
         SELECT id FROM nodes WHERE id = ? AND user_id = ?
         UNION ALL
         SELECT n.id FROM nodes n JOIN descendencia d ON n.parent_id = d.id
         WHERE n.deleted_at IS NULL
       )
       SELECT nodes.* FROM nodes JOIN descendencia ON nodes.id = descendencia.id
       WHERE nodes.deleted_at IS NULL AND nodes.user_id = ?
       ORDER BY nodes.kind DESC, nodes.created_at`,
    )
    .all(nodeId, userId, userId) as FilaNodo[];

  return filas.map(aDto);
}

/** Suma el tamano de todo lo que ocupa el usuario, papelera incluida. */
export function espacioUsado(db: Db, userId: string): number {
  const fila = db
    .prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS total FROM nodes WHERE user_id = ?`)
    .get(userId) as { total: number };

  // La papelera cuenta a proposito: los ficheros borrados siguen ocupando
  // disco hasta que la purga se los lleve, y decir lo contrario haria que el
  // usuario se quedara sin espacio sin entender por que.
  return fila.total;
}
