import type { FastifyInstance, FastifyRequest } from 'fastify';

import { exigirSesion, registrarAuditoria } from '../auth/rutas.js';
import { config } from '../config.js';
import {
  borrarDefinitivamente,
  listarPapelera,
  mandarAPapelera,
  restaurar,
  vaciarPapelera,
} from './papelera.js';
import {
  buscarNodo,
  crearCarpeta,
  espacioUsado,
  listarHijos,
  mover,
  NodoError,
  renombrar,
  subarbol,
} from './repositorio.js';

/**
 * Endpoints del arbol de ficheros.
 *
 * Todos exigen sesion COMPLETA: autenticada y con el segundo factor
 * superado. Una sesion a medias de 2FA no puede leer ni escribir nada.
 */

/** El userId sale siempre de la sesion, jamas del cuerpo de la peticion. */
function userIdDe(request: FastifyRequest): string {
  const sesion = request.sesion;
  if (sesion === undefined) {
    // No deberia ocurrir: el preHandler ya lo garantiza. Si ocurriera,
    // fallar es infinitamente mejor que seguir sin saber de quien es la
    // peticion.
    throw new NodoError('Sesion no valida.', 'no_autenticado', 401);
  }
  return sesion.userId;
}

export function registrarRutasDeNodos(app: FastifyInstance): void {
  const conSesion = { preHandler: exigirSesion(app.db) };

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof NodoError) {
      return reply.code(error.estado).send({ error: error.codigo, message: error.message });
    }

    request.log.error(error);
    // Nunca se devuelve el mensaje interno: podria filtrar rutas del
    // servidor o detalles del esquema.
    return reply.code(500).send({ error: 'error_interno', message: 'Algo ha ido mal.' });
  });

  /** Lista el contenido de una carpeta. Los nombres van cifrados. */
  app.get('/api/nodes', conSesion, async (request, reply) => {
    const query = request.query as { parent?: string };
    const parentId = query.parent === undefined || query.parent === '' ? null : query.parent;

    return reply.send({ nodes: listarHijos(app.db, userIdDe(request), parentId) });
  });

  app.get('/api/nodes/:id', conSesion, async (request, reply) => {
    const { id } = request.params as { id: string };

    const nodo = buscarNodo(app.db, userIdDe(request), id);
    if (nodo === undefined) {
      return reply.code(404).send({ error: 'no_encontrado', message: 'El nodo no existe.' });
    }

    return reply.send(nodo);
  });

  /** Subarbol completo. Lo usa el ZIP en bulk, que se genera en el cliente. */
  app.get('/api/nodes/:id/tree', conSesion, async (request, reply) => {
    const { id } = request.params as { id: string };

    return reply.send({ nodes: subarbol(app.db, userIdDe(request), id) });
  });

  app.post('/api/nodes/folder', conSesion, async (request, reply) => {
    const cuerpo = request.body as { parentId?: string | null; nameEncrypted?: string };

    if (typeof cuerpo.nameEncrypted !== 'string' || cuerpo.nameEncrypted === '') {
      return reply.code(400).send({ error: 'bad_request', message: 'Falta el nombre cifrado.' });
    }

    const carpeta = crearCarpeta(
      app.db,
      userIdDe(request),
      cuerpo.parentId ?? null,
      cuerpo.nameEncrypted,
    );

    return reply.code(201).send(carpeta);
  });

  /** Renombra o mueve. Se admiten los dos en la misma peticion. */
  app.patch('/api/nodes/:id', conSesion, async (request, reply) => {
    const { id } = request.params as { id: string };
    const cuerpo = request.body as { nameEncrypted?: string; parentId?: string | null };
    const userId = userIdDe(request);

    let nodo = buscarNodo(app.db, userId, id);
    if (nodo === undefined) {
      return reply.code(404).send({ error: 'no_encontrado', message: 'El nodo no existe.' });
    }

    if (typeof cuerpo.nameEncrypted === 'string' && cuerpo.nameEncrypted !== '') {
      nodo = renombrar(app.db, userId, id, cuerpo.nameEncrypted);
    }

    // `parentId` en el cuerpo, aunque sea null, significa mover a la raiz.
    // Que la clave no venga significa no tocar el padre: son cosas distintas.
    if ('parentId' in cuerpo) {
      nodo = mover(app.db, userId, id, cuerpo.parentId ?? null);
    }

    return reply.send(nodo);
  });

  /** Espacio ocupado, papelera incluida. */
  app.get('/api/almacenamiento', conSesion, async (request, reply) => {
    const userId = userIdDe(request);

    const cuota = app.db
      .prepare('SELECT storage_quota_bytes FROM users WHERE id = ?')
      .get(userId) as { storage_quota_bytes: number } | undefined;

    return reply.send({
      usadoBytes: espacioUsado(app.db, userId),
      cuotaBytes: cuota?.storage_quota_bytes ?? 0,
    });
  });
}

/**
 * Endpoints de la papelera (DRAPPS-1048).
 *
 * Borrar es un soft delete de 30 dias. En una boveda de claves privadas un
 * borrado accidental es irreversible y doloroso, y el coste de una papelera
 * es ridiculo comparado con perder una clave que no se puede regenerar.
 */
export function registrarRutasDePapelera(app: FastifyInstance): void {
  const conSesion = { preHandler: exigirSesion(app.db) };

  /** Manda a la papelera. NO borra: eso es /api/papelera/:id. */
  app.delete('/api/nodes/:id', conSesion, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = userIdDe(request);

    const afectados = mandarAPapelera(app.db, userId, id);
    registrarAuditoria(app.db, userId, 'papelera', id, request.ip, `${String(afectados)} nodos`);

    return reply.send({ aPapelera: afectados });
  });

  app.get('/api/papelera', conSesion, async (request, reply) => {
    return reply.send({ nodes: listarPapelera(app.db, userIdDe(request)) });
  });

  app.post('/api/papelera/:id/restaurar', conSesion, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = userIdDe(request);

    const nodo = restaurar(app.db, userId, id);
    registrarAuditoria(app.db, userId, 'restaurar', id, request.ip);

    return reply.send(nodo);
  });

  /** Borrado definitivo de un elemento concreto de la papelera. */
  app.delete('/api/papelera/:id', conSesion, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = userIdDe(request);

    const resultado = await borrarDefinitivamente(app.db, config.blobsDir, userId, id);
    registrarAuditoria(
      app.db,
      userId,
      'borrado_definitivo',
      id,
      request.ip,
      `${String(resultado.nodos)} nodos, ${String(resultado.blobs)} blobs`,
    );

    return reply.send(resultado);
  });

  app.delete('/api/papelera', conSesion, async (request, reply) => {
    const userId = userIdDe(request);

    const resultado = await vaciarPapelera(app.db, config.blobsDir, userId);
    registrarAuditoria(
      app.db,
      userId,
      'vaciar_papelera',
      null,
      request.ip,
      `${String(resultado.nodos)} nodos, ${String(resultado.blobs)} blobs`,
    );

    return reply.send(resultado);
  });
}
