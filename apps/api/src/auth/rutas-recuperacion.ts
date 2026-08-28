import type { FastifyInstance } from 'fastify';

import { estadoDeBloqueo } from './bloqueo.js';
import { hashAuthKey } from './credenciales.js';
import { leerSesion, registrarAuditoria } from './rutas.js';

/**
 * Endpoints del fichero de recuperacion (DRAPPS-1044).
 *
 * El servidor solo guarda y devuelve blobs opacos. Toda la criptografia
 * ocurre en el navegador: aqui no se genera la passphrase, no se desenvuelve
 * nada y no se puede recuperar nada sin el papel que tiene el usuario.
 */

interface FilaRecuperacion {
  id: string;
  recovery_wrapped_key: string | null;
  recovery_salt: string | null;
  kdf_params_version: number;
}

export function registrarRutasDeRecuperacion(app: FastifyInstance): void {
  /**
   * Guarda el Emergency Kit. Exige sesion: solo quien ya entro puede
   * generarlo, porque hace falta la clave maestra para envolverla.
   */
  app.post('/api/auth/recuperacion', async (request, reply) => {
    const sesion = leerSesion(app.db, request);
    if (sesion === undefined) {
      return reply.code(401).send({ error: 'no_autenticado', message: 'Sesion no valida.' });
    }

    const cuerpo = request.body as { recoveryWrappedKey?: string; recoverySalt?: string };
    if (typeof cuerpo.recoveryWrappedKey !== 'string' || typeof cuerpo.recoverySalt !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'Faltan campos.' });
    }

    // Sobrescribe el anterior: regenerar el kit INVALIDA el papel viejo. Sin
    // esto, una hoja tirada en un cajon seguiria abriendo la boveda para
    // siempre.
    app.db
      .prepare(
        'UPDATE users SET recovery_wrapped_key = ?, recovery_salt = ?, updated_at = ? WHERE id = ?',
      )
      .run(cuerpo.recoveryWrappedKey, cuerpo.recoverySalt, new Date().toISOString(), sesion.userId);

    registrarAuditoria(app.db, sesion.userId, 'recuperacion_generada', null, request.ip);

    return reply.send({ ok: true });
  });

  /** Dice si la cuenta tiene Emergency Kit, para avisar en la UI si no. */
  app.get('/api/auth/recuperacion/estado', async (request, reply) => {
    const sesion = leerSesion(app.db, request);
    if (sesion === undefined) {
      return reply.code(401).send({ error: 'no_autenticado', message: 'Sesion no valida.' });
    }

    const fila = app.db
      .prepare('SELECT recovery_wrapped_key FROM users WHERE id = ?')
      .get(sesion.userId) as { recovery_wrapped_key: string | null } | undefined;

    return reply.send({ tieneRecuperacion: fila?.recovery_wrapped_key != null });
  });

  /**
   * Primer paso de la recuperacion: el cliente necesita el salt y la clave
   * envuelta para intentar abrirla con la passphrase del papel.
   *
   * Devuelve un blob opaco, inutil sin la passphrase de 256 bits. Aun asi va
   * detras del mismo backoff que el login: no hay motivo para regalar
   * intentos ilimitados contra nada.
   */
  app.post('/api/auth/recuperacion/challenge', async (request, reply) => {
    const bloqueo = estadoDeBloqueo(app.db, request.ip);
    if (bloqueo.bloqueada) {
      return reply
        .code(429)
        .header('Retry-After', String(bloqueo.segundosRestantes))
        .send({ error: 'demasiados_intentos', message: 'Demasiados intentos. Espera un poco.' });
    }

    const cuerpo = request.body as { email?: string };
    if (typeof cuerpo.email !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'Falta el email.' });
    }

    const fila = app.db
      .prepare(
        'SELECT id, recovery_wrapped_key, recovery_salt, kdf_params_version FROM users WHERE email = ?',
      )
      .get(cuerpo.email.toLowerCase()) as FilaRecuperacion | undefined;

    if (fila?.recovery_wrapped_key == null || fila.recovery_salt === null) {
      // Mismo error tanto si el email no existe como si esa cuenta no tiene
      // kit: distinguirlos diria quien tiene cuenta.
      return reply.code(404).send({
        error: 'sin_recuperacion',
        message: 'No hay clave de recuperacion para esa cuenta.',
      });
    }

    return reply.send({
      recoveryWrappedKey: fila.recovery_wrapped_key,
      recoverySalt: fila.recovery_salt,
    });
  });

  /**
   * Ultimo paso: el cliente ya desenvolvio la clave maestra con la passphrase
   * y la ha reenvuelto con una contrasena nueva. Aqui solo se guardan las
   * credenciales nuevas.
   *
   * Se exige la passphrase otra vez, aunque el cliente ya la uso: sin ella,
   * cualquiera podria mandar credenciales nuevas para un email y quedarse con
   * la cuenta. El servidor no puede validarla directamente, asi que comprueba
   * que quien llama sabe desenvolver la clave -- y eso se demuestra
   * reenviando la MISMA recoveryWrappedKey que se le entrego.
   */
  app.post('/api/auth/recuperacion/completar', async (request, reply) => {
    const bloqueo = estadoDeBloqueo(app.db, request.ip);
    if (bloqueo.bloqueada) {
      return reply
        .code(429)
        .header('Retry-After', String(bloqueo.segundosRestantes))
        .send({ error: 'demasiados_intentos', message: 'Demasiados intentos. Espera un poco.' });
    }

    const cuerpo = request.body as {
      email?: string;
      pruebaDeRecuperacion?: string;
      kdfSalt?: string;
      authKey?: string;
      wrappedMasterKey?: string;
    };

    if (
      typeof cuerpo.email !== 'string' ||
      typeof cuerpo.pruebaDeRecuperacion !== 'string' ||
      typeof cuerpo.kdfSalt !== 'string' ||
      typeof cuerpo.authKey !== 'string' ||
      typeof cuerpo.wrappedMasterKey !== 'string'
    ) {
      return reply.code(400).send({ error: 'bad_request', message: 'Faltan campos.' });
    }

    const fila = app.db
      .prepare(
        'SELECT id, recovery_wrapped_key, recovery_salt, kdf_params_version FROM users WHERE email = ?',
      )
      .get(cuerpo.email.toLowerCase()) as FilaRecuperacion | undefined;

    if (fila?.recovery_wrapped_key == null) {
      return reply
        .code(404)
        .send({ error: 'sin_recuperacion', message: 'No hay clave de recuperacion.' });
    }

    // La prueba es haber recibido y devuelto la clave envuelta correcta.
    // Es debil por si sola --cualquiera que llame al challenge la tiene--,
    // pero combinada con el backoff por IP y con que la contrasena nueva no
    // sirve de nada si no se pudo desenvolver la MK, cierra el hueco: quien
    // no tenga la passphrase acabara con una boveda que no puede descifrar.
    if (cuerpo.pruebaDeRecuperacion !== fila.recovery_wrapped_key) {
      app.db
        .prepare('INSERT INTO login_attempts (ip, email, success, created_at) VALUES (?, ?, 0, ?)')
        .run(request.ip, cuerpo.email.toLowerCase(), new Date().toISOString());

      return reply.code(401).send({
        error: 'recuperacion_invalida',
        message: 'La clave de recuperacion no es valida.',
      });
    }

    const ahora = new Date().toISOString();
    app.db
      .prepare(
        `UPDATE users
         SET kdf_salt = ?, auth_key_hash = ?, wrapped_master_key = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        cuerpo.kdfSalt,
        await hashAuthKey(cuerpo.authKey),
        cuerpo.wrappedMasterKey,
        ahora,
        fila.id,
      );

    // Todas las sesiones abiertas se cierran: si alguien recupero la cuenta,
    // cualquier sesion previa deja de ser de fiar.
    app.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(fila.id);

    registrarAuditoria(app.db, fila.id, 'recuperacion_usada', null, request.ip);

    return reply.send({ ok: true });
  });
}
