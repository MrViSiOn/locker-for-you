import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyMigrations, creariaCiclo, openDatabase, schemaVersion, type Db } from './index.js';
import { MIGRATIONS } from './migrations.js';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'locker-test-'));
  db = openDatabase(join(dir, 'sub', 'locker.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const AHORA = '2026-08-27T12:00:00.000Z';

function crearUsuario(id = 'u1', email = 'dani@ejemplo.es'): string {
  db.prepare(
    `INSERT INTO users (id, email, kdf_salt, kdf_params_version, auth_key_hash,
                        wrapped_master_key, created_at, updated_at)
     VALUES (?, ?, 'salt', 1, 'hash', 'mk-envuelta', ?, ?)`,
  ).run(id, email, AHORA, AHORA);
  return id;
}

function crearCarpeta(id: string, padre: string | null, usuario = 'u1'): string {
  db.prepare(
    `INSERT INTO nodes (id, user_id, parent_id, kind, name_encrypted, created_at, updated_at)
     VALUES (?, ?, ?, 'folder', 'nombre-cifrado', ?, ?)`,
  ).run(id, usuario, padre, AHORA, AHORA);
  return id;
}

function crearFichero(id: string, padre: string | null, usuario = 'u1'): string {
  db.prepare(
    `INSERT INTO nodes (id, user_id, parent_id, kind, name_encrypted, blob_id,
                        wrapped_dek, size_bytes, created_at, updated_at)
     VALUES (?, ?, ?, 'file', 'nombre-cifrado', ?, 'dek-envuelta', 4096, ?, ?)`,
  ).run(id, usuario, padre, `blob-${id}`, AHORA, AHORA);
  return id;
}

describe('configuracion de la conexion', () => {
  it('crea el directorio si no existe', () => {
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
  });

  // Sin WAL, el backup diario se quedaria esperando o se llevaria una copia
  // a medias (DRAPPS-1052).
  it('activa el modo WAL', () => {
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  // SQLite las ignora por defecto: sin esto los ON DELETE CASCADE no se
  // aplican y borrar una carpeta dejaria sus hijos huerfanos.
  it('activa las claves foraneas', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

describe('migraciones', () => {
  it('dejan la base en la ultima version', () => {
    expect(schemaVersion(db)).toBe(MIGRATIONS[MIGRATIONS.length - 1]?.version);
  });

  it('son idempotentes: reaplicarlas no rompe nada', () => {
    const antes = schemaVersion(db);

    applyMigrations(db);
    applyMigrations(db);

    expect(schemaVersion(db)).toBe(antes);
    expect(() => crearUsuario()).not.toThrow();
  });

  it('crean todas las tablas esperadas', () => {
    const tablas = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as { name: string }[];

    const nombres = tablas.map((t) => t.name);
    for (const esperada of ['audit_log', 'login_attempts', 'nodes', 'sessions', 'users']) {
      expect(nombres).toContain(esperada);
    }
  });

  it('sobreviven a cerrar y reabrir el fichero', () => {
    crearUsuario();
    db.close();

    db = openDatabase(join(dir, 'sub', 'locker.db'));

    const usuarios = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    expect(usuarios.n).toBe(1);
  });
});

describe('integridad de nodes', () => {
  beforeEach(() => {
    crearUsuario();
  });

  it('borrar una carpeta se lleva su contenido en cascada', () => {
    crearCarpeta('raiz', null);
    crearCarpeta('sub', 'raiz');
    crearFichero('f1', 'sub');
    crearFichero('f2', 'raiz');

    db.prepare('DELETE FROM nodes WHERE id = ?').run('raiz');

    const restantes = db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number };
    expect(restantes.n).toBe(0);
  });

  it('borrar un usuario se lleva sus nodos', () => {
    crearCarpeta('raiz', null);
    crearFichero('f1', 'raiz');

    db.prepare('DELETE FROM users WHERE id = ?').run('u1');

    const restantes = db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number };
    expect(restantes.n).toBe(0);
  });

  it('un nodo no puede ser su propio padre', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO nodes (id, user_id, parent_id, kind, name_encrypted, created_at, updated_at)
           VALUES ('x', 'u1', 'x', 'folder', 'n', ?, ?)`,
        )
        .run(AHORA, AHORA),
    ).toThrow(/CHECK/i);
  });

  it('rechaza un padre inexistente', () => {
    expect(() => crearCarpeta('huerfana', 'no-existe')).toThrow(/FOREIGN KEY/i);
  });

  it('rechaza un tipo de nodo que no sea carpeta o fichero', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO nodes (id, user_id, kind, name_encrypted, created_at, updated_at)
           VALUES ('x', 'u1', 'enlace', 'n', ?, ?)`,
        )
        .run(AHORA, AHORA),
    ).toThrow(/CHECK/i);
  });

  // Un fichero sin wrapped_dek seria un fichero imposible de descifrar, y sin
  // esta comprobacion no habria forma de saber cuando ni por que aparecio.
  it('rechaza un fichero sin DEK envuelta', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO nodes (id, user_id, kind, name_encrypted, blob_id, size_bytes, created_at, updated_at)
           VALUES ('x', 'u1', 'file', 'n', 'blob-x', 100, ?, ?)`,
        )
        .run(AHORA, AHORA),
    ).toThrow(/CHECK/i);
  });

  it('rechaza una carpeta con blob', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO nodes (id, user_id, kind, name_encrypted, blob_id, wrapped_dek, size_bytes, created_at, updated_at)
           VALUES ('x', 'u1', 'folder', 'n', 'blob-x', 'dek', 100, ?, ?)`,
        )
        .run(AHORA, AHORA),
    ).toThrow(/CHECK/i);
  });

  it('no permite dos nodos con el mismo blob', () => {
    crearFichero('f1', null);

    expect(() =>
      db
        .prepare(
          `INSERT INTO nodes (id, user_id, kind, name_encrypted, blob_id, wrapped_dek, size_bytes, created_at, updated_at)
           VALUES ('f2', 'u1', 'file', 'n', 'blob-f1', 'dek', 100, ?, ?)`,
        )
        .run(AHORA, AHORA),
    ).toThrow(/UNIQUE/i);
  });
});

