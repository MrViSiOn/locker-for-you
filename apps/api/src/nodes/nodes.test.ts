import { createVault } from '@locker/crypto';
import { KDF_PARAMS_V1 } from '@locker/shared';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { applyMigrations, type Db } from '../db/index.js';

const PARAMS = { ...KDF_PARAMS_V1, memoryKib: 1024, iterations: 1 };

let app: FastifyInstance;
let db: Db;
let token: string;

/** Alta + login. Sin 2FA configurado, la sesion nace ya completa. */
async function nuevaSesion(email = 'dani@ejemplo.es'): Promise<string> {
  const { credentials } = await createVault('contrasena', PARAMS);

  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email,
      kdfSalt: credentials.kdfSalt,
      authKey: credentials.authKey,
      wrappedMasterKey: credentials.wrappedMasterKey,
    },
  });

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, authKey: credentials.authKey },
  });

  return login.cookies[0]?.value ?? '';
}

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db);
  app = await buildApp({ db });
  token = await nuevaSesion();
});

afterEach(async () => {
  await app.close();
});

async function crearCarpeta(nombre: string, parentId: string | null = null): Promise<string> {
  const respuesta = await app.inject({
    method: 'POST',
    url: '/api/nodes/folder',
    cookies: { locker_session: token },
    payload: { parentId, nameEncrypted: `cifrado:${nombre}` },
  });

  expect(respuesta.statusCode).toBe(201);
  return respuesta.json().id as string;
}

function crearFicheroDirecto(id: string, parentId: string | null, userId = 'x'): void {
  const usuario = db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string };
  const ahora = new Date().toISOString();

  db.prepare(
    `INSERT INTO nodes (id, user_id, parent_id, kind, name_encrypted, blob_id,
                        wrapped_dek, size_bytes, created_at, updated_at)
     VALUES (?, ?, ?, 'file', 'cifrado', ?, 'dek', 4096, ?, ?)`,
  ).run(id, userId === 'x' ? usuario.id : userId, parentId, `blob-${id}`, ahora, ahora);
}

describe('proteccion de los endpoints', () => {
  it.each([
    ['GET', '/api/nodes'],
    ['GET', '/api/nodes/loquesea'],
    ['GET', '/api/nodes/loquesea/tree'],
    ['POST', '/api/nodes/folder'],
    ['PATCH', '/api/nodes/loquesea'],
    ['GET', '/api/almacenamiento'],
  ])('%s %s devuelve 401 sin sesion', async (method, url) => {
    const respuesta = await app.inject({
      method: method as 'GET' | 'POST' | 'PATCH',
      url,
      payload: {},
    });

    expect(respuesta.statusCode).toBe(401);
  });

  // Una sesion a medias de segundo factor no puede tocar nada de la boveda.
  it('devuelve 403 si falta el segundo factor', async () => {
    db.prepare('UPDATE sessions SET totp_verified = 0').run();

    const respuesta = await app.inject({
      method: 'GET',
      url: '/api/nodes',
      cookies: { locker_session: token },
    });

    expect(respuesta.statusCode).toBe(403);
    expect(respuesta.json().error).toBe('totp_pendiente');
  });
});

describe('crear y listar', () => {
  it('la boveda nueva esta vacia', async () => {
    const respuesta = await app.inject({
      method: 'GET',
      url: '/api/nodes',
      cookies: { locker_session: token },
    });

    expect(respuesta.json().nodes).toEqual([]);
  });

  it('crea una carpeta en la raiz', async () => {
    const id = await crearCarpeta('claves');

    const listado = await app.inject({
      method: 'GET',
      url: '/api/nodes',
      cookies: { locker_session: token },
    });

    expect(listado.json().nodes).toHaveLength(1);
    expect(listado.json().nodes[0]).toMatchObject({ id, kind: 'folder' });
  });

  it('crea subcarpetas anidadas', async () => {
    const raiz = await crearCarpeta('trabajo');
    const sub = await crearCarpeta('servidores', raiz);
    await crearCarpeta('produccion', sub);

    const enRaiz = await app.inject({
      method: 'GET',
      url: '/api/nodes',
      cookies: { locker_session: token },
    });
    const enSub = await app.inject({
      method: 'GET',
      url: `/api/nodes?parent=${sub}`,
      cookies: { locker_session: token },
    });

    expect(enRaiz.json().nodes).toHaveLength(1);
    expect(enSub.json().nodes).toHaveLength(1);
  });

  it('el servidor devuelve el nombre tal cual, cifrado', async () => {
    await crearCarpeta('secreta');

    const listado = await app.inject({
      method: 'GET',
      url: '/api/nodes',
      cookies: { locker_session: token },
    });

    expect(listado.json().nodes[0].nameEncrypted).toBe('cifrado:secreta');
  });

  it('las carpetas van antes que los ficheros', async () => {
    const carpeta = await crearCarpeta('una-carpeta');
    crearFicheroDirecto('f1', null);

    const listado = await app.inject({
      method: 'GET',
      url: '/api/nodes',
      cookies: { locker_session: token },
    });

    expect(listado.json().nodes[0].id).toBe(carpeta);
    expect(listado.json().nodes[1].id).toBe('f1');
  });

  it('rechaza crear una carpeta sin nombre', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/nodes/folder',
      cookies: { locker_session: token },
      payload: { parentId: null },
    });

    expect(respuesta.statusCode).toBe(400);
  });

  it('rechaza un padre que no existe', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/nodes/folder',
      cookies: { locker_session: token },
      payload: { parentId: 'no-existe', nameEncrypted: 'x' },
    });

    expect(respuesta.statusCode).toBe(404);
  });

  it('no deja meter nodos dentro de un fichero', async () => {
    crearFicheroDirecto('f1', null);

    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/nodes/folder',
      cookies: { locker_session: token },
      payload: { parentId: 'f1', nameEncrypted: 'x' },
    });

    expect(respuesta.statusCode).toBe(400);
    expect(respuesta.json().error).toBe('padre_no_es_carpeta');
  });
});

