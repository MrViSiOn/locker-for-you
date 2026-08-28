import { KDF_PARAMS_V1 } from '@locker/shared';
import { describe, expect, it } from 'vitest';

import { base64ToBytes } from './encoding.js';
import { createVault } from './keys.js';
import {
  decryptName,
  encryptName,
  InvalidNameError,
  isDuplicateName,
  MAX_NAME_LENGTH,
  sortByName,
  validateName,
} from './names.js';

const PARAMS = { ...KDF_PARAMS_V1, memoryKib: 1024, iterations: 1 };

async function nuevaNameKey(): Promise<CryptoKey> {
  const { vault } = await createVault('contrasena de prueba', PARAMS);
  return vault.nameKey;
}

describe('round-trip de nombres', () => {
  it.each([
    ['ascii simple', 'id_rsa'],
    ['con extension', 'clave-produccion.pem'],
    ['con acentos y ñ', 'contraseñas del año.txt'],
    ['con emoji', '🔐 claves importantes 🗝️.txt'],
    ['con espacios', 'mi clave de casa.pem'],
    ['un solo caracter', 'a'],
    ['longitud maxima', 'x'.repeat(MAX_NAME_LENGTH)],
    ['japones', '秘密鍵.pem'],
    ['con puntos', 'copia.de.seguridad.2026.tar.gz'],
  ])('conserva %s', async (_caso, nombre) => {
    const nameKey = await nuevaNameKey();

    expect(await decryptName(await encryptName(nombre, nameKey), nameKey)).toBe(nombre);
  });
});

describe('el mismo nombre cifrado dos veces', () => {
  it('produce bytes distintos, porque cada uno lleva su nonce', async () => {
    const nameKey = await nuevaNameKey();

    const primera = await encryptName('id_rsa', nameKey);
    const segunda = await encryptName('id_rsa', nameKey);

    expect(primera).not.toBe(segunda);
    // Pero ambas descifran a lo mismo.
    expect(await decryptName(primera, nameKey)).toBe(await decryptName(segunda, nameKey));
  });

  it('impide usar el nombre cifrado como indice o clave unica', async () => {
    const nameKey = await nuevaNameKey();

    const cifrados = new Set<string>();
    for (let i = 0; i < 10; i++) {
      cifrados.add(await encryptName('mismo.txt', nameKey));
    }

    expect(cifrados.size).toBe(10);
  });
});

describe('relleno de nombres', () => {
  it('oculta la longitud de los nombres de uso normal', async () => {
    const nameKey = await nuevaNameKey();

    const tamano = async (nombre: string): Promise<number> =>
      base64ToBytes(await encryptName(nombre, nameKey)).length;

    // Todos caben en el bloque de 62 bytes utiles, asi que ocupan lo mismo
    // por muy distinta que sea su longitud real.
    const corto = await tamano('a');
    expect(await tamano('id_rsa')).toBe(corto);
    expect(await tamano('clave-banco-santander-produccion.pem')).toBe(corto);
    expect(await tamano('x'.repeat(62))).toBe(corto);
  });

  it('un nombre muy largo sigue distinguiendose de uno corto', async () => {
    const nameKey = await nuevaNameKey();

    const corto = base64ToBytes(await encryptName('id_rsa', nameKey)).length;
    const larguisimo = base64ToBytes(await encryptName('x'.repeat(200), nameKey)).length;

    // Limitacion asumida y documentada: ocultarlo del todo obligaria a
    // rellenar siempre hasta 255 bytes, y no compensa.
    expect(larguisimo).toBeGreaterThan(corto);
  });
});

