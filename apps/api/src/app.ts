import { join } from 'node:path';

import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';

import { registrarCabecerasDeSeguridad } from './cabeceras.js';
import { registrarRutasDeAuth } from './auth/rutas.js';
import { registrarRutasDeCuenta } from './auth/rutas-cuenta.js';
import { registrarRutasDeRecuperacion } from './auth/rutas-recuperacion.js';
import { registrarRutasDeTotp } from './auth/rutas-totp.js';
import { config } from './config.js';
import { registrarRutasDeFicheros } from './nodes/rutas-ficheros.js';
import { registrarRutasDeNodos, registrarRutasDePapelera } from './nodes/rutas.js';
import { openDatabase, schemaVersion, type Db } from './db/index.js';
import { arrancarMantenimiento } from './mantenimiento.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
  }
}

export interface BuildAppOptions {
  /** Base de datos ya abierta. Los tests inyectan una en memoria. */
  db?: Db;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.isProduction
      ? { level: 'info' }
      : { level: 'debug', transport: { target: 'pino-pretty' } },
    trustProxy: config.trustProxy,
    bodyLimit: config.maxFileSizeBytes,
  });

  const db = options.db ?? openDatabase(join(config.dbDir, 'locker.db'));
  app.decorate('db', db);

  // Cerrar la base al parar es importante con WAL: deja el checkpoint hecho y
  // evita que el backup se encuentre un -wal enorme sin consolidar.
  const mantenimiento = arrancarMantenimiento(db, (mensaje, datos) => {
    app.log.info(datos ?? {}, mensaje);
  });

  app.addHook('onClose', () => {
    mantenimiento.detener();
    db.close();
  });

  await app.register(fastifyCookie);

  // Antes que cualquier ruta: asi las cabeceras salen tambien en los
  // errores y en los estaticos, que es donde es mas facil olvidarlas.
  registrarCabecerasDeSeguridad(app, config.isProduction);

  // Limite global, no solo del login. Un atacante que no puede forzar la
  // contrasena aun podria intentar tumbar el servicio a peticiones, y en
  // un VPS compartido con otros sitios eso los afecta a todos.
  await app.register(fastifyRateLimit, {
    max: 300,
    timeWindow: '1 minute',
    // Con trustProxy activo esto es la IP real del cliente, no la del
    // reverse proxy (DRAPPS-1035).
    keyGenerator: (request) => request.ip,
  });

  app.get('/api/health', async () => ({
    status: 'ok',
    // Sin datos del usuario ni del contenido: este endpoint es publico.
    uptimeSeconds: Math.floor(process.uptime()),
    schemaVersion: schemaVersion(db),
  }));

  registrarRutasDeAuth(app);
  registrarRutasDeTotp(app);
  registrarRutasDeRecuperacion(app);
  registrarRutasDeCuenta(app);
  registrarRutasDeNodos(app);
  registrarRutasDeFicheros(app);
  registrarRutasDePapelera(app);

  // En desarrollo los estaticos los sirve Vite; aqui solo en produccion.
  if (config.webDist !== null) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      // Sin listado de directorios: es exactamente el vector del CVE de
      // path traversal de @fastify/static, y ademas no queremos exponer
      // que ficheros compone la app.
      list: false,
      index: ['index.html'],
    });

    // SPA: cualquier ruta desconocida devuelve el index y el enrutado lo
    // resuelve React. Se excluye /api para que un endpoint inexistente
    // siga dando 404 en JSON en vez de HTML.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api')) {
        return reply.code(404).send({ error: 'not_found', message: 'Endpoint no encontrado' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
