import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDek,
  createVault,
  encryptBlob,
  encryptName,
  unlockVault,
  utf8Encode,
  type UnlockedVault,
} from '@locker/crypto';
import { KDF_PARAMS_V1 } from '@locker/shared';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyMigrations, type Db } from '../db/index.js';

const PARAMS = { ...KDF_PARAMS_V1, memoryKib: 1024, iterations: 1 };

let dirDatos: string;
let app: FastifyInstance;
let db: Db;
let token: string;
let vault: UnlockedVault;

beforeEach(async () => {
  dirDatos = mkdtempSync(join(tmpdir(), 'locker-papelera-'));
  vi.resetModules();
  process.env['BLOBS_DIR'] = join(dirDatos, 'blobs');

  const { buildApp } = await import('../app.js');

  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db);
  app = await buildApp({ db });

  const { credentials } = await createVault('contrasena', PARAMS);
  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: 'dani@ejemplo.es',
      kdfSalt: credentials.kdfSalt,
      authKey: credentials.authKey,
      wrappedMasterKey: credentials.wrappedMasterKey,
    },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'dani@ejemplo.es', authKey: credentials.authKey },
  });
  token = login.cookies[0]?.value ?? '';
  vault = (await unlockVault('contrasena', credentials)).vault;
});

afterEach(async () => {
  await app.close();
  rmSync(dirDatos, { recursive: true, force: true });
  delete process.env['BLOBS_DIR'];
});

const cookies = (): { locker_session: string } => ({ locker_session: token });

async function carpeta(nombre: string, padre: string | null = null): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/nodes/folder',
    cookies: cookies(),
    payload: { parentId: padre, nameEncrypted: await encryptName(nombre, vault.nameKey) },
  });
  return r.json().id as string;
}

async function fichero(nombre: string, padre: string | null = null): Promise<string> {
  const { dek, wrappedDek } = await createDek(vault);
  const blob = await encryptBlob(utf8Encode(`contenido de ${nombre}`), dek);

  const r = await app.inject({
    method: 'POST',
    url: '/api/files',
    cookies: cookies(),
    headers: {
      'content-type': 'application/octet-stream',
      'x-locker-name': await encryptName(nombre, vault.nameKey),
      'x-locker-dek': wrappedDek,
      ...(padre === null ? {} : { 'x-locker-parent': padre }),
    },
    payload: Buffer.from(blob),
  });

  return r.json().id as string;
}

function blobsEnDisco(): number {
  const base = join(dirDatos, 'blobs');
  if (!existsSync(base)) return 0;

  let total = 0;
  for (const shard of readdirSync(base, { withFileTypes: true })) {
    if (shard.isDirectory()) total += readdirSync(join(base, shard.name)).length;
  }
  return total;
}

async function listar(padre: string | null = null): Promise<{ id: string }[]> {
  const r = await app.inject({
    method: 'GET',
    url: padre === null ? '/api/nodes' : `/api/nodes?parent=${padre}`,
    cookies: cookies(),
  });
  return r.json().nodes as { id: string }[];
}

describe('mandar a la papelera', () => {
  it('el nodo desaparece del listado pero sigue existiendo', async () => {
    const id = await fichero('clave.pem');

    await app.inject({ method: 'DELETE', url: `/api/nodes/${id}`, cookies: cookies() });

    expect(await listar()).toHaveLength(0);
    const fila = db.prepare('SELECT deleted_at FROM nodes WHERE id = ?').get(id) as {
      deleted_at: string | null;
    };
    expect(fila.deleted_at).not.toBeNull();
  });

  // Marcar solo el nodo raiz es un error sutil: sus hijos seguirian visibles
  // en cualquier consulta que no pase por el padre, colgando de una carpeta
  // invisible.
  it('arrastra toda la descendencia', async () => {
    const raiz = await carpeta('raiz');
    const sub = await carpeta('sub', raiz);
    await fichero('dentro.pem', sub);
    await fichero('suelto.pem', raiz);

    const respuesta = await app.inject({
      method: 'DELETE',
      url: `/api/nodes/${raiz}`,
      cookies: cookies(),
    });

    expect(respuesta.json().aPapelera).toBe(4);

    const visibles = db
      .prepare('SELECT COUNT(*) AS n FROM nodes WHERE deleted_at IS NULL')
      .get() as {
      n: number;
    };
    expect(visibles.n).toBe(0);
  });

  // El blob NO se toca al mandar a la papelera: si se borrara, restaurar
  // devolveria un nodo sin contenido, que es peor que no restaurar nada.
  it('no borra el blob del disco', async () => {
    const id = await fichero('clave.pem');
    expect(blobsEnDisco()).toBe(1);

    await app.inject({ method: 'DELETE', url: `/api/nodes/${id}`, cookies: cookies() });

    expect(blobsEnDisco()).toBe(1);
  });

  it('el contenido ya no se puede descargar', async () => {
    const id = await fichero('clave.pem');
    await app.inject({ method: 'DELETE', url: `/api/nodes/${id}`, cookies: cookies() });

    const descarga = await app.inject({
      method: 'GET',
      url: `/api/files/${id}/contenido`,
      cookies: cookies(),
    });

    expect(descarga.statusCode).toBe(404);
  });

  it('queda registrado en la auditoria', async () => {
    const id = await fichero('clave.pem');
    await app.inject({ method: 'DELETE', url: `/api/nodes/${id}`, cookies: cookies() });

    const fila = db
      .prepare(`SELECT action, node_id FROM audit_log WHERE action = 'papelera'`)
      .get() as { action: string; node_id: string } | undefined;

    expect(fila?.node_id).toBe(id);
  });
});

