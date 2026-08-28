import { CABECERAS_DE_SEGURIDAD, CONTENT_SECURITY_POLICY } from '@locker/shared';
import type { FastifyInstance } from 'fastify';

/**
 * Cabeceras de seguridad.
 *
 * La politica vive en `@locker/shared` para que el servidor de desarrollo la
 * aplique tambien: si solo existiera aqui, los fallos que provoca aparecerian
 * el dia del despliegue y no antes.
 *
 * Se escriben a mano en vez de con helmet: se leen de un vistazo y no hay que
 * auditar una dependencia mas para saber que sale sirviendo el servidor.
 */

export function registrarCabecerasDeSeguridad(app: FastifyInstance, enProduccion: boolean): void {
  app.addHook('onSend', async (_peticion, respuesta) => {
    respuesta.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);

    for (const [nombre, valor] of Object.entries(CABECERAS_DE_SEGURIDAD)) {
      respuesta.header(nombre, valor);
    }

    // Solo en produccion: en local no hay TLS y HSTS dejaria el navegador
    // insistiendo en https://localhost durante dos anos.
    if (enProduccion) {
      respuesta.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    }
  });

  /**
   * Nada de esto debe acabar en un buscador.
   *
   * La meta etiqueta ya lo dice, pero un robots.txt lo dice ANTES de que
   * nadie pida la pagina, y algunos rastreadores solo miran eso.
   */
  app.get('/robots.txt', async (_peticion, respuesta) => {
    respuesta.type('text/plain');
    return 'User-agent: *\nDisallow: /\n';
  });
}
