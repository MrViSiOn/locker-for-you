import { createVault, unlockVault, type VaultCredentials } from '@locker/crypto';
import { KDF_PARAMS_V1 } from '@locker/shared';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { applyMigrations } from '../db/index.js';

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

/** Da de alta una cuenta como lo haria el navegador: cifrando antes de enviar. */
async function darDeAlta(
  email = 'dani@ejemplo.es',
  password = 'contrasena maestra',
): Promise<VaultCredentials> {
  const { credentials } = await createVault(password, PARAMS);

  const respuesta = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email,
      kdfSalt: credentials.kdfSalt,
      kdfParamsVersion: credentials.kdfParams.version,
      authKey: credentials.authKey,
      wrappedMasterKey: credentials.wrappedMasterKey,
    },
  });

  expect(respuesta.statusCode).toBe(201);
  return credentials;
}

describe('alta de la cuenta', () => {
  it('crea la primera cuenta', async () => {
    await darDeAlta();

    const estado = await app.inject({ method: 'GET', url: '/api/auth/estado' });
    expect(estado.json()).toEqual({ tieneCuenta: true });
  });

  // No queremos un endpoint de registro abierto en internet.
  it('rechaza una segunda cuenta con 403', async () => {
    await darDeAlta();
    const { credentials } = await createVault('otra', PARAMS);

    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'intruso@ejemplo.es',
        kdfSalt: credentials.kdfSalt,
        authKey: credentials.authKey,
        wrappedMasterKey: credentials.wrappedMasterKey,
      },
    });

    expect(respuesta.statusCode).toBe(403);
  });

  it('rechaza un alta con campos incompletos', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'dani@ejemplo.es' },
    });

    expect(respuesta.statusCode).toBe(400);
  });
});

describe('el servidor nunca ve la contrasena ni la clave maestra', () => {
  // El nucleo del modelo. Si esto falla, todo lo demas es decorado.
  it('no guarda la contrasena ni nada que se le parezca', async () => {
    const password = 'contrasena-secretisima-12345';
    await darDeAlta('dani@ejemplo.es', password);

    // Vuelca la fila entera del usuario y busca la contrasena en cualquier campo.
    const fila = app.db.prepare('SELECT * FROM users').get() as Record<string, unknown>;
    const volcado = JSON.stringify(fila);

    expect(volcado).not.toContain(password);
    expect(volcado).not.toContain('contrasena-secretisima');
  });

  it('la clave maestra solo esta envuelta: no se puede usar sin la contrasena', async () => {
    const credenciales = await darDeAlta('dani@ejemplo.es', 'la buena');

    const fila = app.db.prepare('SELECT wrapped_master_key FROM users').get() as {
      wrapped_master_key: string;
    };

    // Lo que guarda el servidor es exactamente lo que le mando el cliente:
    // la MK envuelta. Desenvolverla exige derivar la KEK de la contrasena.
    expect(fila.wrapped_master_key).toBe(credenciales.wrappedMasterKey);
    await expect(unlockVault('la mala', credenciales)).rejects.toThrow();
  });

  it('guarda la authKey hasheada con Argon2id, nunca en claro', async () => {
    const credenciales = await darDeAlta();

    const fila = app.db.prepare('SELECT auth_key_hash FROM users').get() as {
      auth_key_hash: string;
    };

    expect(fila.auth_key_hash).not.toBe(credenciales.authKey);
    expect(fila.auth_key_hash).toMatch(/^\$argon2id\$/);
  });
});

