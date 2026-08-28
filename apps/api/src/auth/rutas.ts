import { KDF_PARAMS_V1, type AuthChallengeResponse } from '@locker/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { config } from '../config.js';
import { avisarDeIntentos } from './aviso.js';
import { estadoDeBloqueo } from './bloqueo.js';
import type { Db } from '../db/index.js';
import {
  hashAuthKey,
  nuevoId,
  nuevoTokenDeSesion,
  saltFalso,
  verifyAuthKey,
} from './credenciales.js';

/**
 * Autenticacion zero-knowledge.
 *
 * El servidor no ve la contrasena en ningun momento. Recibe una `authKey`
 * derivada en el navegador y devuelve, si es correcta, la clave maestra
 * ENVUELTA -- que solo el navegador puede desenvolver con la otra mitad de
 * lo que derivo de la contrasena.
 */

const NOMBRE_COOKIE = 'locker_session';
const DURACION_SESION_MS = 12 * 60 * 60 * 1000;

interface FilaUsuario {
  id: string;
  email: string;
  kdf_salt: string;
  kdf_params_version: number;
  auth_key_hash: string;
  wrapped_master_key: string;
  totp_secret_encrypted: string | null;
}

export interface SesionActiva {
  userId: string;
  totpVerified: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    sesion?: SesionActiva;
  }
}

