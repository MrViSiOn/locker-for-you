import type { FastifyInstance } from 'fastify';

import type { Db } from '../db/index.js';
import { hashAuthKey, verifyAuthKey } from './credenciales.js';
import { leerSesion, registrarAuditoria } from './rutas.js';

/**
 * Ajustes de la cuenta: estado, cambio de contrasena y registro de accesos.
 *
 * Todo lo criptografico ocurre en el navegador y llega aqui ya resuelto. El
 * servidor solo guarda lo que le den y comprueba que quien lo pide es quien
 * dice ser.
 */

interface FilaDeCuenta {
  email: string;
  created_at: string;
  totp_enabled_at: string | null;
  recovery_wrapped_key: string | null;
  auth_key_hash: string;
  kdf_salt: string;
}

export function registrarRutasDeCuenta(app: FastifyInstance): void {
  /**
   * Lo que la pantalla de ajustes necesita saber de la cuenta.
   *
   * Aqui NO sale nada que sirva para atacar la boveda: ni el hash de la
   * authKey, ni el secreto TOTP, ni la clave envuelta. Solo fechas y
   * banderas de "esto esta configurado".
   */
  app.get('/api/auth/cuenta', async (request, reply) => {
    const sesion = leerSesion(app.db, request);
    if (sesion === undefined) {
      return reply.code(401).send({ error: 'no_autenticado', message: 'Sesion no valida.' });
    }

    const fila = app.db
      .prepare(
        `SELECT email, created_at, totp_enabled_at, recovery_wrapped_key
         FROM users WHERE id = ?`,
      )
      .get(sesion.userId) as FilaDeCuenta | undefined;

    if (fila === undefined) {
      return reply.code(401).send({ error: 'no_autenticado', message: 'Sesion no valida.' });
    }

    return reply.send({
      email: fila.email,
      creadaEl: fila.created_at,
      totpActivoDesde: fila.totp_enabled_at,
      tieneRecuperacion: fila.recovery_wrapped_key !== null,
    });
  });

  /**
   * Cambia la contrasena maestra.
   *
   * El navegador ya ha hecho el trabajo: derivo una KEK nueva, reenvolvio la
   * MISMA clave maestra con ella y manda el resultado. Aqui solo se sustituye
   * el material de derivacion.
   *
   * LOS FICHEROS NO SE TOCAN, y ese es justo el motivo de que la clave
   * maestra sea aleatoria en vez de derivada de la contrasena: cambiarla
   * reenvuelve 40 bytes en lugar de obligar a descargar, descifrar, recifrar
   * y volver a subir la boveda entera.
   *
   * Se exige la authKey ACTUAL. Sin eso, a quien encontrara una sesion
   * abierta le bastaria con cambiar la contrasena para quedarse la boveda...
   * salvo que no: sin la contrasena vieja no podria haber reenvuelto la MK,
   * asi que el cambio no colaria. Aun asi se comprueba, porque una barrera
   * que depende de un detalle criptografico ajeno es una barrera fragil.
   */
  app.post('/api/auth/password', async (request, reply) => {
    const sesion = leerSesion(app.db, request);
    if (sesion === undefined) {
      return reply.code(401).send({ error: 'no_autenticado', message: 'Sesion no valida.' });
    }

    const cuerpo = request.body as {
      authKeyActual?: string;
      kdfSalt?: string;
      kdfParamsVersion?: number;
      authKey?: string;
      wrappedMasterKey?: string;
    };

    if (
      typeof cuerpo.authKeyActual !== 'string' ||
      typeof cuerpo.kdfSalt !== 'string' ||
      typeof cuerpo.authKey !== 'string' ||
      typeof cuerpo.wrappedMasterKey !== 'string'
    ) {
      return reply.code(400).send({ error: 'bad_request', message: 'Faltan campos obligatorios.' });
    }

    const fila = app.db
      .prepare('SELECT email, auth_key_hash, kdf_salt, created_at FROM users WHERE id = ?')
      .get(sesion.userId) as FilaDeCuenta | undefined;

    if (fila === undefined) {
      return reply.code(401).send({ error: 'no_autenticado', message: 'Sesion no valida.' });
    }

    if (!(await verifyAuthKey(cuerpo.authKeyActual, fila.auth_key_hash))) {
      registrarAuditoria(
        app.db,
        sesion.userId,
        'password_fallida',
        null,
        request.ip,
        'contrasena actual incorrecta',
      );
      return reply
        .code(401)
        .send({ error: 'credenciales', message: 'La contrasena actual no es correcta.' });
    }

    app.db
      .prepare(
        `UPDATE users
         SET kdf_salt = ?, kdf_params_version = ?, auth_key_hash = ?,
             wrapped_master_key = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        cuerpo.kdfSalt,
        cuerpo.kdfParamsVersion ?? 1,
        await hashAuthKey(cuerpo.authKey),
        cuerpo.wrappedMasterKey,
        new Date().toISOString(),
        sesion.userId,
      );

    // TODAS las sesiones se caen, la de quien hace el cambio incluida.
    //
    // Es lo que se espera de cambiar una contrasena: si se cambia porque se
    // sospecha que alguien mas entro, dejar viva cualquier sesion anterior
    // vaciaria el gesto. Que el propio usuario tenga que volver a entrar es
    // un precio pequeno, y ademas comprueba de inmediato que la contrasena
    // nueva funciona.
    app.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(sesion.userId);

    registrarAuditoria(app.db, sesion.userId, 'password_cambiada', null, request.ip);

    return reply.send({ ok: true });
  });

  /**
   * Registro de auditoria.
   *
   * Anota CUANDO y DESDE DONDE, nunca que habia dentro de un fichero: eso el
   * servidor no lo sabe y no podria anotarlo aunque quisiera.
   */
  app.get('/api/auditoria', async (request, reply) => {
    const sesion = leerSesion(app.db, request);
    if (sesion === undefined) {
      return reply.code(401).send({ error: 'no_autenticado', message: 'Sesion no valida.' });
    }

    const limite = Math.min(
      200,
      Math.max(1, Number((request.query as { limite?: string }).limite ?? 40)),
    );

    const filas = app.db
      .prepare(
        `SELECT action, node_id, ip, detail, created_at
         FROM audit_log WHERE user_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(sesion.userId, limite) as {
      action: string;
      node_id: string | null;
      ip: string | null;
      detail: string | null;
      created_at: string;
    }[];

    return reply.send({
      entradas: filas.map((f) => ({
        accion: f.action,
        nodeId: f.node_id,
        ip: f.ip,
        detalle: f.detail,
        fecha: f.created_at,
      })),
    });
  });
}

export type { Db };