describe('challenge', () => {
  it('devuelve el salt real de un usuario existente', async () => {
    const credenciales = await darDeAlta();

    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { email: 'dani@ejemplo.es' },
    });

    expect(respuesta.json()).toMatchObject({ kdfSalt: credenciales.kdfSalt });
  });

  // Sin esto, este endpoint seria un enumerador de usuarios: bastaria con
  // ver quien devuelve 404 y quien devuelve un salt.
  it('devuelve un salt de aspecto normal para un email inexistente', async () => {
    await darDeAlta();

    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { email: 'no-existe@ejemplo.es' },
    });

    expect(respuesta.statusCode).toBe(200);
    expect(respuesta.json().kdfSalt).toBeTruthy();
  });

  /**
   * ESTE TEST NACE DE UN AGUJERO REAL (auditoria de DRAPPS-1054).
   *
   * "Aspecto normal" no basta con que sea una cadena cualquiera: tiene que
   * ser INDISTINGUIBLE del salt de verdad. El salt falso se generaba
   * cortando el texto base64 de un SHA-256 a 24 caracteres, y salia sin
   * relleno; el real son 16 bytes, que en base64 acaban en "==".
   *
   *   correo sin cuenta -> W/ttPySc6dVzjuGfCW4FRFj6
   *   correo con cuenta -> qz6Vv3RDB12Uvbc9Sexpfw==
   *
   * Con una sola peticion y sin intentar entrar, se sabia quien tiene
   * cuenta. Los tres tests de al lado pasaban igualmente.
   */
  it('el salt falso es indistinguible del real: misma longitud y mismo relleno', async () => {
    const credenciales = await darDeAlta();

    const inventado = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { email: 'no-existe@ejemplo.es' },
    });

    const falso = (inventado.json() as { kdfSalt: string }).kdfSalt;
    const real = credenciales.kdfSalt;

    expect(falso.length).toBe(real.length);
    expect(falso.endsWith('==')).toBe(real.endsWith('=='));

    // Y decodificados pesan lo mismo, que es la comprobacion de fondo.
    expect(Buffer.from(falso, 'base64').length).toBe(Buffer.from(real, 'base64').length);
  });

  // Un salt aleatorio en cada peticion delataria igual: bastaria con
  // preguntar dos veces y ver si cambia.
  it('el salt falso es el mismo si se pregunta dos veces', async () => {
    const primera = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { email: 'fantasma@ejemplo.es' },
    });
    const segunda = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { email: 'fantasma@ejemplo.es' },
    });

    expect(primera.json().kdfSalt).toBe(segunda.json().kdfSalt);
  });

  it('emails distintos reciben salts falsos distintos', async () => {
    const uno = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { email: 'uno@ejemplo.es' },
    });
    const otro = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { email: 'otro@ejemplo.es' },
    });

    expect(uno.json().kdfSalt).not.toBe(otro.json().kdfSalt);
  });
});

describe('login', () => {
  it('acepta la contrasena correcta y entrega la clave maestra envuelta', async () => {
    const credenciales = await darDeAlta('dani@ejemplo.es', 'la buena');

    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'dani@ejemplo.es', authKey: credenciales.authKey },
    });

    expect(respuesta.statusCode).toBe(200);
    expect(respuesta.json().wrappedMasterKey).toBe(credenciales.wrappedMasterKey);
    expect(respuesta.cookies[0]?.name).toBe('locker_session');
  });

  it('la cookie de sesion es httpOnly y SameSite=Strict', async () => {
    const credenciales = await darDeAlta();

    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'dani@ejemplo.es', authKey: credenciales.authKey },
    });

    const cookie = respuesta.cookies[0];
    // httpOnly la hace ilegible desde JavaScript, asi que un XSS no puede
    // robarla; SameSite=Strict corta los ataques CSRF.
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite?.toLowerCase()).toBe('strict');
  });

  it('rechaza una authKey incorrecta', async () => {
    await darDeAlta('dani@ejemplo.es', 'la buena');
    const { credentials: malas } = await createVault('la mala', PARAMS);

    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'dani@ejemplo.es', authKey: malas.authKey },
    });

    expect(respuesta.statusCode).toBe(401);
  });

  // Distinguir "no existe" de "contrasena mal" regala la mitad del trabajo a
  // quien ataca: ya sabria que emails probar.
  it('no distingue entre usuario inexistente y contrasena incorrecta', async () => {
    const credenciales = await darDeAlta('dani@ejemplo.es', 'la buena');
    const { credentials: malas } = await createVault('la mala', PARAMS);

    const inexistente = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'fantasma@ejemplo.es', authKey: credenciales.authKey },
    });
    const contrasenaMala = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'dani@ejemplo.es', authKey: malas.authKey },
    });

    expect(inexistente.statusCode).toBe(contrasenaMala.statusCode);
    expect(inexistente.json()).toEqual(contrasenaMala.json());
  });

  it('no entrega la clave maestra envuelta si el login falla', async () => {
    await darDeAlta('dani@ejemplo.es', 'la buena');
    const { credentials: malas } = await createVault('la mala', PARAMS);

    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'dani@ejemplo.es', authKey: malas.authKey },
    });

    expect(JSON.stringify(respuesta.json())).not.toContain('wrappedMasterKey');
  });

  it('registra cada intento para el rate limit', async () => {
    const credenciales = await darDeAlta();

    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'dani@ejemplo.es', authKey: 'incorrecta' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'dani@ejemplo.es', authKey: credenciales.authKey },
    });

    const intentos = app.db.prepare('SELECT success FROM login_attempts ORDER BY id').all() as {
      success: number;
    }[];

    expect(intentos.map((i) => i.success)).toEqual([0, 1]);
  });

  it('el email no distingue mayusculas', async () => {
    const credenciales = await darDeAlta('dani@ejemplo.es');

    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'DANI@Ejemplo.ES', authKey: credenciales.authKey },
    });

    expect(respuesta.statusCode).toBe(200);
  });
});