describe('listar y restaurar', () => {
  it('la papelera muestra lo borrado', async () => {
    const id = await fichero('clave.pem');
    await app.inject({ method: 'DELETE', url: `/api/nodes/${id}`, cookies: cookies() });

    const papelera = await app.inject({ method: 'GET', url: '/api/papelera', cookies: cookies() });

    expect((papelera.json().nodes as { id: string }[]).map((n) => n.id)).toEqual([id]);
  });

  it('restaurar devuelve el nodo a su sitio', async () => {
    const destino = await carpeta('destino');
    const id = await fichero('clave.pem', destino);

    await app.inject({ method: 'DELETE', url: `/api/nodes/${id}`, cookies: cookies() });
    await app.inject({
      method: 'POST',
      url: `/api/papelera/${id}/restaurar`,
      cookies: cookies(),
    });

    expect((await listar(destino)).map((n) => n.id)).toEqual([id]);
  });

  it('restaurar una carpeta recupera todo su contenido', async () => {
    const raiz = await carpeta('raiz');
    const sub = await carpeta('sub', raiz);
    await fichero('dentro.pem', sub);

    await app.inject({ method: 'DELETE', url: `/api/nodes/${raiz}`, cookies: cookies() });
    await app.inject({
      method: 'POST',
      url: `/api/papelera/${raiz}/restaurar`,
      cookies: cookies(),
    });

    const visibles = db
      .prepare('SELECT COUNT(*) AS n FROM nodes WHERE deleted_at IS NULL')
      .get() as {
      n: number;
    };
    expect(visibles.n).toBe(3);
  });

  // Restaurarlo dentro de un padre invisible lo dejaria inalcanzable: el
  // usuario veria "restaurado" y no encontraria nada por ninguna parte.
  it('si el padre ya no existe, vuelve a la raiz', async () => {
    const padre = await carpeta('padre');
    const hijo = await fichero('hijo.pem', padre);

    // Se borra el hijo y luego el padre entero, definitivamente.
    await app.inject({ method: 'DELETE', url: `/api/nodes/${hijo}`, cookies: cookies() });
    await app.inject({ method: 'DELETE', url: `/api/nodes/${padre}`, cookies: cookies() });
    await app.inject({ method: 'DELETE', url: `/api/papelera/${padre}`, cookies: cookies() });

    // El hijo ya no esta (cayo con el padre), asi que se prueba el caso con
    // un nodo cuyo padre sigue en la papelera.
    const otroPadre = await carpeta('otro');
    const otroHijo = await fichero('otro.pem', otroPadre);
    await app.inject({ method: 'DELETE', url: `/api/nodes/${otroPadre}`, cookies: cookies() });

    await app.inject({
      method: 'POST',
      url: `/api/papelera/${otroHijo}/restaurar`,
      cookies: cookies(),
    });

    // Vuelve a la raiz porque su carpeta sigue invisible.
    expect((await listar()).map((n) => n.id)).toContain(otroHijo);
  });

  it('no se puede restaurar algo que no esta en la papelera', async () => {
    const id = await fichero('clave.pem');

    const respuesta = await app.inject({
      method: 'POST',
      url: `/api/papelera/${id}/restaurar`,
      cookies: cookies(),
    });

    expect(respuesta.statusCode).toBe(404);
  });
});

