import { describe, expect, it } from 'vitest';

import { codigoParaEnviar, DIGITOS_DEL_CODIGO } from './codigo.js';

/**
 * El código del segundo factor se manda solo en cuanto está entero, así que
 * esta función decide cuándo se gasta un intento. Un "sí" de más no es un
 * detalle estético: cuenta contra el límite de reintentos del servidor.
 */

describe('codigoParaEnviar', () => {
  it('acepta los seis dígitos', () => {
    expect(codigoParaEnviar('123456')).toBe('123456');
    expect(DIGITOS_DEL_CODIGO).toBe(6);
  });

  it('quita los espacios que arrastra pegar desde el gestor o el móvil', () => {
    expect(codigoParaEnviar('  123456 ')).toBe('123456');
  });

  it('espera mientras falten dígitos', () => {
    expect(codigoParaEnviar('')).toBeNull();
    expect(codigoParaEnviar('12345')).toBeNull();
  });

  it('rechaza lo que mide seis pero no son seis dígitos', () => {
    // Contar caracteres a secas daría por bueno esto y gastaría un intento.
    expect(codigoParaEnviar('12 34 5')).toBeNull();
    expect(codigoParaEnviar('12345a')).toBeNull();
    expect(codigoParaEnviar('12-345')).toBeNull();
  });

  it('rechaza lo que se pasa de largo', () => {
    expect(codigoParaEnviar('1234567')).toBeNull();
  });
});
