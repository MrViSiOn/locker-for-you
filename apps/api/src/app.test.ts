import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { applyMigrations } from './db/index.js';
import { MIGRATIONS } from './db/migrations.js';

/** Base en memoria: cada test arranca con una bóveda vacía y no toca el disco. */
function dbDePrueba(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db);
  return db;
}

describe('GET /api/health', () => {
  it('responde 200 con estado ok y la version del esquema', async () => {
    const app = await buildApp({ db: dbDePrueba() });
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      schemaVersion: MIGRATIONS.length,
    });

    await app.close();
  });

  it('no filtra nada del usuario ni del contenido', async () => {
    const app = await buildApp({ db: dbDePrueba() });
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(Object.keys(response.json()).sort()).toEqual([
      'schemaVersion',
      'status',
      'uptimeSeconds',
    ]);

    await app.close();
  });
});

describe('endpoints inexistentes', () => {
  it('devuelve 404 en JSON bajo /api, no el index de la SPA', async () => {
    const app = await buildApp({ db: dbDePrueba() });
    const response = await app.inject({ method: 'GET', url: '/api/no-existe' });

    expect(response.statusCode).toBe(404);

    await app.close();
  });
});