describe('borrado definitivo', () => {
  // El DoD de la issue: 3 niveles, todos los nodos y todos los blobs fuera.
  it('borra una carpeta de 3 niveles con sus nodos y sus blobs', async () => {
    const n1 = await carpeta('nivel1');
    const n2 = await carpeta('nivel2', n1);
    const n3 = await carpeta('nivel3', n2);
    await fichero('a.pem', n1);
    await fichero('b.pem', n2);
    await fichero('c.pem', n3);

    expect(blobsEnDisco()).toBe(3);

    await app.inject({ method: 'DELETE', url: `/api/nodes/${n1}`, cookies: cookies() });
    const respuesta = await app.inject({
      method: 'DELETE',
      url: `/api/papelera/${n1}`,
      cookies: cookies(),
    });

    expect(respuesta.json()).toEqual({ nodos: 6, blobs: 3 });

    const quedan = db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number };
    expect(quedan.n).toBe(0);
    expect(blobsEnDisco()).toBe(0);
  });

  it('no deja referencias rotas: ni nodos sin blob ni blobs sin nodo', async () => {
    const c = await carpeta('carpeta');
    await fichero('dentro.pem', c);
    const fuera = await fichero('fuera.pem');

    await app.inject({ method: 'DELETE', url: `/api/nodes/${c}`, cookies: cookies() });
    await app.inject({ method: 'DELETE', url: `/api/papelera/${c}`, cookies: cookies() });

    // Queda exactamente un nodo y exactamente un blob: los del fichero suelto.
    const nodos = db.prepare('SELECT id, blob_id FROM nodes').all() as {
      id: string;
      blob_id: string | null;
    }[];
    expect(nodos).toHaveLength(1);
    expect(nodos[0]?.id).toBe(fuera);
    expect(blobsEnDisco()).toBe(1);
  });

  it('vaciar la papelera se lo lleva todo', async () => {
    const a = await fichero('a.pem');
    const b = await carpeta('b');
    await fichero('dentro.pem', b);

    await app.inject({ method: 'DELETE', url: `/api/nodes/${a}`, cookies: cookies() });
    await app.inject({ method: 'DELETE', url: `/api/nodes/${b}`, cookies: cookies() });

    const respuesta = await app.inject({
      method: 'DELETE',
      url: '/api/papelera',
      cookies: cookies(),
    });

    expect(respuesta.json().nodos).toBe(3);
    expect(blobsEnDisco()).toBe(0);
  });

  it('vaciar una papelera vacia no falla', async () => {
    const respuesta = await app.inject({
      method: 'DELETE',
      url: '/api/papelera',
      cookies: cookies(),
    });

    expect(respuesta.json()).toEqual({ nodos: 0, blobs: 0 });
  });
});

describe('purga automatica', () => {
  it('borra lo que lleva mas de 30 dias, y respeta lo reciente', async () => {
    const viejo = await fichero('viejo.pem');
    const reciente = await fichero('reciente.pem');

    await app.inject({ method: 'DELETE', url: `/api/nodes/${viejo}`, cookies: cookies() });
    await app.inject({ method: 'DELETE', url: `/api/nodes/${reciente}`, cookies: cookies() });

    // Se envejece uno de los dos.
    db.prepare('UPDATE nodes SET deleted_at = ? WHERE id = ?').run(
      new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString(),
      viejo,
    );

    const { purgarPapelera } = await import('./papelera.js');
    const resultado = await purgarPapelera(db, join(dirDatos, 'blobs'));

    expect(resultado).toEqual({ nodos: 1, blobs: 1 });
    expect(blobsEnDisco()).toBe(1);

    const quedan = db.prepare('SELECT id FROM nodes').all() as { id: string }[];
    expect(quedan.map((n) => n.id)).toEqual([reciente]);
  });

  it('no toca lo que no esta en la papelera', async () => {
    await fichero('vivo.pem');

    const { purgarPapelera } = await import('./papelera.js');
    // Retencion de 0 dias: purgaria todo lo borrado, pero no hay nada borrado.
    const resultado = await purgarPapelera(db, join(dirDatos, 'blobs'), 0);

    expect(resultado.nodos).toBe(0);
    expect(blobsEnDisco()).toBe(1);
  });
});

describe('aislamiento entre usuarios', () => {
  it('no se puede mandar a la papelera un nodo ajeno', async () => {
    const ahora = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, email, kdf_salt, kdf_params_version, auth_key_hash,
                          wrapped_master_key, created_at, updated_at)
       VALUES ('u2', 'otro@ejemplo.es', 's', 1, 'h', 'mk', ?, ?)`,
    ).run(ahora, ahora);
    db.prepare(
      `INSERT INTO nodes (id, user_id, parent_id, kind, name_encrypted, created_at, updated_at)
       VALUES ('ajena', 'u2', NULL, 'folder', 'cifrado', ?, ?)`,
    ).run(ahora, ahora);

    const respuesta = await app.inject({
      method: 'DELETE',
      url: '/api/nodes/ajena',
      cookies: cookies(),
    });

    expect(respuesta.statusCode).toBe(404);
    const sigue = db.prepare('SELECT deleted_at FROM nodes WHERE id = ?').get('ajena') as {
      deleted_at: string | null;
    };
    expect(sigue.deleted_at).toBeNull();
  });

  it('la papelera de un usuario no muestra la de otro', async () => {
    const ahora = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, email, kdf_salt, kdf_params_version, auth_key_hash,
                          wrapped_master_key, created_at, updated_at)
       VALUES ('u2', 'otro@ejemplo.es', 's', 1, 'h', 'mk', ?, ?)`,
    ).run(ahora, ahora);
    db.prepare(
      `INSERT INTO nodes (id, user_id, parent_id, kind, name_encrypted, deleted_at, created_at, updated_at)
       VALUES ('ajena', 'u2', NULL, 'folder', 'cifrado', ?, ?, ?)`,
    ).run(ahora, ahora, ahora);

    const papelera = await app.inject({ method: 'GET', url: '/api/papelera', cookies: cookies() });

    expect(papelera.json().nodes).toHaveLength(0);
  });
});
