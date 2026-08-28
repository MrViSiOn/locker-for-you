import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { MIGRATIONS } from './migrations.js';

export type Db = Database.Database;

/**
 * Abre la base de datos, la configura y aplica las migraciones pendientes.
 *
 * Se llama al arrancar. Si algo falla aqui, el proceso no debe seguir: es
 * preferible no arrancar a arrancar con un esquema a medias.
 */
export function openDatabase(file: string): Db {
  mkdirSync(dirname(file), { recursive: true });

  const db = new Database(file);
  configurePragmas(db);
  applyMigrations(db);

  return db;
}

function configurePragmas(db: Db): void {
  // WAL: los lectores no bloquean al escritor ni al reves. Es lo que permite
  // que el backup diario (DRAPPS-1052) copie la base mientras la app trabaja
  // sin quedarse esperando ni llevarse una copia a medias.
  db.pragma('journal_mode = WAL');

  // SQLite ignora las claves foraneas POR DEFECTO, y hay que activarlas en
  // cada conexion. Sin esto, los ON DELETE CASCADE del esquema no se aplican
  // y borrar una carpeta dejaria sus hijos huerfanos apuntando a un padre
  // que ya no existe.
  db.pragma('foreign_keys = ON');

  // Con WAL, NORMAL no arriesga corrupcion: como mucho se pierde la ultima
  // transaccion ante un corte de luz, y a cambio se evita un fsync por
  // escritura.
  db.pragma('synchronous = NORMAL');

  // Si otra conexion tiene la base ocupada, esperar en vez de fallar al
  // instante con SQLITE_BUSY.
  db.pragma('busy_timeout = 5000');
}

/**
 * Aplica las migraciones que falten, cada una en su transaccion.
 *
 * Es idempotente: arrancar dos veces seguidas no repite nada. La version
 * aplicada vive en `user_version`, un entero que SQLite guarda en la cabecera
 * del fichero, asi que no hace falta una tabla propia para llevar la cuenta.
 */
export function applyMigrations(db: Db): void {
  const actual = db.pragma('user_version', { simple: true }) as number;

  for (const migracion of MIGRATIONS) {
    if (migracion.version <= actual) {
      continue;
    }

    db.transaction(() => {
      db.exec(migracion.sql);
      // pragma no admite parametros enlazados; la version viene de una
      // constante del codigo, nunca de fuera.
      db.pragma(`user_version = ${String(migracion.version)}`);
    })();
  }
}

/** Version de esquema aplicada. Util en tests y en el endpoint de salud. */
export function schemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/**
 * Comprueba si mover `nodeId` bajo `nuevoPadre` crearia un ciclo.
 *
 * Sin esta comprobacion, mover una carpeta dentro de su propia
 * descendencia la desconecta del arbol junto con todo lo que contiene: deja
 * de aparecer en cualquier listado y sus ficheros se vuelven inalcanzables,
 * aunque sigan ocupando disco. No hay error, no hay aviso: simplemente
 * desaparecen.
 *
 * El CHECK del esquema solo cubre el caso trivial (ser padre de si mismo);
 * los ciclos de mas de un salto hay que buscarlos recorriendo el arbol.
 */
export function creariaCiclo(db: Db, nodeId: string, nuevoPadre: string | null): boolean {
  if (nuevoPadre === null) {
    return false;
  }

  if (nuevoPadre === nodeId) {
    return true;
  }

  const fila = db
    .prepare(
      `WITH RECURSIVE ancestros(id) AS (
         SELECT parent_id FROM nodes WHERE id = ?
         UNION ALL
         SELECT n.parent_id FROM nodes n JOIN ancestros a ON n.id = a.id
         WHERE n.parent_id IS NOT NULL
       )
       SELECT 1 AS encontrado FROM ancestros WHERE id = ? LIMIT 1`,
    )
    .get(nuevoPadre, nodeId) as { encontrado: number } | undefined;

  return fila !== undefined;
}
