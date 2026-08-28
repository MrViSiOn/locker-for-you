import {
  crearRecuperacion,
  createDek,
  createVault,
  decryptBlob,
  encryptBlob,
  exportarMasterKeyParaRecuperacion,
  recuperarClaveMaestra,
  reenvolverConNuevaPassword,
  unlockVault,
  unwrapDek,
  utf8Encode,
  type VaultCredentials,
} from '@locker/crypto';
import { KDF_PARAMS_V1 } from '@locker/shared';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { applyMigrations, type Db } from '../db/index.js';

const PARAMS = { ...KDF_PARAMS_V1, memoryKib: 1024, iterations: 1 };
const EMAIL = 'dani@ejemplo.es';

let app: FastifyInstance;
let db: Db;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db);
  app = await buildApp({ db });
});

afterEach(async () => {
  await app.close();
});

async function altaYLogin(
  password = 'la contrasena original',
): Promise<{ credentials: VaultCredentials; token: string }> {
  const { credentials } = await createVault(password, PARAMS);

  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: EMAIL,
      kdfSalt: credentials.kdfSalt,
      authKey: credentials.authKey,
      wrappedMasterKey: credentials.wrappedMasterKey,
    },
  });

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: EMAIL, authKey: credentials.authKey },
  });

  return { credentials, token: login.cookies[0]?.value ?? '' };
}

describe('guardar el Emergency Kit', () => {
  it('exige sesion', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/auth/recuperacion',
      payload: { recoveryWrappedKey: 'x', recoverySalt: 'y' },
    });

    expect(respuesta.statusCode).toBe(401);
  });

  it('guarda la clave envuelta y el salt', async () => {
    const { credentials, token } = await altaYLogin();
    const mk = await exportarMasterKeyParaRecuperacion('la contrasena original', credentials);
    const kit = await crearRecuperacion(mk, PARAMS);

    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/auth/recuperacion',
      cookies: { locker_session: token },
      payload: { recoveryWrappedKey: kit.recoveryWrappedKey, recoverySalt: kit.recoverySalt },
    });

    expect(respuesta.statusCode).toBe(200);

    const fila = db.prepare('SELECT recovery_wrapped_key FROM users').get() as {
      recovery_wrapped_key: string;
    };
    expect(fila.recovery_wrapped_key).toBe(kit.recoveryWrappedKey);
  });

  it('el estado refleja si hay kit o no', async () => {
    const { credentials, token } = await altaYLogin();

    const antes = await app.inject({
      method: 'GET',
      url: '/api/auth/recuperacion/estado',
      cookies: { locker_session: token },
    });
    expect(antes.json()).toEqual({ tieneRecuperacion: false });

    const mk = await exportarMasterKeyParaRecuperacion('la contrasena original', credentials);
    const kit = await crearRecuperacion(mk, PARAMS);
    await app.inject({
      method: 'POST',
      url: '/api/auth/recuperacion',
      cookies: { locker_session: token },
      payload: { recoveryWrappedKey: kit.recoveryWrappedKey, recoverySalt: kit.recoverySalt },
    });

    const despues = await app.inject({
      method: 'GET',
      url: '/api/auth/recuperacion/estado',
      cookies: { locker_session: token },
    });
    expect(despues.json()).toEqual({ tieneRecuperacion: true });
  });

  // Sin esto, una hoja tirada en un cajon seguiria abriendo la boveda para
  // siempre aunque se hubiera generado un kit nuevo.
  it('regenerar el kit sobrescribe el anterior', async () => {
    const { credentials, token } = await altaYLogin();
    const mk = await exportarMasterKeyParaRecuperacion('la contrasena original', credentials);

    const viejo = await crearRecuperacion(mk, PARAMS);
    await app.inject({
      method: 'POST',
      url: '/api/auth/recuperacion',
      cookies: { locker_session: token },
      payload: { recoveryWrappedKey: viejo.recoveryWrappedKey, recoverySalt: viejo.recoverySalt },
    });

    const nuevo = await crearRecuperacion(mk, PARAMS);
    await app.inject({
      method: 'POST',
      url: '/api/auth/recuperacion',
      cookies: { locker_session: token },
      payload: { recoveryWrappedKey: nuevo.recoveryWrappedKey, recoverySalt: nuevo.recoverySalt },
    });

    const fila = db.prepare('SELECT recovery_wrapped_key FROM users').get() as {
      recovery_wrapped_key: string;
    };
    expect(fila.recovery_wrapped_key).toBe(nuevo.recoveryWrappedKey);
    expect(fila.recovery_wrapped_key).not.toBe(viejo.recoveryWrappedKey);
  });
});

