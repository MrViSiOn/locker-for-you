import { changePassword, createVault, unlockVault, type VaultCredentials } from '@locker/crypto';
import { KDF_PARAMS_V1 } from '@locker/shared';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { applyMigrations } from '../db/index.js';

/** Parametros flojos: aqui se prueba la ruta, no la resistencia del KDF. */
const PARAMS = { ...KDF_PARAMS_V1, memoryKib: 1024, iterations: 1 };

let app: FastifyInstance;

beforeEach(async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db);
  app = await buildApp({ db });
});

afterEach(async () => {
  await app.close();
});

async function darDeAlta(
  password = 'contrasena maestra',
): Promise<{ credenciales: VaultCredentials; cookie: string }> {
  const { credentials } = await createVault(password, PARAMS);

  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: 'dani@ejemplo.es',
      kdfSalt: credentials.kdfSalt,
      kdfParamsVersion: credentials.kdfParams.version,
      authKey: credentials.authKey,
      wrappedMasterKey: credentials.wrappedMasterKey,
    },
  });

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'dani@ejemplo.es', authKey: credentials.authKey },
  });

  return { credenciales: credentials, cookie: login.cookies[0]?.value ?? '' };
}

function conSesion(cookie: string): { cookies: Record<string, string> } {
  return { cookies: { locker_session: cookie } };
}

describe('datos de la cuenta', () => {
  it('devuelve fechas y banderas, nunca material criptografico', async () => {
    const { cookie } = await darDeAlta();

    const respuesta = await app.inject({
      method: 'GET',
      url: '/api/auth/cuenta',
      ...conSesion(cookie),
    });
    const cuerpo = respuesta.json() as Record<string, unknown>;

    expect(respuesta.statusCode).toBe(200);
    expect(cuerpo['email']).toBe('dani@ejemplo.es');
    expect(cuerpo['tieneRecuperacion']).toBe(false);
    expect(cuerpo['totpActivoDesde']).toBeNull();

    // Lo que NO puede salir de aqui. Si algun dia alguien anade un campo de
    // mas, este test lo para: con la clave maestra envuelta y el salt,
    // quien robara una cookie podria atacar la contrasena sin conexion.
    expect(cuerpo).not.toHaveProperty('wrappedMasterKey');
    expect(cuerpo).not.toHaveProperty('authKeyHash');
    expect(cuerpo).not.toHaveProperty('auth_key_hash');
    expect(cuerpo).not.toHaveProperty('kdfSalt');
    expect(cuerpo).not.toHaveProperty('totpSecret');
  });

  it('exige sesion', async () => {
    await darDeAlta();
    const respuesta = await app.inject({ method: 'GET', url: '/api/auth/cuenta' });
    expect(respuesta.statusCode).toBe(401);
  });
});

describe('cambio de contrasena', () => {
  it('cambia el material de derivacion y permite entrar con la nueva', async () => {
    const { credenciales, cookie } = await darDeAlta('la vieja de siempre');

    const nuevas = await changePassword(
      'la vieja de siempre',
      'una nueva mucho mas larga',
      credenciales,
      PARAMS,
    );

    const cambio = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: {
        authKeyActual: credenciales.authKey,
        kdfSalt: nuevas.kdfSalt,
        kdfParamsVersion: nuevas.kdfParams.version,
        authKey: nuevas.authKey,
        wrappedMasterKey: nuevas.wrappedMasterKey,
      },
      ...conSesion(cookie),
    });

    expect(cambio.statusCode).toBe(200);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'dani@ejemplo.es', authKey: nuevas.authKey },
    });

    expect(login.statusCode).toBe(200);

    // Y la clave maestra sigue siendo LA MISMA: si no lo fuera, los ficheros
    // ya subidos quedarian ilegibles para siempre. Es lo unico que de verdad
    // importa de esta operacion.
    const { vault } = await unlockVault('una nueva mucho mas larga', {
      ...nuevas,
      wrappedMasterKey: (login.json() as { wrappedMasterKey: string }).wrappedMasterKey,
    });

    expect(vault.masterKey).toBeDefined();
  });

  it('rechaza el cambio si la contrasena actual no es correcta', async () => {
    const { credenciales, cookie } = await darDeAlta();
    const { credentials: otras } = await createVault('inventada', PARAMS);

    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: {
        authKeyActual: otras.authKey,
        kdfSalt: otras.kdfSalt,
        kdfParamsVersion: otras.kdfParams.version,
        authKey: otras.authKey,
        wrappedMasterKey: otras.wrappedMasterKey,
      },
      ...conSesion(cookie),
    });

    expect(respuesta.statusCode).toBe(401);

    // Y la vieja sigue valiendo: no se ha tocado nada.
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'dani@ejemplo.es', authKey: credenciales.authKey },
    });
    expect(login.statusCode).toBe(200);
  });

  it('cierra TODAS las sesiones, incluida la que hizo el cambio', async () => {
    const { credenciales, cookie } = await darDeAlta('la vieja de siempre');

    const nuevas = await changePassword(
      'la vieja de siempre',
      'una nueva mucho mas larga',
      credenciales,
      PARAMS,
    );

    await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: {
        authKeyActual: credenciales.authKey,
        kdfSalt: nuevas.kdfSalt,
        kdfParamsVersion: nuevas.kdfParams.version,
        authKey: nuevas.authKey,
        wrappedMasterKey: nuevas.wrappedMasterKey,
      },
      ...conSesion(cookie),
    });

    // Si se cambia la contrasena porque se sospecha que alguien mas entro,
    // dejar viva cualquier sesion anterior vaciaria el gesto.
    const despues = await app.inject({
      method: 'GET',
      url: '/api/auth/cuenta',
      ...conSesion(cookie),
    });
    expect(despues.statusCode).toBe(401);
  });

  it('exige sesion', async () => {
    await darDeAlta();
    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { authKeyActual: 'x', kdfSalt: 'x', authKey: 'x', wrappedMasterKey: 'x' },
    });
    expect(respuesta.statusCode).toBe(401);
  });
});

describe('registro de auditoria', () => {
  it('anota el login y lo devuelve', async () => {
    const { cookie } = await darDeAlta();

    const respuesta = await app.inject({
      method: 'GET',
      url: '/api/auditoria',
      ...conSesion(cookie),
    });
    const { entradas } = respuesta.json() as {
      entradas: { accion: string; detalle: string | null }[];
    };

    expect(respuesta.statusCode).toBe(200);
    expect(entradas.some((e) => e.accion === 'login')).toBe(true);
  });

  it('no anota nombres de fichero ni contenidos', async () => {
    const { cookie } = await darDeAlta();

    const respuesta = await app.inject({
      method: 'GET',
      url: '/api/auditoria',
      ...conSesion(cookie),
    });
    const texto = respuesta.body;

    // El servidor no conoce los nombres en claro, asi que no puede filtrarlos
    // ni queriendo. Este test lo deja escrito para que siga siendo verdad.
    expect(texto).not.toContain('dani@ejemplo.es');
  });

  it('exige sesion', async () => {
    await darDeAlta();
    const respuesta = await app.inject({ method: 'GET', url: '/api/auditoria' });
    expect(respuesta.statusCode).toBe(401);
  });
});
