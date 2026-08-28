import { describe, expect, it } from 'vitest';

import {
  BlobFormatError,
  decryptBlob,
  encryptBlob,
  FORMAT_VERSION,
  PADDING_BLOCK,
} from './blob.js';
import { randomBytes, utf8Encode } from './encoding.js';

async function nuevaDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const MIB = 1024 * 1024;

/**
 * Comparacion byte a byte con un bucle propio.
 *
 * `toEqual` sobre un Uint8Array de megabytes tarda segundos: compara elemento
 * a elemento construyendo el diff por si falla. Aqui solo interesa el
 * si/no, y si falla se reporta la primera posicion que difiere.
 */
function esperarBytesIguales(actual: Uint8Array, esperado: Uint8Array): void {
  expect(actual.length).toBe(esperado.length);
  for (let i = 0; i < esperado.length; i++) {
    if (actual[i] !== esperado[i]) {
      expect.fail(
        `Difieren en el byte ${i}: ${String(actual[i])} en vez de ${String(esperado[i])}`,
      );
    }
  }
}

describe('round-trip', () => {
  // Los tamanos frontera son donde viven los errores de troceado: justo antes
  // del chunk, justo en el limite y justo despues.
  it.each([
    ['vacio', 0],
    ['1 byte', 1],
    ['1 KiB', 1024],
    ['un bloque de padding justo', PADDING_BLOCK - 4],
    ['un byte mas que un bloque de padding', PADDING_BLOCK - 3],
    ['1 MiB menos 1', MIB - 1],
    ['1 MiB exacto', MIB],
    ['1 MiB mas 1', MIB + 1],
    ['3 MiB (varios chunks)', 3 * MIB],
  ])(
    'devuelve los mismos bytes con %s',
    async (_nombre, tamano) => {
      const dek = await nuevaDek();
      const original = randomBytes(tamano);

      const descifrado = await decryptBlob(await encryptBlob(original, dek), dek);

      esperarBytesIguales(descifrado, original);
    },
    30_000,
  );

  it('aguanta un fichero de 50 MB, el limite del sistema', async () => {
    const dek = await nuevaDek();
    const original = randomBytes(50 * MIB);

    const descifrado = await decryptBlob(await encryptBlob(original, dek), dek);

    esperarBytesIguales(descifrado, original);
  }, 180_000);

  it('preserva el contenido de una clave privada real', async () => {
    const dek = await nuevaDek();
    const clave = utf8Encode(
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n',
    );

    const descifrado = await decryptBlob(await encryptBlob(clave, dek), dek);

    expect(new TextDecoder().decode(descifrado)).toContain('BEGIN OPENSSH PRIVATE KEY');
  });
});

describe('relleno de tamano', () => {
  it('oculta el tamano real: ficheros muy distintos ocupan lo mismo', async () => {
    const dek = await nuevaDek();

    // Tamanos tipicos de clave privada: Ed25519, RSA-2048 y RSA-4096.
    const ed25519 = (await encryptBlob(randomBytes(400), dek)).length;
    const rsa2048 = (await encryptBlob(randomBytes(1700), dek)).length;
    const rsa4096 = (await encryptBlob(randomBytes(3200), dek)).length;

    expect(ed25519).toBe(rsa2048);
    expect(rsa2048).toBe(rsa4096);
  });

  it('el blob crece en bloques de 4 KiB, no byte a byte', async () => {
    const dek = await nuevaDek();

    const pequeno = (await encryptBlob(randomBytes(100), dek)).length;
    const justoAntes = (await encryptBlob(randomBytes(PADDING_BLOCK - 5), dek)).length;
    const justoDespues = (await encryptBlob(randomBytes(PADDING_BLOCK), dek)).length;

    expect(pequeno).toBe(justoAntes);
    expect(justoDespues).toBe(pequeno + PADDING_BLOCK);
  });
});