describe('sesion', () => {
  async function iniciarSesion(): Promise<string> {
    const credenciales = await darDeAlta();
    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'dani@ejemplo.es', authKey: credenciales.authKey },
    });
    return respuesta.cookies[0]?.value ?? '';
  }

  it('/me devuelve el usuario con una sesion valida', async () => {
    const token = await iniciarSesion();

    const respuesta = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { locker_session: token },
    });

    expect(respuesta.json()).toMatchObject({ email: 'dani@ejemplo.es' });
  });

  it('/me devuelve 401 sin cookie', async () => {
    const respuesta = await app.inject({ method: 'GET', url: '/api/auth/me' });

    expect(respuesta.statusCode).toBe(401);
  });

  it('/me devuelve 401 con un token inventado', async () => {
    const respuesta = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { locker_session: 'token-que-me-acabo-de-inventar' },
    });

    expect(respuesta.statusCode).toBe(401);
  });

  it('logout invalida la sesion', async () => {
    const token = await iniciarSesion();

    await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { locker_session: token },
    });

    const despues = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { locker_session: token },
    });

    expect(despues.statusCode).toBe(401);
  });

  it('una sesion caducada no vale y se limpia sola', async () => {
    const token = await iniciarSesion();

    app.db
      .prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), token);

    const respuesta = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { locker_session: token },
    });

    expect(respuesta.statusCode).toBe(401);
    const quedan = app.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    expect(quedan.n).toBe(0);
  });
});

describe('ciclo completo con la boveda', () => {
  // La prueba de que el modelo funciona de punta a punta: alta, login y
  // recuperacion de la clave maestra usando solo lo que devuelve el servidor.
  it('tras el login se puede abrir la boveda con la contrasena', async () => {
    const credenciales = await darDeAlta('dani@ejemplo.es', 'mi contrasena maestra');

    const challenge = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { email: 'dani@ejemplo.es' },
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'dani@ejemplo.es', authKey: credenciales.authKey },
    });

    // El cliente reconstruye las credenciales con lo que le dio el servidor.
    const { vault } = await unlockVault('mi contrasena maestra', {
      kdfSalt: challenge.json().kdfSalt,
      kdfParams: PARAMS,
      authKey: credenciales.authKey,
      wrappedMasterKey: login.json().wrappedMasterKey,
    });

    expect(vault.masterKey.extractable).toBe(false);
    expect(vault.nameKey).toBeDefined();
  });
});