describe('deteccion de ciclos en el arbol', () => {
  beforeEach(() => {
    crearUsuario();
    // raiz > hijo > nieto
    crearCarpeta('raiz', null);
    crearCarpeta('hijo', 'raiz');
    crearCarpeta('nieto', 'hijo');
    crearCarpeta('aparte', null);
  });

  it('mover una carpeta dentro de si misma es un ciclo', () => {
    expect(creariaCiclo(db, 'raiz', 'raiz')).toBe(true);
  });

  // El caso peligroso de verdad: sin detectarlo, raiz y todo su contenido
  // quedarian desconectados del arbol y sus ficheros inalcanzables, sin un
  // solo mensaje de error.
  it('mover una carpeta dentro de su propio nieto es un ciclo', () => {
    expect(creariaCiclo(db, 'raiz', 'nieto')).toBe(true);
  });

  it('mover una carpeta dentro de su hijo es un ciclo', () => {
    expect(creariaCiclo(db, 'raiz', 'hijo')).toBe(true);
  });

  it('mover una carpeta a otra rama no es ciclo', () => {
    expect(creariaCiclo(db, 'nieto', 'aparte')).toBe(false);
  });

  it('mover un descendiente hacia arriba no es ciclo', () => {
    expect(creariaCiclo(db, 'nieto', 'raiz')).toBe(false);
  });

  it('mover a la raiz nunca es ciclo', () => {
    expect(creariaCiclo(db, 'nieto', null)).toBe(false);
  });
});

describe('aislamiento entre usuarios', () => {
  it('cada usuario tiene su arbol y borrar uno no toca al otro', () => {
    crearUsuario('u1', 'uno@ejemplo.es');
    crearUsuario('u2', 'dos@ejemplo.es');
    crearCarpeta('carpeta-u1', null, 'u1');
    crearCarpeta('carpeta-u2', null, 'u2');

    db.prepare('DELETE FROM users WHERE id = ?').run('u1');

    const restantes = db.prepare('SELECT id FROM nodes').all() as { id: string }[];
    expect(restantes).toEqual([{ id: 'carpeta-u2' }]);
  });

  it('no admite dos usuarios con el mismo email', () => {
    crearUsuario('u1', 'mismo@ejemplo.es');

    expect(() => crearUsuario('u2', 'mismo@ejemplo.es')).toThrow(/UNIQUE/i);
  });
});

describe('papelera', () => {
  beforeEach(() => {
    crearUsuario();
  });

  it('un nodo borrado queda marcado pero sigue en la tabla', () => {
    crearFichero('f1', null);

    db.prepare('UPDATE nodes SET deleted_at = ? WHERE id = ?').run(AHORA, 'f1');

    const visibles = db
      .prepare('SELECT COUNT(*) AS n FROM nodes WHERE deleted_at IS NULL')
      .get() as { n: number };
    const total = db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number };

    expect(visibles.n).toBe(0);
    expect(total.n).toBe(1);
  });
});

describe('auditoria', () => {
  it('el registro de un borrado sobrevive al nodo borrado', () => {
    crearUsuario();
    crearFichero('f1', null);

    db.prepare(
      `INSERT INTO audit_log (user_id, action, node_id, ip, created_at)
       VALUES ('u1', 'delete', 'f1', '1.2.3.4', ?)`,
    ).run(AHORA);

    db.prepare('DELETE FROM nodes WHERE id = ?').run('f1');

    // Sin clave foranea a proposito: con ON DELETE CASCADE se perderia justo
    // la entrada que interesa investigar.
    const entradas = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number };
    expect(entradas.n).toBe(1);
  });
});