describe('deteccion de manipulacion', () => {
  it('rechaza un bit cambiado en el contenido', async () => {
    const dek = await nuevaDek();
    const blob = await encryptBlob(utf8Encode('contenido importante'), dek);

    const manipulado = blob.slice();
    manipulado[40] = (manipulado[40] as number) ^ 0x01;

    await expect(decryptBlob(manipulado, dek)).rejects.toThrow(BlobFormatError);
  });

  it('rechaza un bit cambiado en la cabecera', async () => {
    const dek = await nuevaDek();
    const blob = await encryptBlob(utf8Encode('contenido'), dek);

    // Byte 10: dentro del nonceBase, que va autenticado como AAD.
    const manipulado = blob.slice();
    manipulado[10] = (manipulado[10] as number) ^ 0xff;

    await expect(decryptBlob(manipulado, dek)).rejects.toThrow(BlobFormatError);
  });

  // El ataque de truncado: cortar el final del fichero y hacer que el
  // descifrado lo de por bueno. El flag esUltimo en los AAD lo impide.
  it('rechaza un fichero truncado', async () => {
    const dek = await nuevaDek();
    const blob = await encryptBlob(randomBytes(3 * MIB), dek);

    const truncado = blob.slice(0, blob.length - (MIB + 16));

    await expect(decryptBlob(truncado, dek)).rejects.toThrow(BlobFormatError);
  });

  it('rechaza chunks reordenados', async () => {
    const dek = await nuevaDek();
    const blob = await encryptBlob(randomBytes(3 * MIB), dek);

    const HEADER = 17;
    const CIFRADO = MIB + 16;
    const reordenado = blob.slice();
    const primero = blob.slice(HEADER, HEADER + CIFRADO);
    const segundo = blob.slice(HEADER + CIFRADO, HEADER + 2 * CIFRADO);
    reordenado.set(segundo, HEADER);
    reordenado.set(primero, HEADER + CIFRADO);

    await expect(decryptBlob(reordenado, dek)).rejects.toThrow(BlobFormatError);
  });

  it('no se pueden mezclar chunks de dos ficheros cifrados con la misma clave', async () => {
    const dek = await nuevaDek();
    const uno = await encryptBlob(randomBytes(2 * MIB), dek);
    const otro = await encryptBlob(randomBytes(2 * MIB), dek);

    const HEADER = 17;
    const CIFRADO = MIB + 16;
    const frankenstein = uno.slice();
    frankenstein.set(otro.slice(HEADER, HEADER + CIFRADO), HEADER);

    await expect(decryptBlob(frankenstein, dek)).rejects.toThrow(BlobFormatError);
  });

  it('rechaza el blob con una clave que no es la suya', async () => {
    const blob = await encryptBlob(utf8Encode('secreto'), await nuevaDek());

    await expect(decryptBlob(blob, await nuevaDek())).rejects.toThrow(BlobFormatError);
  });
});

describe('validacion de la cabecera', () => {
  it('rechaza bytes que no son un blob del Locker', async () => {
    const dek = await nuevaDek();

    await expect(decryptBlob(randomBytes(200), dek)).rejects.toThrow(/no son un blob/);
  });

  it('rechaza un blob mas corto que su cabecera', async () => {
    const dek = await nuevaDek();

    await expect(decryptBlob(randomBytes(5), dek)).rejects.toThrow(/mas corto/);
  });

  // El byte de version es lo que permitira migrar de algoritmo dentro de
  // anos sin dejar la boveda vieja ilegible.
  it('rechaza una version de formato desconocida, con un mensaje util', async () => {
    const dek = await nuevaDek();
    const blob = await encryptBlob(utf8Encode('x'), dek);

    const futuro = blob.slice();
    futuro[4] = 99;

    await expect(decryptBlob(futuro, dek)).rejects.toThrow(/Version de formato 99 desconocida/);
  });

  it('rechaza una cabecera con tamano de chunk cero', async () => {
    const dek = await nuevaDek();
    const blob = await encryptBlob(utf8Encode('x'), dek);

    const roto = blob.slice();
    new DataView(roto.buffer, roto.byteOffset, roto.byteLength).setUint32(5, 0, false);

    await expect(decryptBlob(roto, dek)).rejects.toThrow(/chunk de cero/);
  });

  it('rechaza un blob con cabecera valida pero sin ningun chunk', async () => {
    const dek = await nuevaDek();
    const blob = await encryptBlob(utf8Encode('x'), dek);

    // Cabecera intacta, cuerpo cortado del todo. Sin esta guarda el bucle no
    // daria ni una vuelta y devolveria un fichero vacio como si fuera bueno.
    const soloCabecera = blob.slice(0, 17);

    await expect(decryptBlob(soloCabecera, dek)).rejects.toThrow(/ningun chunk/);
  });

  it('el formato declarado es la version 1', async () => {
    const dek = await nuevaDek();
    const blob = await encryptBlob(utf8Encode('x'), dek);

    expect(blob[4]).toBe(FORMAT_VERSION);
    expect(String.fromCharCode(...blob.slice(0, 4))).toBe('LCKR');
  });
});

describe('progreso del cifrado', () => {
  it('avisa una vez por chunk, en orden y hasta el final', async () => {
    const dek = await nuevaDek();
    const avisos: [number, number][] = [];

    // Cuatro chunks justos. Los 4 bytes de menos son el prefijo de longitud
    // que el relleno mete DENTRO del texto plano: con 4*4096 exactos harian
    // falta cinco chunks, no cuatro.
    await encryptBlob(randomBytes(4 * 4096 - 4), dek, 4096, (hechos, total) => {
      avisos.push([hechos, total]);
    });

    expect(avisos).toEqual([
      [1, 4],
      [2, 4],
      [3, 4],
      [4, 4],
    ]);
  });

  it('avisa tambien con un fichero vacio, que sigue teniendo un chunk', async () => {
    const dek = await nuevaDek();
    const avisos: [number, number][] = [];

    await encryptBlob(new Uint8Array(0), dek, 4096, (hechos, total) => {
      avisos.push([hechos, total]);
    });

    // Sin esto la barra de un fichero vacio se quedaria a cero para siempre.
    expect(avisos).toEqual([[1, 1]]);
  });

  it('cifra igual se pase o no el callback', async () => {
    const dek = await nuevaDek();
    const datos = utf8Encode('mismo contenido');

    const conCallback = await encryptBlob(datos, dek, 4096, () => undefined);

    esperarBytesIguales(await decryptBlob(conCallback, dek), datos);
  });
});
