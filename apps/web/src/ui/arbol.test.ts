import { describe, expect, it } from 'vitest';

import {
  abrirCamino,
  alternar,
  aRefrescar,
  caminoHacia,
  carpetaActual,
  estaEnElCamino,
  RAIZ,
  type Migaja,
} from './arbol.js';

/**
 * El árbol de carpetas de la barra lateral.
 *
 * Lo que se prueba aquí no es cómo se ve, sino las tres cosas que lo pueden
 * romper de verdad: que plegar y desplegar sea reversible, que abrir el
 * camino no genere conjuntos nuevos sin motivo (un efecto de React que
 * depende de eso entraría en bucle) y que el refresco toque solo el camino
 * abierto y no la bóveda entera.
 */

const claves: Migaja = { id: 'claves', nombre: 'Claves' };
const ssh: Migaja = { id: 'ssh', nombre: 'ssh' };

describe('alternar', () => {
  it('despliega lo que estaba plegado', () => {
    expect([...alternar(new Set(), 'claves')]).toEqual(['claves']);
  });

  it('pliega lo que estaba desplegado', () => {
    expect([...alternar(new Set(['claves']), 'claves')]).toEqual([]);
  });

  it('no toca las demás ramas', () => {
    expect([...alternar(new Set(['claves']), 'ssh')].sort()).toEqual(['claves', 'ssh']);
  });

  it('no modifica el conjunto que recibe', () => {
    const antes = new Set(['claves']);
    alternar(antes, 'ssh');
    expect([...antes]).toEqual(['claves']);
  });
});

describe('abrirCamino', () => {
  it('despliega todas las carpetas del camino', () => {
    const abierto = abrirCamino(new Set(), [RAIZ, claves, ssh]);
    expect([...abierto].sort()).toEqual(['claves', 'ssh']);
  });

  it('ignora la raíz, que no es una carpeta desplegable', () => {
    expect([...abrirCamino(new Set(), [RAIZ])]).toEqual([]);
  });

  it('conserva lo que ya estaba abierto', () => {
    const abierto = abrirCamino(new Set(['otra']), [RAIZ, claves]);
    expect([...abierto].sort()).toEqual(['claves', 'otra']);
  });

  it('DEVUELVE EL MISMO CONJUNTO si no hay nada que abrir', () => {
    // Es la garantía que impide el bucle infinito de repintado: el resultado
    // se guarda en el estado desde un efecto que depende de él.
    const antes = new Set(['claves']);
    expect(abrirCamino(antes, [RAIZ, claves])).toBe(antes);
  });
});

describe('la carpeta actual', () => {
  it('es el último escalón del camino', () => {
    expect(carpetaActual([RAIZ, claves, ssh])).toBe('ssh');
  });

  it('es la raíz cuando no se ha entrado en ninguna carpeta', () => {
    expect(carpetaActual([RAIZ])).toBeNull();
  });

  it('marca como en el camino a los padres, no a las hermanas', () => {
    expect(estaEnElCamino([RAIZ, claves, ssh], 'claves')).toBe(true);
    expect(estaEnElCamino([RAIZ, claves, ssh], 'otra')).toBe(false);
    expect(estaEnElCamino([RAIZ, claves], null)).toBe(true);
  });
});

describe('caminoHacia', () => {
  it('añade la carpeta al final sin tocar el camino de partida', () => {
    const partida = [RAIZ, claves];
    expect(caminoHacia(partida, ssh)).toEqual([RAIZ, claves, ssh]);
    expect(partida).toHaveLength(2);
  });
});

describe('aRefrescar', () => {
  it('pide solo el camino abierto, nunca las ramas de al lado', () => {
    expect(aRefrescar([RAIZ, claves, ssh], new Set(['claves', 'ssh', 'otra']))).toEqual([
      null,
      'claves',
      'ssh',
    ]);
  });

  it('salta los escalones que están plegados: no hay nada que repintar', () => {
    expect(aRefrescar([RAIZ, claves, ssh], new Set(['ssh']))).toEqual([null, 'ssh']);
  });

  it('siempre incluye la raíz, que está desplegada por definición', () => {
    expect(aRefrescar([RAIZ], new Set())).toEqual([null]);
  });
});