export function registrarRutasDeAuth(app: FastifyInstance): void {
  /**
   * Alta de la cuenta. Solo funciona mientras no haya ningun usuario: no
   * queremos un endpoint de registro abierto en internet.
   */
  app.post('/api/auth/register', async (request, reply) => {
    const cuerpo = request.body as {
      email?: string;
      kdfSalt?: string;
      kdfParamsVersion?: number;
      authKey?: string;
      wrappedMasterKey?: string;
    };

    if (
      typeof cuerpo.email !== 'string' ||
      typeof cuerpo.kdfSalt !== 'string' ||
      typeof cuerpo.authKey !== 'string' ||
      typeof cuerpo.wrappedMasterKey !== 'string'
    ) {
      return reply.code(400).send({ error: 'bad_request', message: 'Faltan campos obligatorios.' });
    }

    const existentes = app.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    if (existentes.n > 0) {
      return reply
        .code(403)
        .send({ error: 'registro_cerrado', message: 'Ya existe una cuenta en esta boveda.' });
    }

    const ahora = new Date().toISOString();
    app.db
      .prepare(
        `INSERT INTO users (id, email, kdf_salt, kdf_params_version, auth_key_hash,
                            wrapped_master_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        nuevoId(),
        cuerpo.email.toLowerCase(),
        cuerpo.kdfSalt,
        cuerpo.kdfParamsVersion ?? KDF_PARAMS_V1.version,
        await hashAuthKey(cuerpo.authKey),
        cuerpo.wrappedMasterKey,
        ahora,
        ahora,
      );

    return reply.code(201).send({ ok: true });
  });

  /** Dice si la boveda ya tiene cuenta, para que la UI sepa que pantalla mostrar. */
  app.get('/api/auth/estado', async () => {
    const existentes = app.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    return { tieneCuenta: existentes.n > 0 };
  });

  /**
   * Primer paso del login: el cliente necesita el salt y los parametros con
   * los que derivar su authKey.
   *
   * A un email que no existe se le responde igual, con un salt falso pero
   * determinista. Devolver 404 convertiria este endpoint en un enumerador de
   * usuarios, y un salt aleatorio distinto en cada intento delataria igual.
   */
  app.post('/api/auth/challenge', async (request, reply) => {
    const cuerpo = request.body as { email?: string };

    if (typeof cuerpo.email !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'Falta el email.' });
    }

    const usuario = buscarUsuario(app.db, cuerpo.email);

    const respuesta: AuthChallengeResponse =
      usuario === undefined
        ? { kdfSalt: saltFalso(cuerpo.email, config.saltPepper), kdfParams: KDF_PARAMS_V1 }
        : { kdfSalt: usuario.kdf_salt, kdfParams: KDF_PARAMS_V1 };

    return reply.send(respuesta);
  });

  /**
   * Login. Verifica la authKey y, si es correcta, entrega la clave maestra
   * envuelta y abre sesion.
   */
  app.post('/api/auth/login', async (request, reply) => {
    const cuerpo = request.body as { email?: string; authKey?: string };

    if (typeof cuerpo.email !== 'string' || typeof cuerpo.authKey !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'Faltan credenciales.' });
    }

    // Antes de tocar nada: si esta IP acumula fallos, ni se comprueba la
    // credencial. Ahorra el Argon2id (que es justo lo que un atacante quiere
    // hacerte gastar) y hace inviable la fuerza bruta online.
    const bloqueo = estadoDeBloqueo(app.db, request.ip);
    if (bloqueo.bloqueada) {
      registrarIntento(app.db, request.ip, cuerpo.email, false);
      return reply
        .code(429)
        .header('Retry-After', String(bloqueo.segundosRestantes))
        .send({
          error: 'demasiados_intentos',
          message: `Demasiados intentos fallidos. Vuelve a probar en ${String(bloqueo.segundosRestantes)} segundos.`,
        });
    }

    const usuario = buscarUsuario(app.db, cuerpo.email);

    // Se verifica SIEMPRE contra un hash, exista el usuario o no. Sin esto,
    // un email inexistente respondería mucho antes que uno real y el tiempo
    // de respuesta revelaria quien tiene cuenta.
    const hashAComparar = usuario?.auth_key_hash ?? config.hashSenuelo;
    const correcta = await verifyAuthKey(cuerpo.authKey, hashAComparar);

    registrarIntento(app.db, request.ip, cuerpo.email, correcta && usuario !== undefined);

    // Si este fallo es el que dispara el bloqueo, avisar por correo. Va
    // sin await: el aviso no debe hacer esperar al usuario, y si el SMTP
    // esta caido lo peor que pasa es quedarse sin correo.
    if (!correcta && usuario !== undefined) {
      const trasElFallo = estadoDeBloqueo(app.db, request.ip);
      if (trasElFallo.bloqueada) {
        void avisarDeIntentos(app.db, usuario.id, {
          ip: request.ip,
          fallos: trasElFallo.fallosRecientes,
          minutosBloqueo: Math.ceil(trasElFallo.segundosRestantes / 60),
        });
      }
    }

    if (usuario === undefined || !correcta) {
      // Un solo mensaje para los dos casos: distinguir "no existe" de
      // "contrasena incorrecta" regala la mitad del trabajo a quien ataca.
      return reply
        .code(401)
        .send({ error: 'credenciales_invalidas', message: 'Email o contrasena incorrectos.' });
    }

    const requiereTotp = usuario.totp_secret_encrypted !== null;
    const token = crearSesion(app.db, usuario.id, request, !requiereTotp);

    reply.setCookie(NOMBRE_COOKIE, token, {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'strict',
      path: '/',
      maxAge: DURACION_SESION_MS / 1000,
    });

    registrarAuditoria(app.db, usuario.id, 'login', null, request.ip);

    return reply.send({
      // El cliente necesita esto para desenvolver la MK con la KEK que ya
      // tiene en memoria. Solo se entrega despues de verificar la authKey.
      wrappedMasterKey: usuario.wrapped_master_key,
      totpSecretEncrypted: usuario.totp_secret_encrypted,
      requiereTotp,
    });
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[NOMBRE_COOKIE];
    if (typeof token === 'string') {
      app.db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
    }

    reply.clearCookie(NOMBRE_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  /** Quien soy. Devuelve 401 si no hay sesion valida. */
  app.get('/api/auth/me', async (request, reply) => {
    const sesion = leerSesion(app.db, request);
    if (sesion === undefined) {
      return reply.code(401).send({ error: 'no_autenticado', message: 'Sesion no valida.' });
    }

    const usuario = app.db.prepare('SELECT email FROM users WHERE id = ?').get(sesion.userId) as
      { email: string } | undefined;

    return reply.send({
      email: usuario?.email ?? null,
      totpVerified: sesion.totpVerified,
    });
  });
}

function buscarUsuario(db: Db, email: string): FilaUsuario | undefined {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as
    FilaUsuario | undefined;
}

function crearSesion(
  db: Db,
  userId: string,
  request: FastifyRequest,
  totpVerified: boolean,
): string {
  const token = nuevoTokenDeSesion();

  db.prepare(
    `INSERT INTO sessions (id, user_id, totp_verified, expires_at, ip, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    token,
    userId,
    totpVerified ? 1 : 0,
    new Date(Date.now() + DURACION_SESION_MS).toISOString(),
    request.ip,
    request.headers['user-agent'] ?? null,
    new Date().toISOString(),
  );

  return token;
}

/**
 * Lee la sesion de la cookie. Devuelve undefined si no existe o caduco.
 *
 * Las sesiones caducadas se borran al encontrarlas: es una limpieza barata
 * que evita tener que programar una tarea aparte solo para eso.
 */
export function leerSesion(db: Db, request: FastifyRequest): SesionActiva | undefined {
  const token = request.cookies[NOMBRE_COOKIE];
  if (typeof token !== 'string') {
    return undefined;
  }

  const fila = db
    .prepare('SELECT user_id, totp_verified, expires_at FROM sessions WHERE id = ?')
    .get(token) as { user_id: string; totp_verified: number; expires_at: string } | undefined;

  if (fila === undefined) {
    return undefined;
  }

  if (new Date(fila.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
    return undefined;
  }

  return { userId: fila.user_id, totpVerified: fila.totp_verified === 1 };
}

/**
 * Exige sesion completa: autenticada Y con el segundo factor superado.
 *
 * Se usa como preHandler en todo lo que toque ficheros. Una sesion a medias
 * de 2FA no puede leer ni escribir nada (DRAPPS-1042).
 */
export function exigirSesion(db: Db) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const sesion = leerSesion(db, request);

    if (sesion === undefined) {
      await reply.code(401).send({ error: 'no_autenticado', message: 'Sesion no valida.' });
      return;
    }

    if (!sesion.totpVerified) {
      await reply
        .code(403)
        .send({ error: 'totp_pendiente', message: 'Falta completar el segundo factor.' });
      return;
    }

    request.sesion = sesion;
  };
}

function registrarIntento(db: Db, ip: string, email: string, exito: boolean): void {
  db.prepare('INSERT INTO login_attempts (ip, email, success, created_at) VALUES (?, ?, ?, ?)').run(
    ip,
    email.toLowerCase(),
    exito ? 1 : 0,
    new Date().toISOString(),
  );
}

export function registrarAuditoria(
  db: Db,
  userId: string,
  action: string,
  nodeId: string | null,
  ip: string,
  detail?: string,
): void {
  db.prepare(
    `INSERT INTO audit_log (user_id, action, node_id, ip, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(userId, action, nodeId, ip, detail ?? null, new Date().toISOString());
}
