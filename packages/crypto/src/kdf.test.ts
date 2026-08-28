import { KDF_PARAMS_V1 } from '@locker/shared';
import { describe, expect, it } from 'vitest';

import { bytesToBase64, constantTimeEqual } from './encoding.js';
import { deriveSecrets, generateSalt, KEY_BYTES, SALT_BYTES } from './kdf.js';

// Argon2id con 64 MiB es lento a proposito. Para los tests se usan parametros
// reducidos salvo donde se mide el coste real.
const PARAMS_RAPIDOS = { ...KDF_PARAMS_V1, memoryKib: 1024, iterations: 1 };

describe('generateSalt', () => {
  it('devuelve 16 bytes distintos cada vez', () => {
    const a = generateSalt();
    const b = generateSalt();

    expect(a).toHaveLength(SALT_BYTES);
    expect(bytesToBase64(a)).not.toBe(bytesToBase64(b));
  });
});

describe('deriveSecrets', () => {
  it('es determinista: misma password y salt dan la misma authKey', async () => {
    const salt = generateSalt();

    const primera = await deriveSecrets('correcta caballo bateria grapa', salt, PARAMS_RAPIDOS);
    const segunda = await deriveSecrets('correcta caballo bateria grapa', salt, PARAMS_RAPIDOS);

    expect(constantTimeEqual(primera.authKey, segunda.authKey)).toBe(true);
  });

  it('una contrasena distinta da una authKey distinta', async () => {
    const salt = generateSalt();

    const buena = await deriveSecrets('contrasena', salt, PARAMS_RAPIDOS);
    const mala = await deriveSecrets('contrasenb', salt, PARAMS_RAPIDOS);

    expect(constantTimeEqual(buena.authKey, mala.authKey)).toBe(false);
  });

  it('el mismo password con salt distinto da claves distintas', async () => {
    const a = await deriveSecrets('misma', generateSalt(), PARAMS_RAPIDOS);
    const b = await deriveSecrets('misma', generateSalt(), PARAMS_RAPIDOS);

    expect(constantTimeEqual(a.authKey, b.authKey)).toBe(false);
  });

  it('la authKey mide 32 bytes', async () => {
    const { authKey } = await deriveSecrets('x', generateSalt(), PARAMS_RAPIDOS);
    expect(authKey).toHaveLength(KEY_BYTES);
  });

  // El nucleo del modelo E2EE: el servidor recibe la authKey, y de ella no
  // debe poder salir nada que lleve hasta la KEK.
  it('la KEK no es extraible ni sirve para cifrar datos arbitrarios', async () => {
    const { kek } = await deriveSecrets('secreta', generateSalt(), PARAMS_RAPIDOS);

    expect(kek.extractable).toBe(false);
    expect(kek.usages.sort()).toEqual(['unwrapKey', 'wrapKey']);
    await expect(crypto.subtle.exportKey('raw', kek)).rejects.toThrow();
  });

  it('cambiar los parametros de KDF cambia el resultado', async () => {
    const salt = generateSalt();

    const conUnaIteracion = await deriveSecrets('igual', salt, PARAMS_RAPIDOS);
    const conDos = await deriveSecrets('igual', salt, { ...PARAMS_RAPIDOS, iterations: 2 });

    expect(constantTimeEqual(conUnaIteracion.authKey, conDos.authKey)).toBe(false);
  });

  it('acepta contrasenas con acentos y emoji sin perder determinismo', async () => {
    const salt = generateSalt();
    const password = 'mi contraseña con ñ, tildes áéí y 🔐';

    const a = await deriveSecrets(password, salt, PARAMS_RAPIDOS);
    const b = await deriveSecrets(password, salt, PARAMS_RAPIDOS);

    expect(constantTimeEqual(a.authKey, b.authKey)).toBe(true);
  });

  it('los parametros van versionados, para poder subirlos sin romper cuentas', () => {
    expect(KDF_PARAMS_V1.version).toBe(1);
    expect(KDF_PARAMS_V1.memoryKib).toBe(65536);
    expect(KDF_PARAMS_V1.iterations).toBeGreaterThanOrEqual(3);
  });

  // La lentitud no es un efecto secundario, es la defensa: si esto fuera
  // rapido, probar millones de contrasenas seria viable.
  it('con los parametros reales tarda lo suficiente como para frenar la fuerza bruta', async () => {
    const inicio = performance.now();
    await deriveSecrets('contrasena real', generateSalt(), KDF_PARAMS_V1);
    const ms = performance.now() - inicio;

    expect(ms).toBeGreaterThan(50);
    // Cota superior generosa: en CI el runner puede ir lento y no queremos un
    // test que falle de forma intermitente por eso.
    expect(ms).toBeLessThan(10_000);
  }, 30_000);
});
