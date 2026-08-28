import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  /*
    Los paquetes internos se resuelven a su CODIGO FUENTE, no a `dist/`.

    Sin esto, `npm test` recien clonado el repositorio falla entero: los
    `exports` de @locker/crypto y @locker/shared apuntan a `dist/`, que no
    existe hasta compilar, y quince ficheros de test se caen al importar
    antes de ejecutar una sola comprobacion. Eso convierte "clonar y probar"
    --lo primero que hace cualquiera-- en una pantalla de errores rojos.

    Ademas se prueba lo que se lee: si algun dia el compilado y el fuente
    dejaran de coincidir, el test lo dice.
  */
  resolve: {
    alias: {
      '@locker/crypto': fileURLToPath(new URL('./packages/crypto/src/index.ts', import.meta.url)),
      '@locker/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // El paquete de cripto es el unico donde un fallo significa perdida de
      // datos irreversible: se le exige mucho mas que al resto (DRAPPS-1036).
      thresholds: {
        'packages/crypto/src/**': {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
      },
    },
  },
});
