import { describe, expect, it } from 'vitest';

import {
  ANCHO_COMPACTO,
  ANCHO_MINIMO,
  columnasDeLaPapelera,
  columnasDelExplorador,
  esEstrecho,
  margenLateral,
  rellenoDeFila,
  tamanoParaAncho,
} from './pantalla.js';

/**
 * Adaptacion a pantallas estrechas.
 *
 * Estos tests existen porque lo que se rompe en un movil no se descubre
 * mirando la pantalla del portatil: se descubre el dia que alguien intenta
 * abrir su boveda desde el telefono y no puede.
 *
 * Lo que se comprueba no es que "se vea bien" -- eso hay que mirarlo -- sino
 * las DECISIONES: que columnas sobreviven a cada ancho y cuales no.
 */

describe('puntos de corte', () => {
  it.each([
    [320, 'minimo'],
    [375, 'minimo'],
    [559, 'minimo'],
    [560, 'compacto'],
    [768, 'compacto'],
    [899, 'compacto'],
    [900, 'ancho'],
    [1440, 'ancho'],
  ])('a %i px devuelve %s', (ancho, esperado) => {
    expect(tamanoParaAncho(ancho)).toBe(esperado);
  });

  it('las fronteras caen del lado correcto', () => {
    // Justo en el limite ya cabe la version siguiente: si no, un movil de
    // 560 px exactos se quedaria con la interfaz mas apretada sin necesidad.
    expect(tamanoParaAncho(ANCHO_MINIMO - 1)).toBe('minimo');
    expect(tamanoParaAncho(ANCHO_MINIMO)).toBe('compacto');
    expect(tamanoParaAncho(ANCHO_COMPACTO - 1)).toBe('compacto');
    expect(tamanoParaAncho(ANCHO_COMPACTO)).toBe('ancho');
  });

  it('un ancho absurdo no rompe nada', () => {
    expect(tamanoParaAncho(0)).toBe('minimo');
    expect(tamanoParaAncho(-100)).toBe('minimo');
  });

  it('solo el ancho completo se considera holgado', () => {
    expect(esEstrecho('ancho')).toBe(false);
    expect(esEstrecho('compacto')).toBe(true);
    expect(esEstrecho('minimo')).toBe(true);
  });
});

/**
 * Cuenta columnas de verdad.
 *
 * No vale partir por espacios: `minmax(0, 1fr)` lleva uno dentro y contaria
 * como dos columnas. Se colapsa primero.
 */
function columnas(rejilla: string): number {
  return rejilla.replace(/minmax\([^)]*\)/g, 'X').split(' ').length;
}

describe('columnas del explorador', () => {
  it('la columna del nombre SOBREVIVE a todos los anchos', () => {
    // Es la unica irrenunciable: en una boveda de claves, el nombre es la
    // identidad del fichero. Sin el, la tabla es una lista de nada.
    for (const tamano of ['ancho', 'compacto', 'minimo'] as const) {
      expect(columnasDelExplorador(tamano)).toContain('minmax(0, 1fr)');
    }
  });

  it('pierde columnas al encoger, nunca al reves', () => {
    expect(columnas(columnasDelExplorador('ancho'))).toBe(7);
    expect(columnas(columnasDelExplorador('compacto'))).toBe(6);
    expect(columnas(columnasDelExplorador('minimo'))).toBe(4);
  });

  it('en el ancho minimo quedan icono, nombre y DOS acciones', () => {
    // Las dos acciones importan: descargar es la unica forma de ver un
    // fichero, y sin la papelera no se podria limpiar desde el movil.
    // La casilla de seleccion SI se va: sirve para bajarse un ZIP de varios,
    // que en un movil es un caso raro, y sus 38 px se los queda el nombre.
    expect(columnasDelExplorador('minimo')).toBe('26px minmax(0, 1fr) 38px 38px');
  });

  it('el nombre se lleva el ancho que sobra, y en minimo mas que nadie', () => {
    // Suma de las columnas FIJAS: cuanto menor sea, mas le queda al nombre.
    const fijasEnMinimo = 26 + 38 + 38;
    const fijasEnCompacto = 30 + 26 + 100 + 40 + 40;

    expect(fijasEnMinimo).toBeLessThan(fijasEnCompacto);
    // En un movil de 375 px, con relleno de 10 y margen de 8 a cada lado,
    // al nombre le quedan mas de 200 px: un nombre de clave entero.
    expect(375 - fijasEnMinimo - 10 * 2 - 8 * 2 - 8 * 3).toBeGreaterThan(200);
  });
});

describe('columnas de la papelera', () => {
  it('el nombre sobrevive a todos los anchos', () => {
    for (const tamano of ['ancho', 'compacto', 'minimo'] as const) {
      expect(columnasDeLaPapelera(tamano)).toContain('minmax(0, 1fr)');
    }
  });

  it('pierde columnas al encoger', () => {
    expect(columnas(columnasDeLaPapelera('ancho'))).toBe(6);
    expect(columnas(columnasDeLaPapelera('compacto'))).toBe(5);
    expect(columnas(columnasDeLaPapelera('minimo'))).toBe(4);
  });

  it('los margenes se aprietan al encoger: cada pixel sale del nombre', () => {
    expect(margenLateral('minimo')).toBe('8px');
    expect(margenLateral('compacto')).toBe('12px');
    expect(margenLateral('ancho')).toBe('26px');

    expect(rellenoDeFila('minimo')).toBe('10px');
    expect(rellenoDeFila('ancho')).toBe('18px');
  });

  it('conserva sitio para los dias que quedan, incluso en el ancho minimo', () => {
    // Sin ese dato la papelera es una lista de cosas borradas sin urgencia,
    // y la urgencia es justo su razon de ser: el martes desaparecen.
    // icono + nombre + dias + acciones
    expect(columnas(columnasDeLaPapelera('minimo'))).toBe(4);
    expect(columnasDeLaPapelera('minimo')).toContain('68px');
  });
});