describe('validacion de nombres', () => {
  // El servidor no puede validar lo que no puede leer: esta es la unica
  // defensa contra un nombre que se escape del directorio al descargar.
  it.each([
    ['vacio', ''],
    ['punto', '.'],
    ['dos puntos', '..'],
    ['con barra', 'carpeta/fichero.txt'],
    ['con barra invertida', 'carpeta\\fichero.txt'],
    ['travesia de directorios', '../../.ssh/authorized_keys'],
    ['con espacio al inicio', ' clave.pem'],
    ['con espacio al final', 'clave.pem '],
    ['demasiado largo', 'x'.repeat(MAX_NAME_LENGTH + 1)],
  ])('rechaza un nombre %s', (_caso, nombre) => {
    expect(() => validateName(nombre)).toThrow(InvalidNameError);
  });

  it('rechaza caracteres de control', () => {
    expect(() => validateName(`clave${String.fromCharCode(0)}.pem`)).toThrow(
      /caracteres de control/,
    );
    expect(() => validateName(`clave${String.fromCharCode(10)}.pem`)).toThrow(
      /caracteres de control/,
    );
    expect(() => validateName(`clave${String.fromCharCode(127)}.pem`)).toThrow(
      /caracteres de control/,
    );
  });

  it('no deja cifrar un nombre invalido', async () => {
    const nameKey = await nuevaNameKey();

    await expect(encryptName('../fuga.txt', nameKey)).rejects.toThrow(InvalidNameError);
  });
});

describe('deteccion de manipulacion', () => {
  it('rechaza un nombre cifrado con otra clave', async () => {
    const mia = await nuevaNameKey();
    const ajena = await nuevaNameKey();

    const cifrado = await encryptName('secreto.pem', mia);

    await expect(decryptName(cifrado, ajena)).rejects.toThrow(InvalidNameError);
  });

  it('rechaza un nombre cifrado manipulado', async () => {
    const nameKey = await nuevaNameKey();
    const cifrado = await encryptName('clave.pem', nameKey);

    const bytes = base64ToBytes(cifrado);
    bytes[20] = (bytes[20] as number) ^ 0xff;
    const manipulado = btoa(String.fromCharCode(...bytes));

    await expect(decryptName(manipulado, nameKey)).rejects.toThrow(InvalidNameError);
  });

  it('rechaza un nombre cifrado demasiado corto para tener nonce', async () => {
    const nameKey = await nuevaNameKey();

    await expect(decryptName('AAAA', nameKey)).rejects.toThrow(/incompleto/);
  });
});

describe('ordenacion en cliente', () => {
  // El servidor no puede ordenar lo que no lee, asi que el orden lo pone
  // siempre el cliente sobre los nombres ya descifrados.
  it('ordena alfabeticamente ignorando mayusculas y acentos', () => {
    const nombres = ['zeta.txt', 'Alfa.txt', 'ñandu.txt', 'beta.txt'];

    expect(sortByName(nombres, (n) => n)).toEqual([
      'Alfa.txt',
      'beta.txt',
      'ñandu.txt',
      'zeta.txt',
    ]);
  });

  it('ordena numeros como numeros: clave2 antes que clave10', () => {
    const nombres = ['clave10.pem', 'clave2.pem', 'clave1.pem'];

    expect(sortByName(nombres, (n) => n)).toEqual(['clave1.pem', 'clave2.pem', 'clave10.pem']);
  });

  it('no muta el array original', () => {
    const original = ['b', 'a'];
    sortByName(original, (n) => n);

    expect(original).toEqual(['b', 'a']);
  });

  it('ordena objetos por el nombre descifrado', () => {
    const entradas = [{ nombre: 'z.txt' }, { nombre: 'a.txt' }];

    expect(sortByName(entradas, (e) => e.nombre)[0]?.nombre).toBe('a.txt');
  });
});

describe('nombres duplicados', () => {
  it('detecta un duplicado exacto', () => {
    expect(isDuplicateName('clave.pem', ['otra.pem', 'clave.pem'])).toBe(true);
  });

  it('detecta un duplicado ignorando mayusculas', () => {
    expect(isDuplicateName('Clave.PEM', ['clave.pem'])).toBe(true);
  });

  // En macOS un nombre con tilde puede llegar descompuesto (NFD) y en Windows
  // compuesto (NFC): sin normalizar, el mismo nombre pareceria dos distintos.
  it('detecta un duplicado con acentos en distinta forma unicode', () => {
    expect(isDuplicateName('año.txt'.normalize('NFD'), ['año.txt'.normalize('NFC')])).toBe(true);
  });

  it('no marca como duplicado un nombre nuevo', () => {
    expect(isDuplicateName('nueva.pem', ['clave.pem', 'otra.pem'])).toBe(false);
  });

  it('en una carpeta vacia nada es duplicado', () => {
    expect(isDuplicateName('cualquiera.txt', [])).toBe(false);
  });
});
