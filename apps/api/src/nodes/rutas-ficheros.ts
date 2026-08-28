import type { Readable } from 'node:stream';

import type { FastifyInstance } from 'fastify';

import { exigirSesion, registrarAuditoria } from '../auth/rutas.js';
import { config } from '../config.js';
import { BlobDemasiadoGrande, borrarBlob, escribirBlob, leerBlob, nuevoBlobId } from './almacen.js';
import { crearFichero, buscarNodo, espacioUsado } from './repositorio.js';

/**
 * Subida y descarga de ficheros.
 *
 * Todo el cifrado ocurre en el navegador: el servidor recibe un stream que no
 * puede interpretar y lo escribe tal cual, y lo devuelve igual de opaco. En
 * ningun punto de este fichero hay una clave ni un byte en claro.
 */

/**
 * DECISION SOBRE LOS HUERFANOS (la issue pedia elegir y no dejarlo al azar).
 *
 * La propuesta original eran dos peticiones: subir el blob y luego crear el
 * nodo. Eso abre una ventana en la que un blob queda sin nodo que lo apunte,
 * ocupando disco para siempre, y obliga a inventar una confirmacion en dos
 * fases o una tarea de barrido.
 *
 * Aqui se hace en UNA SOLA peticion: el blob se escribe y el nodo se crea
 * dentro de la misma llamada, y si la creacion del nodo falla se borra el
 * blob recien escrito. La ventana desaparece en vez de gestionarse.
 *
 * Los metadatos viajan en cabeceras (todos son base64, caben de sobra) para
 * que el cuerpo sea el stream cifrado puro: sin multipart que parsear y sin
 * bufferear el fichero entero en memoria, que es lo que permite que
 * `proxy_request_buffering off` de nginx sirva de algo.
 *
 * Queda un caso residual: que el proceso muera a mitad de la escritura. Para
 * eso el blob se escribe primero como `.parcial` y solo se renombra al
 * terminar, asi que lo que queda es un temporal identificable y no un blob
 * incompleto con pinta de valido.
 */

const CABECERA_PADRE = 'x-locker-parent';
const CABECERA_NOMBRE = 'x-locker-name';
const CABECERA_DEK = 'x-locker-dek';

