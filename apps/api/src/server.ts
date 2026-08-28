import { buildApp } from './app.js';
import { config } from './config.js';

const app = await buildApp();

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

// Sin esto, `docker compose down` espera al timeout y mata el proceso a lo
// bruto, lo que con SQLite en WAL puede dejar el checkpoint a medias.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`Recibido ${signal}, cerrando.`);
    void app.close().then(() => process.exit(0));
  });
}
