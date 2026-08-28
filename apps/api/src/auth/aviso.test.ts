import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyMigrations, type Db } from '../db/index.js';

/**
 * El transporte SMTP se sustituye por un doble: estos tests comprueban la
 * logica del aviso (antiflood, contenido, tolerancia a fallos) sin mandar
 * correo de verdad ni depender de que haya un servidor levantado.
 */
const enviados: { to: string; subject: string; text: string }[] = [];
let fallarEnvio = false;

vi.mock('nodemailer', () => ({
  createTransport: () => ({
    sendMail: (mensaje: { to: string; subject: string; text: string }) => {
      if (fallarEnvio) {
        return Promise.reject(new Error('SMTP caido'));
      }
      enviados.push(mensaje);
      return Promise.resolve({ messageId: 'x' });
    },
  }),
}));

vi.mock('../config.js', () => ({
  config: {
    smtp: {
      host: '127.0.0.1',
      port: 587,
      user: 'locker@ejemplo.es',
      pass: 'secreta',
      destinoAvisos: 'dani@ejemplo.es',
    },
  },
}));

const { avisarDeIntentos, reiniciarTransporte } = await import('./aviso.js');

let db: Db;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db);
  db.prepare(
    `INSERT INTO users (id, email, kdf_salt, kdf_params_version, auth_key_hash,
                        wrapped_master_key, created_at, updated_at)
     VALUES ('u1', 'dani@ejemplo.es', 's', 1, 'h', 'mk', ?, ?)`,
  ).run(new Date().toISOString(), new Date().toISOString());

  enviados.length = 0;
  fallarEnvio = false;
  reiniciarTransporte();
});

afterEach(() => {
  db.close();
});

const DATOS = { ip: '203.0.113.7', fallos: 5, minutosBloqueo: 1 };

describe('envio del aviso', () => {
  it('manda el correo al superar el umbral', async () => {
    const enviado = await avisarDeIntentos(db, 'u1', DATOS);

    expect(enviado).toBe(true);
    expect(enviados).toHaveLength(1);
    expect(enviados[0]?.to).toBe('dani@ejemplo.es');
    expect(enviados[0]?.subject).toContain('203.0.113.7');
  });

  it('el cuerpo lleva lo que hace falta para decidir si preocuparse', async () => {
    await avisarDeIntentos(db, 'u1', DATOS);

    const texto = enviados[0]?.text ?? '';
    expect(texto).toContain('203.0.113.7');
    expect(texto).toContain('5 fallidos');
    expect(texto).toContain('1 minutos');
  });

  // Este correo sale del servidor y viaja por internet en claro por varios
  // saltos: no puede llevar NADA de la boveda.
  it('no filtra ningun dato de la boveda', async () => {
    await avisarDeIntentos(db, 'u1', DATOS);

    const texto = enviados[0]?.text ?? '';
    for (const prohibido of ['wrapped', 'master', 'dek', 'blob', 'hash', 'salt', 'token']) {
      expect(texto.toLowerCase()).not.toContain(prohibido);
    }
  });

  it('recuerda que los ficheros siguen a salvo', async () => {
    await avisarDeIntentos(db, 'u1', DATOS);

    expect(enviados[0]?.text).toContain('siguen cifrados');
  });

  it('deja constancia en la auditoria', async () => {
    await avisarDeIntentos(db, 'u1', DATOS);

    const fila = db
      .prepare(`SELECT action, ip FROM audit_log WHERE action = 'aviso_intentos'`)
      .get() as { action: string; ip: string } | undefined;

    expect(fila?.ip).toBe('203.0.113.7');
  });
});

describe('antiflood', () => {
  // Un bot machacando el login no puede convertirse en cientos de correos: el
  // aviso pasaria de util a ruido y acabaria en la papelera sin leer justo el
  // dia que importe.
  it('no repite el aviso de la misma IP en 6 horas', async () => {
    expect(await avisarDeIntentos(db, 'u1', DATOS)).toBe(true);
    expect(await avisarDeIntentos(db, 'u1', DATOS)).toBe(false);
    expect(await avisarDeIntentos(db, 'u1', DATOS)).toBe(false);

    expect(enviados).toHaveLength(1);
  });

  it('si avisa de una IP distinta', async () => {
    await avisarDeIntentos(db, 'u1', DATOS);
    await avisarDeIntentos(db, 'u1', { ...DATOS, ip: '198.51.100.1' });

    expect(enviados).toHaveLength(2);
  });

  it('vuelve a avisar pasadas las 6 horas', async () => {
    await avisarDeIntentos(db, 'u1', DATOS);

    // Se envejece el aviso anterior.
    db.prepare(`UPDATE audit_log SET created_at = ? WHERE action = 'aviso_intentos'`).run(
      new Date(Date.now() - 7 * 60 * 60_000).toISOString(),
    );

    expect(await avisarDeIntentos(db, 'u1', DATOS)).toBe(true);
    expect(enviados).toHaveLength(2);
  });
});

describe('tolerancia a fallos', () => {
  // Si el SMTP esta caido, lo peor que debe pasar es quedarse sin aviso.
  // Nunca que el usuario no pueda entrar en su propia boveda.
  it('un fallo de envio no lanza', async () => {
    fallarEnvio = true;

    await expect(avisarDeIntentos(db, 'u1', DATOS)).resolves.toBe(false);
  });

  it('un envio fallido no se anota como avisado, para poder reintentar', async () => {
    fallarEnvio = true;
    await avisarDeIntentos(db, 'u1', DATOS);

    const filas = db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'aviso_intentos'`)
      .get() as { n: number };
    expect(filas.n).toBe(0);

    // Y cuando el correo vuelve, el aviso sale.
    fallarEnvio = false;
    expect(await avisarDeIntentos(db, 'u1', DATOS)).toBe(true);
  });
});
