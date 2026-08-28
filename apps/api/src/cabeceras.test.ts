import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { applyMigrations } from './db/index.js';

/**
 * Estas cabeceras son la unica defensa contra el fallo que se lo lleva todo:
 * un script inyectado corre con la clave maestra en memoria. Los tests estan
 * para que nadie las relaje sin enterarse.
 */

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

async function cabeceras(url = '/api/health'): Promise<Record<string, string>> {
  const respuesta = await app.inject({ method: 'GET', url });
  return respuesta.headers as Record<string, string>;
}

describe('politica de contenido', () => {
  it('no permite scripts en linea ni eval de JavaScript', async () => {
    const csp = (await cabeceras())['content-security-policy'] ?? '';

    expect(csp).toContain("script-src 'self'");

    // Lo mas importante del fichero entero: con cualquiera de estos dos, un
    // <script> inyectado en un hueco de la pagina se ejecutaria con la clave
    // maestra al alcance.
    expect(csp).not.toContain("'unsafe-inline'; script");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");

    // 'unsafe-eval' a secas NO, pero 'wasm-unsafe-eval' SI: sin el, Argon2id
    // no compila y no se puede ni abrir la boveda. Este `replace` distingue
    // los dos, que es justo lo que hay que vigilar.
    expect(csp.replace(/'wasm-unsafe-eval'/g, '')).not.toContain('unsafe-eval');
  });

  it('permite compilar WebAssembly, que es lo que necesita Argon2id', async () => {
    const csp = (await cabeceras())['content-security-policy'] ?? '';

    // Si alguien lo quita "por endurecer", la app deja de dejar entrar. Se
    // descubrio en el navegador y este test existe para que no se repita.
    expect(csp).toContain("'wasm-unsafe-eval'");
  });

  it('impide hablar con cualquier origen ajeno', async () => {
    const csp = (await cabeceras())['content-security-policy'] ?? '';

    // Si algun dia entrara codigo hostil, no tendria a donde mandar el botin.
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("font-src 'self'");
  });

  it('cierra el marcado que puede desviar peticiones', async () => {
    const csp = (await cabeceras())['content-security-policy'] ?? '';

    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
  });

  it('prohibe que la pagina se meta en un iframe', async () => {
    const cabezas = await cabeceras();

    expect(cabezas['content-security-policy']).toContain("frame-ancestors 'none'");
    // Duplicado a proposito para navegadores que no leen la CSP.
    expect(cabezas['x-frame-options']).toBe('DENY');
  });
});

describe('cabeceras de acompanamiento', () => {
  it('impide adivinar el tipo de contenido', async () => {
    expect((await cabeceras())['x-content-type-options']).toBe('nosniff');
  });

  it('no filtra ni el dominio al salir', async () => {
    // En una boveda personal, el propio hecho de estar usandola ya es
    // informacion sobre su dueno.
    expect((await cabeceras())['referrer-policy']).toBe('no-referrer');
  });

  it('cierra camara, microfono y ubicacion', async () => {
    const permisos = (await cabeceras())['permissions-policy'] ?? '';

    expect(permisos).toContain('camera=()');
    expect(permisos).toContain('microphone=()');
    expect(permisos).toContain('geolocation=()');
  });

  it('no manda HSTS fuera de produccion', async () => {
    // En local no hay TLS: mandarlo dejaria el navegador insistiendo en
    // https://localhost durante dos anos, y cuesta bastante de deshacer.
    expect((await cabeceras())['strict-transport-security']).toBeUndefined();
  });

  it('las pone tambien en las respuestas de error', async () => {
    // Es donde mas facil es olvidarlas, y una pagina de error tambien se
    // puede usar para colar marcado.
    const cabezas = await cabeceras('/api/nodes');

    expect(cabezas['content-security-policy']).toBeDefined();
    expect(cabezas['x-frame-options']).toBe('DENY');
  });
});

describe('robots', () => {
  it('pide que no se indexe nada', async () => {
    const respuesta = await app.inject({ method: 'GET', url: '/robots.txt' });

    expect(respuesta.statusCode).toBe(200);
    expect(respuesta.body).toContain('Disallow: /');
  });
});