describe('renombrar y mover', () => {
  it('renombra un nodo', async () => {
    const id = await crearCarpeta('nombre-viejo');

    const respuesta = await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${id}`,
      cookies: { locker_session: token },
      payload: { nameEncrypted: 'cifrado:nombre-nuevo' },
    });

    expect(respuesta.json().nameEncrypted).toBe('cifrado:nombre-nuevo');
  });

  it('mueve un nodo a otra carpeta', async () => {
    const origen = await crearCarpeta('origen');
    const destino = await crearCarpeta('destino');
    const hijo = await crearCarpeta('hijo', origen);

    await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${hijo}`,
      cookies: { locker_session: token },
      payload: { parentId: destino },
    });

    const enDestino = await app.inject({
      method: 'GET',
      url: `/api/nodes?parent=${destino}`,
      cookies: { locker_session: token },
    });

    expect(enDestino.json().nodes).toHaveLength(1);
  });

  it('mueve un nodo a la raiz con parentId null', async () => {
    const carpeta = await crearCarpeta('carpeta');
    const hijo = await crearCarpeta('hijo', carpeta);

    await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${hijo}`,
      cookies: { locker_session: token },
      payload: { parentId: null },
    });

    const enRaiz = await app.inject({
      method: 'GET',
      url: '/api/nodes',
      cookies: { locker_session: token },
    });

    expect(enRaiz.json().nodes).toHaveLength(2);
  });

  it('renombra y mueve en la misma peticion', async () => {
    const destino = await crearCarpeta('destino');
    const nodo = await crearCarpeta('nodo');

    const respuesta = await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${nodo}`,
      cookies: { locker_session: token },
      payload: { nameEncrypted: 'cifrado:renombrado', parentId: destino },
    });

    expect(respuesta.json()).toMatchObject({
      nameEncrypted: 'cifrado:renombrado',
      parentId: destino,
    });
  });

  it('devuelve 404 al tocar un nodo inexistente', async () => {
    const respuesta = await app.inject({
      method: 'PATCH',
      url: '/api/nodes/no-existe',
      cookies: { locker_session: token },
      payload: { nameEncrypted: 'x' },
    });

    expect(respuesta.statusCode).toBe(404);
  });
});

describe('ciclos en el arbol', () => {
  // Sin esta comprobacion, mover una carpeta dentro de su propia descendencia
  // la desconecta del arbol con todo su contenido: deja de aparecer en
  // cualquier listado y sus ficheros se vuelven inalcanzables, sin un solo
  // mensaje de error.
  it('no deja mover una carpeta dentro de si misma', async () => {
    const carpeta = await crearCarpeta('carpeta');

    const respuesta = await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${carpeta}`,
      cookies: { locker_session: token },
      payload: { parentId: carpeta },
    });

    expect(respuesta.statusCode).toBe(400);
    expect(respuesta.json().error).toBe('ciclo');
  });

  it('no deja mover una carpeta dentro de su hijo', async () => {
    const padre = await crearCarpeta('padre');
    const hijo = await crearCarpeta('hijo', padre);

    const respuesta = await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${padre}`,
      cookies: { locker_session: token },
      payload: { parentId: hijo },
    });

    expect(respuesta.statusCode).toBe(400);
  });

  it('no deja mover una carpeta dentro de su nieto', async () => {
    const abuelo = await crearCarpeta('abuelo');
    const padre = await crearCarpeta('padre', abuelo);
    const nieto = await crearCarpeta('nieto', padre);

    const respuesta = await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${abuelo}`,
      cookies: { locker_session: token },
      payload: { parentId: nieto },
    });

    expect(respuesta.statusCode).toBe(400);
  });

  it('un intento de ciclo rechazado no corrompe el arbol', async () => {
    const padre = await crearCarpeta('padre');
    const hijo = await crearCarpeta('hijo', padre);

    await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${padre}`,
      cookies: { locker_session: token },
      payload: { parentId: hijo },
    });

    // El arbol sigue exactamente igual que antes del intento.
    const raiz = await app.inject({
      method: 'GET',
      url: '/api/nodes',
      cookies: { locker_session: token },
    });
    const dentro = await app.inject({
      method: 'GET',
      url: `/api/nodes?parent=${padre}`,
      cookies: { locker_session: token },
    });

    expect(raiz.json().nodes).toHaveLength(1);
    expect(raiz.json().nodes[0].id).toBe(padre);
    expect(dentro.json().nodes[0].id).toBe(hijo);
  });
});