describe('challenge de recuperacion', () => {
  it('devuelve 404 si la cuenta no tiene kit', async () => {
    await altaYLogin();

    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/auth/recuperacion/challenge',
      payload: { email: EMAIL },
    });

    expect(respuesta.statusCode).toBe(404);
  });

  it('da el mismo error para un email inexistente que para uno sin kit', async () => {
    await altaYLogin();

    const sinKit = await app.inject({
      method: 'POST',
      url: '/api/auth/recuperacion/challenge',
      payload: { email: EMAIL },
    });
    const inexistente = await app.inject({
      method: 'POST',
      url: '/api/auth/recuperacion/challenge',
      payload: { email: 'fantasma@ejemplo.es' },
    });

    expect(sinKit.statusCode).toBe(inexistente.statusCode);
    expect(sinKit.json()).toEqual(inexistente.json());
  });
});

describe('el ciclo completo contra la API', () => {
  // La prueba que pide el DoD: subir un fichero, olvidar la contrasena,
  // entrar con el papel, poner contrasena nueva y recuperar el fichero.
  it('recupera la boveda y los ficheros tras olvidar la contrasena', async () => {
    const { credentials, token } = await altaYLogin('la que voy a olvidar');

    // Un fichero cifrado con la boveda original.
    const { vault } = await unlockVault('la que voy a olvidar', credentials);
    const { dek, wrappedDek } = await createDek(vault);
    const original = utf8Encode('-----BEGIN OPENSSH PRIVATE KEY-----\nmi clave\n');
    const blob = await encryptBlob(original, dek);

    // Se genera y guarda el Emergency Kit.
    const mk = await exportarMasterKeyParaRecuperacion('la que voy a olvidar', credentials);
    const kit = await crearRecuperacion(mk, PARAMS);
    await app.inject({
      method: 'POST',
      url: '/api/auth/recuperacion',
      cookies: { locker_session: token },
      payload: { recoveryWrappedKey: kit.recoveryWrappedKey, recoverySalt: kit.recoverySalt },
    });

    // --- Pasa el tiempo. La contrasena se olvida. ---
    const intentoFallido = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: EMAIL, authKey: 'no me acuerdo' },
    });
    expect(intentoFallido.statusCode).toBe(401);

    // 1. El cliente pide los datos de recuperacion.
    const challenge = await app.inject({
      method: 'POST',
      url: '/api/auth/recuperacion/challenge',
      payload: { email: EMAIL },
    });
    expect(challenge.statusCode).toBe(200);

    // 2. Desenvuelve la clave maestra con la passphrase del papel.
    const mkRecuperada = await recuperarClaveMaestra(
      kit.passphrase,
      challenge.json().recoveryWrappedKey,
      challenge.json().recoverySalt,
      PARAMS,
    );

    // 3. Fija una contrasena nueva.
    const nuevas = await reenvolverConNuevaPassword(mkRecuperada, 'la contrasena nueva', PARAMS);
    const completar = await app.inject({
      method: 'POST',
      url: '/api/auth/recuperacion/completar',
      payload: {
        email: EMAIL,
        pruebaDeRecuperacion: challenge.json().recoveryWrappedKey,
        kdfSalt: nuevas.kdfSalt,
        authKey: nuevas.authKey,
        wrappedMasterKey: nuevas.wrappedMasterKey,
      },
    });
    expect(completar.statusCode).toBe(200);

    // 4. Entra con la contrasena nueva.
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: EMAIL, authKey: nuevas.authKey },
    });
    expect(login.statusCode).toBe(200);

    // 5. Y el fichero de antes sigue siendo legible, byte a byte.
    const { vault: recuperada } = await unlockVault('la contrasena nueva', {
      ...nuevas,
      wrappedMasterKey: login.json().wrappedMasterKey,
    });
    const dekRecuperada = await unwrapDek(recuperada, wrappedDek);

    expect(await decryptBlob(blob, dekRecuperada)).toEqual(original);
  }, 60_000);

  it('la contrasena vieja deja de servir tras recuperar', async () => {
    const { credentials, token } = await altaYLogin('vieja');
    const mk = await exportarMasterKeyParaRecuperacion('vieja', credentials);
    const kit = await crearRecuperacion(mk, PARAMS);

    await app.inject({
      method: 'POST',
      url: '/api/auth/recuperacion',
      cookies: { locker_session: token },
      payload: { recoveryWrappedKey: kit.recoveryWrappedKey, recoverySalt: kit.recoverySalt },
    });

    const nuevas = await reenvolverConNuevaPassword(mk, 'nueva', PARAMS);
    await app.inject({
      method: 'POST',
      url: '/api/auth/recuperacion/completar',
      payload: {
        email: EMAIL,
        pruebaDeRecuperacion: kit.recoveryWrappedKey,
        kdfSalt: nuevas.kdfSalt,
        authKey: nuevas.authKey,
        wrappedMasterKey: nuevas.wrappedMasterKey,
      },
    });

    const conVieja = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: EMAIL, authKey: credentials.authKey },
    });

    expect(conVieja.statusCode).toBe(401);
  }, 60_000);

  // Si alguien recupero la cuenta, cualquier sesion previa deja de ser de
  // fiar: podria ser justamente la del atacante.
  it('recuperar cierra todas las sesiones abiertas', async () => {
    const { credentials, token } = await altaYLogin('vieja');
    const mk = await exportarMasterKeyParaRecuperacion('vieja', credentials);
    const kit = await crearRecuperacion(mk, PARAMS);

    await app.inject({
      method: 'POST',
      url: '/api/auth/recuperacion',
      cookies: { locker_session: token },
      payload: { recoveryWrappedKey: kit.recoveryWrappedKey, recoverySalt: kit.recoverySalt },
    });

    const nuevas = await reenvolverConNuevaPassword(mk, 'nueva', PARAMS);
    await app.inject({
      method: 'POST',
      url: '/api/auth/recuperacion/completar',
      payload: {
        email: EMAIL,
        pruebaDeRecuperacion: kit.recoveryWrappedKey,
        kdfSalt: nuevas.kdfSalt,
        authKey: nuevas.authKey,
        wrappedMasterKey: nuevas.wrappedMasterKey,
      },
    });

    const conSesionVieja = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { locker_session: token },
    });

    expect(conSesionVieja.statusCode).toBe(401);
  }, 60_000);

  it('rechaza completar con una prueba de recuperacion falsa', async () => {
    const { credentials, token } = await altaYLogin('vieja');
    const mk = await exportarMasterKeyParaRecuperacion('vieja', credentials);
    const kit = await crearRecuperacion(mk, PARAMS);

    await app.inject({
      method: 'POST',
      url: '/api/auth/recuperacion',
      cookies: { locker_session: token },
      payload: { recoveryWrappedKey: kit.recoveryWrappedKey, recoverySalt: kit.recoverySalt },
    });

    const nuevas = await reenvolverConNuevaPassword(mk, 'nueva', PARAMS);
    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/auth/recuperacion/completar',
      payload: {
        email: EMAIL,
        pruebaDeRecuperacion: 'me-lo-invento',
        kdfSalt: nuevas.kdfSalt,
        authKey: nuevas.authKey,
        wrappedMasterKey: nuevas.wrappedMasterKey,
      },
    });

    expect(respuesta.statusCode).toBe(401);
  }, 30_000);
});
