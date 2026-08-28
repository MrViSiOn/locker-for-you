import type { FastifyInstance } from 'fastify';

import { config } from '../config.js';
import { verifyAuthKey } from './credenciales.js';
import { leerSesion, registrarAuditoria } from './rutas.js';
import {
  cifrarSecreto,
  descifrarSecreto,
  generarSecretoTotp,
  uriOtpauth,
  verificarTotp,
} from './totp.js';

/**
 * Endpoints del segundo factor.
 *
 * El alta ocurre con una sesion ya autenticada por contrasena; la
 * verificacion, con una sesion pendiente de segundo factor.
 */

interface FilaTotp {
  id: string;
  email: string;
  totp_secret_encrypted: string | null;
  totp_pending_secret_encrypted: string | null;
  totp_enabled_at: string | null;
  totp_last_counter: number | null;
  auth_key_hash: string;
}

export function registrarRutasDeTotp(app: FastifyInstance): void {
  /**
   * Paso 1 del alta: genera un secreto y devuelve el QR.
   *
   * El secreto se guarda ya, pero SIN marcar el 2FA como activo: hasta que
   * no se confirme con un codigo real, el usuario podria haber cerrado la
   * pagina sin escanear nada, y activarlo lo dejaria fuera de su boveda.
   */
  app.post('/api/auth/totp/iniciar', async (request, reply) => {
    const sesion = leerSesion(app.db, request);
    if (sesion === undefined) {
      return reply.code(401).send({ error: 'no_autenticado', message: 'Sesion no valida.' });
    }

    const usuario = app.db
      .prepare('SELECT id, email, totp_enabled_at FROM users WHERE id = ?')
      .get(sesion.userId) as FilaTotp | undefined;

    if (usuario === undefined) {
      return reply.code(401).send({ error: 'no_autenticado', message: 'Sesion no valida.' });
    }

    if (usuario.totp_enabled_at !== null) {
      return reply
        .code(409)
        .send({ error: 'totp_ya_activo', message: 'El segundo factor ya esta configurado.' });
    }

    const secreto = generarSecretoTotp();

    app.db
      .prepare('UPDATE users SET totp_secret_encrypted = ?, updated_at = ? WHERE id = ?')
      .run(cifrarSecreto(secreto, config.totpKey), new Date().toISOString(), usuario.id);

    return reply.send({
      secreto,
      uri: uriOtpauth(secreto, usuario.email),
    });
  });

  /**
   * Paso 2 del alta: confirmar con un codigo de la app autenticadora.
   *
   * Solo aqui se marca el 2FA como activo. Exigir el codigo demuestra que el
   * QR se escaneo de verdad y que el reloj del movil concuerda: activarlo sin
   * comprobarlo dejaria al usuario fuera de su propia boveda en el siguiente
   * inicio de sesion.
   */
  app.post('/api/auth/totp/confirmar', async (request, reply) => {
    const sesion = leerSesion(app.db, request);
    if (sesion === undefined) {
      return reply.code(401).send({ error: 'no_autenticado', message: 'Sesion no valida.' });
    }

    const cuerpo = request.body as { codigo?: string };
    if (typeof cuerpo.codigo !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'Falta el codigo.' });
    }

    const usuario = app.db
      .prepare(
        'SELECT id, totp_secret_encrypted, totp_enabled_at, totp_last_counter FROM users WHERE id = ?',
      )
      .get(sesion.userId) as FilaTotp | undefined;

    if (usuario?.totp_secret_encrypted == null) {
      return reply
        .code(400)
        .send({ error: 'totp_no_iniciado', message: 'Primero hay que generar el secreto.' });
    }

    const resultado = verificarTotp(
      descifrarSecreto(usuario.totp_secret_encrypted, config.totpKey),
      cuerpo.codigo,
      usuario.totp_last_counter,
    );

    if (!resultado.valido) {
      return reply.code(401).send({ error: 'codigo_invalido', message: 'El codigo no es valido.' });
    }

    const ahora = new Date().toISOString();
    app.db
      .prepare(
        'UPDATE users SET totp_enabled_at = ?, totp_last_counter = ?, updated_at = ? WHERE id = ?',
      )
      .run(ahora, resultado.contador, ahora, usuario.id);

    // La sesion en curso pasa a completa: quien acaba de configurar el
    // segundo factor no tiene por que volver a entrar.
    app.db.prepare('UPDATE sessions SET totp_verified = 1 WHERE user_id = ?').run(usuario.id);

    registrarAuditoria(app.db, usuario.id, 'totp_activado', null, request.ip);

    return reply.send({ ok: true });
  });

  /**
   * Verificacion en el login: promociona una sesion pendiente a completa.
   */
  app.post('/api/auth/totp/verificar', async (request, reply) => {
    const sesion = leerSesion(app.db, request);
    if (sesion === undefined) {
      return reply.code(401).send({ error: 'no_autenticado', message: 'Sesion no valida.' });
    }

    const cuerpo = request.body as { codigo?: string };
    if (typeof cuerpo.codigo !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'Falta el codigo.' });
    }

    const usuario = app.db
      .prepare('SELECT id, totp_secret_encrypted, totp_last_counter FROM users WHERE id = ?')
      .get(sesion.userId) as FilaTotp | undefined;

    if (usuario?.totp_secret_encrypted == null) {
      return reply
        .code(400)
        .send({ error: 'totp_no_configurado', message: 'Esta cuenta no tiene segundo factor.' });
    }

    const resultado = verificarTotp(
      descifrarSecreto(usuario.totp_secret_encrypted, config.totpKey),
      cuerpo.codigo,
      usuario.totp_last_counter,
    );

    if (!resultado.valido) {
      // Cuenta como intento fallido, para que el backoff por IP tambien
      // cubra la fuerza bruta contra los seis digitos del codigo.
      app.db
        .prepare('INSERT INTO login_attempts (ip, email, success, created_at) VALUES (?, ?, 0, ?)')
        .run(request.ip, null, new Date().toISOString());

      return reply.code(401).send({ error: 'codigo_invalido', message: 'El codigo no es valido.' });
    }

    // Guardar el contador usado impide reutilizar ese mismo codigo durante
    // los segundos que le quedan de vida.
    app.db
      .prepare('UPDATE users SET totp_last_counter = ? WHERE id = ?')
      .run(resultado.contador, usuario.id);

    const token = request.cookies['locker_session'];
    if (typeof token === 'string') {
      app.db.prepare('UPDATE sessions SET totp_verified = 1 WHERE id = ?').run(token);
    }

    registrarAuditoria(app.db, usuario.id, 'totp_verificado', null, request.ip);

    return reply.send({ ok: true });
  });

  /**
   * Cambiar de aplicacion autenticadora.
   *
   * Caso real: cambias de movil, o desinstalas la app sin querer. Hasta
   * ahora la unica salida era el Emergency Kit, que es matar moscas a
   * canonazos.
   *
   * SE EXIGE LA CONTRASENA MAESTRA, NO UN CODIGO DEL AUTENTICADOR ACTUAL, y
   * la diferencia importa: si se pidiera el codigo, quien hubiera perdido el
   * movil -- que es justo quien necesita esto -- no podria usarlo. La
   * contrasena demuestra identidad igual de bien y sigue estando disponible.
   *
   * Tambien protege de una sesion robada: tener la cookie no basta para
   * apoderarse del segundo factor.
   *
   * EL SECRETO NUEVO NO SUSTITUYE AL VIEJO TODAVIA: se guarda aparte, y la
   * aplicacion antigua sigue siendo la valida hasta que se confirme un
   * codigo de la nueva.
   */
  app.post('/api/auth/totp/cambiar', async (request, reply) => {
    const sesion = leerSesion(app.db, request);
    if (sesion === undefined) {
      return reply.code(401).send({ error: 'no_autenticado', message: 'Sesion no valida.' });
    }

    const cuerpo = request.body as { authKeyActual?: string };
    if (typeof cuerpo.authKeyActual !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'Falta la contrasena.' });
    }

    const usuario = app.db
      .prepare('SELECT id, email, auth_key_hash, totp_enabled_at FROM users WHERE id = ?')
      .get(sesion.userId) as FilaTotp | undefined;

    if (usuario === undefined) {
      return reply.code(401).send({ error: 'no_autenticado', message: 'Sesion no valida.' });
    }

    if (!(await verifyAuthKey(cuerpo.authKeyActual, usuario.auth_key_hash))) {
      registrarAuditoria(app.db, usuario.id, 'totp_cambio_fallido', null, request.ip);
      return reply
        .code(401)
        .send({ error: 'credenciales', message: 'La contrasena no es correcta.' });
    }

    const secreto = generarSecretoTotp();

    app.db
      .prepare('UPDATE users SET totp_pending_secret_encrypted = ?, updated_at = ? WHERE id = ?')
      .run(cifrarSecreto(secreto, config.totpKey), new Date().toISOString(), usuario.id);

    return reply.send({ secreto, uri: uriOtpauth(secreto, usuario.email) });
  });

  /**
   * Confirmar el cambio con un codigo de la aplicacion NUEVA.
   *
   * Solo aqui deja de valer la aplicacion vieja. Exigir el codigo antes de
   * sustituir nada es lo que garantiza que el cambio no puede dejar a nadie
   * fuera: si el codigo no llega, todo sigue como estaba.
   */
  app.post('/api/auth/totp/confirmar-cambio', async (request, reply) => {
    const sesion = leerSesion(app.db, request);
    if (sesion === undefined) {
      return reply.code(401).send({ error: 'no_autenticado', message: 'Sesion no valida.' });
    }

    const cuerpo = request.body as { codigo?: string };
    if (typeof cuerpo.codigo !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'Falta el codigo.' });
    }

    const usuario = app.db
      .prepare(
        'SELECT id, totp_pending_secret_encrypted, totp_last_counter FROM users WHERE id = ?',
      )
      .get(sesion.userId) as FilaTotp | undefined;

    if (usuario?.totp_pending_secret_encrypted == null) {
      return reply
        .code(409)
        .send({ error: 'sin_cambio_pendiente', message: 'No hay ningun cambio en curso.' });
    }

    const resultado = verificarTotp(
      descifrarSecreto(usuario.totp_pending_secret_encrypted, config.totpKey),
      cuerpo.codigo,
      // El contador viejo no vale aqui: es de otro secreto. Empezar sin
      // contador no abre ningun hueco, porque este codigo pertenece a una
      // aplicacion que el usuario acaba de configurar delante.
      null,
    );

    if (!resultado.valido) {
      app.db
        .prepare('INSERT INTO login_attempts (ip, email, success, created_at) VALUES (?, ?, 0, ?)')
        .run(request.ip, null, new Date().toISOString());

      return reply.code(401).send({ error: 'codigo_invalido', message: 'El codigo no es valido.' });
    }

    // AQUI, y solo aqui, el secreto nuevo sustituye al viejo.
    app.db
      .prepare(
        `UPDATE users
         SET totp_secret_encrypted = totp_pending_secret_encrypted,
             totp_pending_secret_encrypted = NULL,
             totp_last_counter = ?,
             totp_enabled_at = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(resultado.contador, new Date().toISOString(), new Date().toISOString(), usuario.id);

    registrarAuditoria(app.db, usuario.id, 'totp_cambiado', null, request.ip);

    return reply.send({ ok: true });
  });
}
