import { describe, expect, it } from 'vitest';

import {
  base64ToBytes,
  bytesToBase64,
  concatBytes,
  constantTimeEqual,
  randomBytes,
  utf8Decode,
  utf8Encode,
} from './encoding.js';

describe('base64', () => {
  it('hace round-trip de todos los valores de byte posibles', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;

    expect(base64ToBytes(bytesToBase64(all))).toEqual(all);
  });

  it.each([0, 1, 2, 3, 4, 5, 63, 64, 65])(
    'hace round-trip con longitud %i (cubre el padding)',
    (length) => {
      const bytes = randomBytes(length);
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    },
  );

  it('coincide con la codificacion de referencia de Node', () => {
    const bytes = randomBytes(97);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('rechaza caracteres no validos', () => {
    expect(() => base64ToBytes('abc$')).toThrow(/base64/);
  });
});

describe('utf8', () => {
  it.each(['', 'clave.pem', 'contrasena con acentos: aeiou nn', 'emoji 🔐🗝️', 'a'.repeat(255)])(
    'hace round-trip de %j',
    (value) => {
      expect(utf8Decode(utf8Encode(value))).toBe(value);
    },
  );
});

describe('concatBytes', () => {
  it('concatena preservando el orden', () => {
    const result = concatBytes(
      new Uint8Array([1, 2]),
      new Uint8Array([]),
      new Uint8Array([3, 4, 5]),
    );
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('devuelve vacio sin argumentos', () => {
    expect(concatBytes()).toEqual(new Uint8Array([]));
  });
});

describe('constantTimeEqual', () => {
  it('acepta iguales y rechaza distintos', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });

  it('rechaza longitudes distintas sin lanzar', () => {
    expect(constantTimeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});

describe('randomBytes', () => {
  it('devuelve la longitud pedida y no repite valores', () => {
    expect(randomBytes(32)).toHaveLength(32);
    expect(bytesToBase64(randomBytes(32))).not.toBe(bytesToBase64(randomBytes(32)));
  });
});
