import { CABECERAS_DE_SEGURIDAD, CONTENT_SECURITY_POLICY } from '@locker/shared';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    // Los sourcemaps mapearian el bundle a las fuentes de la logica
    // criptografica. No es un secreto (el codigo es publico para quien
    // reciba la pagina), pero no hay motivo para servirlos en produccion.
    sourcemap: false,
  },
  server: {
    /**
     * La politica de produccion, en modo AVISO y con dos huecos para Vite.
     *
     * POR QUE EN MODO AVISO: aplicarla de verdad aqui rompe el recargado en
     * caliente. El plugin de React inyecta un script en linea para Fast
     * Refresh y `script-src 'self'` lo prohibe, con lo que la app ni
     * arranca. `-Report-Only` no bloquea: solo escribe en la consola lo que
     * la politica real habria impedido.
     *
     * POR QUE LOS DOS HUECOS: sin ellos, cada recarga dejaria en la consola
     * las mismas dos violaciones del andamiaje de Vite -- el script en linea
     * y el WebSocket del recargado -- y uno se acostumbra a ignorarlas.
     * Entonces el aviso deja de servir, que es justo lo contrario de lo que
     * se busca. Con los huecos puestos, CUALQUIER violacion que aparezca es
     * de la aplicacion y merece mirarse.
     *
     * Ninguno de los dos llega a produccion: alli manda
     * CONTENT_SECURITY_POLICY tal cual, sin tocar.
     */
    headers: {
      'Content-Security-Policy-Report-Only': CONTENT_SECURITY_POLICY.replace(
        "script-src 'self' 'wasm-unsafe-eval'",
        "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'",
      ).replace("connect-src 'self'", "connect-src 'self' ws://localhost:5173"),
      ...CABECERAS_DE_SEGURIDAD,
    },
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
});
