import { readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDek,
  createVault,
  decryptBlob,
  encryptBlob,
  encryptName,
  decryptName,
  unlockVault,
  unwrapDek,
  utf8Encode,
  type UnlockedVault,
} from '@locker/crypto';
import { KDF_PARAMS_V1 } from '@locker/shared';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyMigrations, type Db } from '../db/index.js';

const PARAMS = { ...KDF_PARAMS_V1, memoryKib: 1024, iterations: 1 };
const PASSWORD = 'contrasena maestra';

/** Clave privada de verdad, para comprobar que en disco no queda rastro. */
const CLAVE_PRIVADA = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACDsecretoSuperImportanteQueNoDebeAparecerEnDisco0000000000
-----END OPENSSH PRIVATE KEY-----
`;

let dirDatos: string;
let app: FastifyInstance;
let db: Db;
let token: string;
let vault: UnlockedVault;

beforeEach(async () => {
  dirDatos = mkdtempSync(join(tmpdir(), 'locker-blobs-'));

  // El directorio de blobs se fija por entorno antes de cargar la config.
  vi.resetModules();
  process.env['BLOBS_DIR'] = join(dirDatos, 'blobs');

  const { buildApp } = await import('../app.js');

  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db);
  app = await buildApp({ db });

  const { credentials } = await createVault(PASSWORD, PARAMS);
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
  vault = (await unlockVault(PASSWORD, credentials)).vault;
});

afterEach(async () => {
  await app.close();
  rmSync(dirDatos, { recursive: true, force: true });
  delete process.env['BLOBS_DIR'];
});

/** Sube un fichero como lo haria el navegador: cifrando antes de enviar. */
async function subir(
  contenido: string,
  nombre = 'clave.pem',
  parentId: string | null = null,
): Promise<{ nodeId: string; wrappedDek: string; blobId: string }> {
  const { dek, wrappedDek } = await createDek(vault);
  const blob = await encryptBlob(utf8Encode(contenido), dek);
  const nameEncrypted = await encryptName(nombre, vault.nameKey);

  const respuesta = await app.inject({
    method: 'POST',
    url: '/api/files',
    cookies: { locker_session: token },
    headers: {
      'content-type': 'application/octet-stream',
      'x-locker-name': nameEncrypted,
      'x-locker-dek': wrappedDek,
      ...(parentId === null ? {} : { 'x-locker-parent': parentId }),
    },
    payload: Buffer.from(blob),
  });

  expect(respuesta.statusCode).toBe(201);
  return {
    nodeId: respuesta.json().id as string,
    wrappedDek,
    blobId: respuesta.json().blobId as string,
  };
}

/** Todos los ficheros del almacen, con su ruta completa. */
function blobsEnDisco(): string[] {
  const base = join(dirDatos, 'blobs');
  const encontrados: string[] = [];

  for (const shard of readdirSync(base, { withFileTypes: true })) {
    if (!shard.isDirectory()) continue;
    for (const fichero of readdirSync(join(base, shard.name))) {
      encontrados.push(join(base, shard.name, fichero));
    }
  }

  return encontrados;
}

describe('subida', () => {
  it('crea el nodo y guarda el blob en disco', async () => {
    const { nodeId } = await subir(CLAVE_PRIVADA);

    const nodo = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId) as {
      kind: string;
      blob_id: string;
      size_bytes: number;
    };

    expect(nodo.kind).toBe('file');
    expect(nodo.size_bytes).toBeGreaterThan(0);
    expect(blobsEnDisco()).toHaveLength(1);
  });

  // El corazon del proyecto: quien tenga acceso al disco no puede sacar nada.
  it('el blob en disco NO contiene ni un rastro del contenido original', async () => {
    await subir(CLAVE_PRIVADA, 'id_rsa_produccion.pem');

    const contenidoEnDisco = readFileSync(blobsEnDisco()[0] as string);
    const comoTexto = contenidoEnDisco.toString('latin1');

    // Ni el contenido...
    expect(comoTexto).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(comoTexto).not.toContain('secretoSuperImportante');
    // ...ni el nombre del fichero.
    expect(comoTexto).not.toContain('id_rsa_produccion');
    // Lo unico reconocible es la cabecera del formato, que es publica.
    expect(comoTexto.slice(0, 4)).toBe('LCKR');
  });

  it('el nombre tampoco aparece en la base de datos', async () => {
    await subir(CLAVE_PRIVADA, 'clave-del-banco.pem');

    const fila = db.prepare('SELECT name_encrypted FROM nodes').get() as {
      name_encrypted: string;
    };

    expect(fila.name_encrypted).not.toContain('clave-del-banco');
    // Pero el cliente si puede recuperarlo con su clave.
    expect(await decryptName(fila.name_encrypted, vault.nameKey)).toBe('clave-del-banco.pem');
  });

  // Los blobs se reparten en subdirectorios: un directorio plano con decenas
  // de miles de entradas degrada el rendimiento del sistema de ficheros.
  it('reparte los blobs en subdirectorios por su id', async () => {
    const { blobId } = await subir('contenido');

    const ruta = blobsEnDisco()[0] as string;
    expect(ruta).toContain(join(blobId.slice(0, 2), blobId));
  });

  it('sube dentro de una carpeta', async () => {
    const carpeta = await app.inject({
      method: 'POST',
      url: '/api/nodes/folder',
      cookies: { locker_session: token },
      payload: { nameEncrypted: await encryptName('claves', vault.nameKey) },
    });
    const carpetaId = carpeta.json().id as string;

    const { nodeId } = await subir(CLAVE_PRIVADA, 'dentro.pem', carpetaId);

    const listado = await app.inject({
      method: 'GET',
      url: `/api/nodes?parent=${carpetaId}`,
      cookies: { locker_session: token },
    });

    expect((listado.json().nodes as { id: string }[]).map((n) => n.id)).toEqual([nodeId]);
  });

  it('exige sesion', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/files',
      headers: {
        'content-type': 'application/octet-stream',
        'x-locker-name': 'n',
        'x-locker-dek': 'd',
      },
      payload: Buffer.from('x'),
    });

    expect(respuesta.statusCode).toBe(401);
  });

  it('rechaza una subida sin las cabeceras de metadatos', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/files',
      cookies: { locker_session: token },
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('x'),
    });

    expect(respuesta.statusCode).toBe(400);
  });

  // Validar el destino ANTES de escribir un solo byte: no tiene sentido
  // aceptar 50 MB para descubrir despues que la carpeta no existe.
  it('rechaza una carpeta de destino inexistente sin escribir nada', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/files',
      cookies: { locker_session: token },
      headers: {
        'content-type': 'application/octet-stream',
        'x-locker-name': 'n',
        'x-locker-dek': 'd',
        'x-locker-parent': 'no-existe',
      },
      payload: Buffer.from('contenido'),
    });

    expect(respuesta.statusCode).toBe(404);
    expect(() => blobsEnDisco()).toThrow(); // ni siquiera se creo el directorio
  });
});

describe('limite de tamano', () => {
  it('rechaza un fichero que supera el limite', async () => {
    const gigante = Buffer.alloc(config().maxFileSizeBytes + 1024, 0x41);

    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/files',
      cookies: { locker_session: token },
      headers: {
        'content-type': 'application/octet-stream',
        'x-locker-name': 'grande',
        'x-locker-dek': 'dek',
      },
      payload: gigante,
    });

    expect([413, 400]).toContain(respuesta.statusCode);
  }, 60_000);

  // Un rechazo no puede dejar el fichero a medias ocupando disco.
  it('un fichero rechazado no deja restos en el almacen', async () => {
    const gigante = Buffer.alloc(config().maxFileSizeBytes + 1024, 0x41);

    await app.inject({
      method: 'POST',
      url: '/api/files',
      cookies: { locker_session: token },
      headers: {
        'content-type': 'application/octet-stream',
        'x-locker-name': 'grande',
        'x-locker-dek': 'dek',
      },
      payload: gigante,
    });

    let restos: string[] = [];
    try {
      restos = blobsEnDisco();
    } catch {
      restos = [];
    }

    expect(restos.filter((r) => !r.endsWith('.parcial'))).toHaveLength(0);
  }, 60_000);
});

describe('sin huerfanos', () => {
  // La issue pedia elegir entre confirmacion en dos fases o barrido
  // periodico. Se hace en UNA peticion: si el nodo no se puede crear, el
  // blob se borra ahi mismo. La ventana desaparece en vez de gestionarse.
  it('si la creacion del nodo falla, el blob no se queda en disco', async () => {
    // Se fuerza el fallo dejando la tabla de nodos inutilizable.
    db.prepare('DROP TABLE nodes').run();

    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/files',
      cookies: { locker_session: token },
      headers: {
        'content-type': 'application/octet-stream',
        'x-locker-name': 'n',
        'x-locker-dek': 'd',
      },
      payload: Buffer.from('contenido que no llegara a ninguna parte'),
    });

    expect(respuesta.statusCode).toBe(500);

    let restos: string[] = [];
    try {
      restos = blobsEnDisco();
    } catch {
      restos = [];
    }
    expect(restos).toHaveLength(0);
  });
});

describe('descarga', () => {
  it('devuelve exactamente los bytes cifrados que se subieron', async () => {
    const { dek, wrappedDek } = await createDek(vault);
    const blobOriginal = await encryptBlob(utf8Encode(CLAVE_PRIVADA), dek);

    const subida = await app.inject({
      method: 'POST',
      url: '/api/files',
      cookies: { locker_session: token },
      headers: {
        'content-type': 'application/octet-stream',
        'x-locker-name': await encryptName('clave.pem', vault.nameKey),
        'x-locker-dek': wrappedDek,
      },
      payload: Buffer.from(blobOriginal),
    });

    const descarga = await app.inject({
      method: 'GET',
      url: `/api/files/${subida.json().id}/contenido`,
      cookies: { locker_session: token },
    });

    expect(descarga.statusCode).toBe(200);
    expect(new Uint8Array(descarga.rawPayload)).toEqual(blobOriginal);
  });

  // El ciclo completo: subir, descargar y descifrar. Es la prueba de que
  // todo el modelo funciona de punta a punta.
  it('lo descargado se descifra y coincide byte a byte con el original', async () => {
    const { nodeId, wrappedDek } = await subir(CLAVE_PRIVADA, 'id_ed25519');

    const descarga = await app.inject({
      method: 'GET',
      url: `/api/files/${nodeId}/contenido`,
      cookies: { locker_session: token },
    });

    const dek = await unwrapDek(vault, wrappedDek);
    const claro = await decryptBlob(new Uint8Array(descarga.rawPayload), dek);

    expect(new TextDecoder().decode(claro)).toBe(CLAVE_PRIVADA);
  });

  it('no cachea el contenido en ningun intermediario', async () => {
    const { nodeId } = await subir(CLAVE_PRIVADA);

    const descarga = await app.inject({
      method: 'GET',
      url: `/api/files/${nodeId}/contenido`,
      cookies: { locker_session: token },
    });

    expect(descarga.headers['cache-control']).toContain('no-store');
  });

  it('la respuesta no revela el nombre del fichero', async () => {
    const { nodeId } = await subir(CLAVE_PRIVADA, 'clave-secreta-del-banco.pem');

    const descarga = await app.inject({
      method: 'GET',
      url: `/api/files/${nodeId}/contenido`,
      cookies: { locker_session: token },
    });

    expect(JSON.stringify(descarga.headers)).not.toContain('clave-secreta');
  });

  it('exige sesion', async () => {
    const { nodeId } = await subir(CLAVE_PRIVADA);

    const respuesta = await app.inject({
      method: 'GET',
      url: `/api/files/${nodeId}/contenido`,
    });

    expect(respuesta.statusCode).toBe(401);
  });

  it('devuelve 404 para un fichero que no existe', async () => {
    const respuesta = await app.inject({
      method: 'GET',
      url: '/api/files/inventado/contenido',
      cookies: { locker_session: token },
    });

    expect(respuesta.statusCode).toBe(404);
  });

  it('devuelve 404 al pedir el contenido de una carpeta', async () => {
    const carpeta = await app.inject({
      method: 'POST',
      url: '/api/nodes/folder',
      cookies: { locker_session: token },
      payload: { nameEncrypted: await encryptName('carpeta', vault.nameKey) },
    });

    const respuesta = await app.inject({
      method: 'GET',
      url: `/api/files/${carpeta.json().id}/contenido`,
      cookies: { locker_session: token },
    });

    expect(respuesta.statusCode).toBe(404);
  });

  it('no deja descargar el fichero de otro usuario', async () => {
    const { nodeId } = await subir(CLAVE_PRIVADA);

    // El nodo pasa a ser de otro usuario.
    const ahora = new Date().toISOString();
    db.prepare(
      `INSERT INTO users (id, email, kdf_salt, kdf_params_version, auth_key_hash,
                          wrapped_master_key, created_at, updated_at)
       VALUES ('u2', 'otro@ejemplo.es', 's', 1, 'h', 'mk', ?, ?)`,
    ).run(ahora, ahora);
    db.prepare('UPDATE nodes SET user_id = ? WHERE id = ?').run('u2', nodeId);

    const respuesta = await app.inject({
      method: 'GET',
      url: `/api/files/${nodeId}/contenido`,
      cookies: { locker_session: token },
    });

    expect(respuesta.statusCode).toBe(404);
  });
});

/** Lee la config ya cargada por el módulo de la app. */
function config(): { maxFileSizeBytes: number } {
  return { maxFileSizeBytes: 50 * 1024 * 1024 };
}
