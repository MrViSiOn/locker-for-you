import { createVault } from '@locker/crypto';
import { KDF_PARAMS_V1 } from '@locker/shared';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { applyMigrations, type Db } from '../db/index.js';
import { estadoDeBloqueo, purgarIntentosAntiguos } from './bloqueo.js';

const PARAMS = { ...KDF_PARAMS_V1, memoryKib: 1024, iterations: 1 };
const IP = '203.0.113.7';

let db: Db;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db);
});

afterEach(() => {
  db.close();
});

function anotarFallo(cuandoMs: number, ip = IP): void {
  db.prepare('INSERT INTO login_attempts (ip, email, success, created_at) VALUES (?, ?, 0, ?)').run(
    ip,
    'dani@ejemplo.es',
    new Date(cuandoMs).toISOString(),
  );
}

function anotarAcierto(cuandoMs: number, ip = IP): void {
  db.prepare('INSERT INTO login_attempts (ip, email, success, created_at) VALUES (?, ?, 1, ?)').run(
    ip,
    'dani@ejemplo.es',
    new Date(cuandoMs).toISOString(),
  );
}

describe('escalones de bloqueo', () => {
  const AHORA = Date.UTC(2026, 7, 27, 12, 0, 0);

  it('no bloquea con menos de 5 fallos', () => {
    for (let i = 0; i < 4; i++) anotarFallo(AHORA - 1000);

    expect(estadoDeBloqueo(db, IP, AHORA).bloqueada).toBe(false);
  });

  it('bloquea 1 minuto a partir del quinto fallo', () => {
    for (let i = 0; i < 5; i++) anotarFallo(AHORA - 1000);

    const estado = estadoDeBloqueo(db, IP, AHORA);
    expect(estado.bloqueada).toBe(true);
    expect(estado.segundosRestantes).toBeGreaterThan(0);
    expect(estado.segundosRestantes).toBeLessThanOrEqual(60);
  });

  it('sube a 5 minutos a partir del decimo', () => {
    for (let i = 0; i < 10; i++) anotarFallo(AHORA - 1000);

    const estado = estadoDeBloqueo(db, IP, AHORA);
    expect(estado.segundosRestantes).toBeGreaterThan(60);
    expect(estado.segundosRestantes).toBeLessThanOrEqual(300);
  });

  it('sube a 1 hora a partir del decimoquinto', () => {
    for (let i = 0; i < 15; i++) anotarFallo(AHORA - 1000);

    const estado = estadoDeBloqueo(db, IP, AHORA);
    expect(estado.segundosRestantes).toBeGreaterThan(300);
    expect(estado.segundosRestantes).toBeLessThanOrEqual(3600);
  });

  it('el bloqueo se levanta cuando pasa el tiempo', () => {
    for (let i = 0; i < 5; i++) anotarFallo(AHORA - 90_000);

    // 90 segundos despues del ultimo fallo, el bloqueo de 1 minuto ya expiro.
    expect(estadoDeBloqueo(db, IP, AHORA).bloqueada).toBe(false);
  });

  it('cada fallo nuevo reinicia la espera', () => {
    for (let i = 0; i < 5; i++) anotarFallo(AHORA - 90_000);
    anotarFallo(AHORA - 1000);

    expect(estadoDeBloqueo(db, IP, AHORA).bloqueada).toBe(true);
  });
});

describe('alcance del bloqueo', () => {
  const AHORA = Date.UTC(2026, 7, 27, 12, 0, 0);

  // Contar por IP y no por cuenta es deliberado: bloquear por cuenta
  // permitiria a cualquiera dejar a Dani fuera de su propia boveda sin mas
  // que fallar el login unas cuantas veces.
  it('bloquear una IP no afecta a otra', () => {
    for (let i = 0; i < 10; i++) anotarFallo(AHORA - 1000, '198.51.100.1');

    expect(estadoDeBloqueo(db, '198.51.100.1', AHORA).bloqueada).toBe(true);
    expect(estadoDeBloqueo(db, IP, AHORA).bloqueada).toBe(false);
  });

  // Si alguien acerto, no tiene sentido seguir castigandolo por los fallos
  // anteriores: quien conoce la contrasena no esta haciendo fuerza bruta.
  it('un login correcto borra la cuenta de fallos previos', () => {
    for (let i = 0; i < 10; i++) anotarFallo(AHORA - 10_000);
    anotarAcierto(AHORA - 5000);

    expect(estadoDeBloqueo(db, IP, AHORA).bloqueada).toBe(false);
  });

  it('los fallos posteriores a un acierto si cuentan', () => {
    anotarAcierto(AHORA - 60_000);
    for (let i = 0; i < 5; i++) anotarFallo(AHORA - 1000);

    expect(estadoDeBloqueo(db, IP, AHORA).bloqueada).toBe(true);
  });

  it('los fallos de hace mas de una hora ya no pesan', () => {
    for (let i = 0; i < 20; i++) anotarFallo(AHORA - 2 * 60 * 60_000);

    expect(estadoDeBloqueo(db, IP, AHORA).bloqueada).toBe(false);
  });
});

describe('purga de intentos', () => {
  // Sin purga, un bot machacando el login durante meses acabaria llenando el
  // disco del VPS: un problema mas grave que el propio intento de entrar.
  it('borra los intentos mas viejos que la retencion', () => {
    anotarFallo(Date.now() - 10 * 24 * 60 * 60_000);
    anotarFallo(Date.now() - 1000);

    const borrados = purgarIntentosAntiguos(db, 7);

    expect(borrados).toBe(1);
    const quedan = db.prepare('SELECT COUNT(*) AS n FROM login_attempts').get() as { n: number };
    expect(quedan.n).toBe(1);
  });
});

describe('el login aplica el bloqueo de verdad', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({ db });

    const { credentials } = await createVault('la buena', PARAMS);
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
  });

  afterEach(async () => {
    await app.close();
  });

  async function intentar(authKey = 'incorrecta'): Promise<number> {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'dani@ejemplo.es', authKey },
    });
    return respuesta.statusCode;
  }

  it('tras 5 fallos devuelve 429 en vez de 401', async () => {
    const codigos: number[] = [];
    for (let i = 0; i < 7; i++) {
      codigos.push(await intentar());
    }

    // Los cinco primeros son credenciales invalidas; a partir de ahi, bloqueo.
    expect(codigos.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codigos.slice(5)).toEqual([429, 429]);
  }, 30_000);

  it('el 429 incluye Retry-After', async () => {
    for (let i = 0; i < 5; i++) await intentar();

    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'dani@ejemplo.es', authKey: 'incorrecta' },
    });

    expect(respuesta.statusCode).toBe(429);
    expect(Number(respuesta.headers['retry-after'])).toBeGreaterThan(0);
  }, 30_000);

  // Estando bloqueado no se comprueba la credencial: eso ahorra el Argon2id,
  // que es justo el gasto que un atacante quiere provocar.
  it('estando bloqueado rechaza incluso la contrasena correcta', async () => {
    const { credentials } = await createVault('otra distinta', PARAMS);
    for (let i = 0; i < 5; i++) await intentar();

    expect(await intentar(credentials.authKey)).toBe(429);
  }, 30_000);
});