describe('limite de profundidad', () => {
  it('rechaza anidar mas alla del limite', async () => {
    let padre: string | null = null;

    // 32 niveles permitidos; el 33 debe fallar.
    for (let i = 0; i < 32; i++) {
      padre = await crearCarpeta(`nivel-${String(i)}`, padre);
    }

    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/nodes/folder',
      cookies: { locker_session: token },
      payload: { parentId: padre, nameEncrypted: 'demasiado-hondo' },
    });

    expect(respuesta.statusCode).toBe(400);
    expect(respuesta.json().error).toBe('demasiada_profundidad');
  }, 30_000);
});

describe('subarbol', () => {
  it('devuelve el nodo y toda su descendencia', async () => {
    const raiz = await crearCarpeta('raiz');
    const sub = await crearCarpeta('sub', raiz);
    crearFicheroDirecto('f1', sub);
    crearFicheroDirecto('f2', raiz);
    await crearCarpeta('aparte');

    const respuesta = await app.inject({
      method: 'GET',
      url: `/api/nodes/${raiz}/tree`,
      cookies: { locker_session: token },
    });

    const ids = (respuesta.json().nodes as { id: string }[]).map((n) => n.id).sort();
    expect(ids).toEqual([raiz, sub, 'f1', 'f2'].sort());
  });

  it('no incluye lo que esta en la papelera', async () => {
    const raiz = await crearCarpeta('raiz');
    crearFicheroDirecto('f1', raiz);
    db.prepare('UPDATE nodes SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), 'f1');

    const respuesta = await app.inject({
      method: 'GET',
      url: `/api/nodes/${raiz}/tree`,
      cookies: { locker_session: token },
    });

    expect(respuesta.json().nodes).toHaveLength(1);
  });
});

describe('aislamiento entre usuarios', () => {
  // Hoy que solo hay una cuenta es facil olvidar el filtro por user_id; el
  // dia que haya dos, olvidarlo significa que un usuario ve la boveda de otro.
  it('un usuario no ve ni toca los nodos de otro', async () => {
    const mio = await crearCarpeta('mia');

    // Segundo usuario, insertado a mano porque /register solo admite uno.
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

    // Listar solo devuelve lo mio.
    const listado = await app.inject({
      method: 'GET',
      url: '/api/nodes',
      cookies: { locker_session: token },
    });
    expect((listado.json().nodes as { id: string }[]).map((n) => n.id)).toEqual([mio]);

    // Y el nodo ajeno es invisible en todos los caminos.
    for (const url of ['/api/nodes/ajena', '/api/nodes/ajena/tree']) {
      const respuesta = await app.inject({
        method: 'GET',
        url,
        cookies: { locker_session: token },
      });
      expect(respuesta.statusCode).toBe(404);
    }

    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/nodes/ajena',
      cookies: { locker_session: token },
      payload: { nameEncrypted: 'secuestrada' },
    });
    expect(patch.statusCode).toBe(404);
  });

  it('no se puede colgar un nodo del arbol de otro usuario', async () => {
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
      method: 'POST',
      url: '/api/nodes/folder',
      cookies: { locker_session: token },
      payload: { parentId: 'ajena', nameEncrypted: 'intrusa' },
    });

    expect(respuesta.statusCode).toBe(404);
  });
});

describe('espacio ocupado', () => {
  it('suma el tamano de los ficheros', async () => {
    crearFicheroDirecto('f1', null);
    crearFicheroDirecto('f2', null);

    const respuesta = await app.inject({
      method: 'GET',
      url: '/api/almacenamiento',
      cookies: { locker_session: token },
    });

    expect(respuesta.json().usadoBytes).toBe(8192);
    expect(respuesta.json().cuotaBytes).toBeGreaterThan(0);
  });

  // La papelera cuenta a proposito: esos ficheros siguen ocupando disco hasta
  // que la purga se los lleve, y decir lo contrario haria que el usuario se
  // quedara sin espacio sin entender por que.
  it('cuenta tambien lo que esta en la papelera', async () => {
    crearFicheroDirecto('f1', null);
    db.prepare('UPDATE nodes SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), 'f1');

    const respuesta = await app.inject({
      method: 'GET',
      url: '/api/almacenamiento',
      cookies: { locker_session: token },
    });

    expect(respuesta.json().usadoBytes).toBe(4096);
  });
});