export function registrarRutasDeFicheros(app: FastifyInstance): void {
  const conSesion = { preHandler: exigirSesion(app.db) };

  // El cuerpo llega como bytes opacos: no hay nada que parsear, solo que
  // dejarlo pasar como stream.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    done(null, payload);
  });

  /** Sube un fichero ya cifrado y lo cuelga del arbol, todo en una llamada. */
  app.post('/api/files', conSesion, async (request, reply) => {
    const userId = request.sesion?.userId;
    if (userId === undefined) {
      return reply.code(401).send({ error: 'no_autenticado', message: 'Sesion no valida.' });
    }

    const nameEncrypted = request.headers[CABECERA_NOMBRE];
    const wrappedDek = request.headers[CABECERA_DEK];
    const padreCrudo = request.headers[CABECERA_PADRE];

    if (typeof nameEncrypted !== 'string' || typeof wrappedDek !== 'string') {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'Faltan las cabeceras con el nombre cifrado o la clave envuelta.',
      });
    }

    const parentId = typeof padreCrudo === 'string' && padreCrudo !== '' ? padreCrudo : null;

    // Se valida el destino ANTES de escribir un solo byte: no tiene sentido
    // aceptar 50 MB para descubrir despues que la carpeta no existe.
    if (parentId !== null) {
      const padre = buscarNodo(app.db, userId, parentId);
      if (padre === undefined) {
        return reply
          .code(404)
          .send({ error: 'padre_no_encontrado', message: 'La carpeta de destino no existe.' });
      }
      if (padre.kind !== 'folder') {
        return reply.code(400).send({
          error: 'padre_no_es_carpeta',
          message: 'No se pueden meter ficheros dentro de un fichero.',
        });
      }
    }

    const cuota = app.db
      .prepare('SELECT storage_quota_bytes FROM users WHERE id = ?')
      .get(userId) as { storage_quota_bytes: number } | undefined;

    if (cuota !== undefined && espacioUsado(app.db, userId) >= cuota.storage_quota_bytes) {
      return reply
        .code(507)
        .send({ error: 'sin_espacio', message: 'Has agotado el espacio de la boveda.' });
    }

    // Rechazo por Content-Length ANTES de leer un solo byte. Recibir 50 MB
    // para descartarlos al final es regalarle al atacante ancho de banda y
    // escrituras en disco; y si el cliente no manda la cabecera, el contador
    // del almacen sigue estando ahi como red de seguridad.
    const declarado = Number(request.headers['content-length'] ?? 0);
    if (declarado > config.maxFileSizeBytes) {
      return reply.code(413).send({
        error: 'fichero_demasiado_grande',
        message: `El fichero supera el limite de ${String(config.maxFileSizeBytes)} bytes.`,
      });
    }

    const blobId = nuevoBlobId();
    let bytes: number;

    try {
      bytes = await escribirBlob(
        config.blobsDir,
        blobId,
        request.body as Readable,
        config.maxFileSizeBytes,
      );
    } catch (error) {
      if (error instanceof BlobDemasiadoGrande) {
        return reply.code(413).send({
          error: 'fichero_demasiado_grande',
          message: `El fichero supera el limite de ${String(config.maxFileSizeBytes)} bytes.`,
        });
      }
      throw error;
    }

    try {
      const nodo = crearFichero(app.db, userId, {
        parentId,
        nameEncrypted,
        blobId,
        wrappedDek,
        sizeBytes: bytes,
      });

      registrarAuditoria(app.db, userId, 'subida', nodo.id, request.ip);

      return reply.code(201).send(nodo);
    } catch (error) {
      // Si el nodo no se puede crear, el blob recien escrito no le sirve a
      // nadie: se borra aqui mismo en vez de dejarlo para una limpieza
      // futura que quiza nunca llegue.
      await borrarBlob(config.blobsDir, blobId);
      throw error;
    }
  });

  /**
   * Devuelve el contenido cifrado de un fichero.
   *
   * El servidor solo comprueba que el nodo es de quien lo pide. Lo que manda
   * son bytes que no puede interpretar; descifrarlos es cosa del navegador.
   */
  app.get('/api/files/:id/contenido', conSesion, async (request, reply) => {
    const userId = request.sesion?.userId;
    if (userId === undefined) {
      return reply.code(401).send({ error: 'no_autenticado', message: 'Sesion no valida.' });
    }

    const { id } = request.params as { id: string };
    const nodo = buscarNodo(app.db, userId, id);

    if (nodo === undefined || nodo.kind !== 'file' || nodo.blobId === null) {
      return reply.code(404).send({ error: 'no_encontrado', message: 'El fichero no existe.' });
    }

    const stream = leerBlob(config.blobsDir, nodo.blobId);
    if (stream === null) {
      // El nodo existe pero su blob no esta en disco. Es un estado que no
      // deberia darse nunca, y merece log propio: significa que algo se
      // llevo el fichero por detras.
      request.log.error({ nodeId: id, blobId: nodo.blobId }, 'blob ausente en disco');
      return reply.code(410).send({
        error: 'blob_ausente',
        message: 'El contenido de este fichero no esta disponible.',
      });
    }

    registrarAuditoria(app.db, userId, 'descarga', id, request.ip);

    return (
      reply
        .header('Content-Type', 'application/octet-stream')
        // El nombre real va cifrado y lo pone el cliente al guardar: en esta
        // respuesta no aparece por ningun lado.
        .header('Content-Length', String(nodo.sizeBytes ?? 0))
        // Que ningun intermediario ni el propio navegador guarde una copia
        // del contenido, aunque este cifrado.
        .header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
        .header('X-Content-Type-Options', 'nosniff')
        .send(stream)
    );
  });
}
