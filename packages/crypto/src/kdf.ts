import { argon2id } from 'hash-wasm';

import { KDF_PARAMS_V1, type KdfParams } from '@locker/shared';

import { randomBytes, utf8Encode } from './encoding.js';

/**
 * Derivacion de claves a partir de la contrasena maestra.
 *
 * El diseno tiene DOS niveles, y la razon de que sean dos importa:
 *
 *   password + salt ──Argon2id──> stretched (32 bytes)
 *                                      │
 *                  ┌───────────────────┴───────────────────┐
 *             HKDF("auth")                            HKDF("kek")
 *                  │                                       │
 *              authKey                                    KEK
 *        SE ENVIA al servidor                    NUNCA sale del navegador
 *     (guarda solo su hash Argon2id)             (solo envuelve la MK)
 *
 *   MK = 32 bytes aleatorios, generados UNA vez al crear la cuenta
 *   wrappedMasterKey = AES-KW(KEK, MK)   <- esto es lo que guarda el servidor
 *
 * Por que la MK es aleatoria y no se deriva de la contrasena: porque asi
 * cambiar la contrasena solo reenvuelve la MK -- 40 bytes -- y ni los
 * ficheros ni sus DEK se tocan. Si la MK saliera de la contrasena, cambiarla
 * obligaria a redescifrar y recifrar la boveda entera, y un fallo a mitad
 * dejaria ficheros irrecuperables.
 *
 * Ademas permite varios caminos independientes hasta la misma MK: la
 * contrasena y el fichero de recuperacion (DRAPPS-1044) envuelven cada uno su
 * copia, sin que uno sepa nada del otro.
 *
 * Por que authKey y KEK se separan con HKDF: si el servidor recibiera algo de
 * lo que pudiera derivar la KEK, podria desenvolver la MK y leerlo todo. Con
 * contextos HKDF distintos, conocer authKey no dice absolutamente nada sobre
 * la KEK.
 */

/** Longitud del salt por usuario. */
export const SALT_BYTES = 16;

/** Longitud de todas las claves simetricas del sistema. */
export const KEY_BYTES = 32;

const HKDF_INFO_AUTH = 'locker-auth-v1';
const HKDF_INFO_KEK = 'locker-kek-v1';

export interface DerivedSecrets {
  /** Se envia al servidor, que almacena solo su hash. */
  readonly authKey: Uint8Array;
  /** Envuelve y desenvuelve la clave maestra. Nunca sale del cliente. */
  readonly kek: CryptoKey;
}

export function generateSalt(): Uint8Array {
  return randomBytes(SALT_BYTES);
}

/**
 * Estira la contrasena con Argon2id y separa el resultado en las dos claves.
 *
 * Es la operacion mas lenta del sistema (~0,5-1 s), y esa lentitud es
 * justamente lo que hace inviable probar contrasenas por fuerza bruta.
 */
export async function deriveSecrets(
  password: string,
  salt: Uint8Array,
  params: KdfParams = KDF_PARAMS_V1,
): Promise<DerivedSecrets> {
  const stretched = await argon2id({
    password,
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memoryKib,
    hashLength: KEY_BYTES,
    outputType: 'binary',
  });

  const [authKey, kek] = await Promise.all([
    hkdf(stretched, HKDF_INFO_AUTH, salt),
    hkdf(stretched, HKDF_INFO_KEK, salt).then(importKekForWrapping),
  ]);

  // El material estirado ya no hace falta: dejarlo vivo en memoria seria un
  // secreto de mas del que solo se pueden sacar cosas malas.
  stretched.fill(0);

  return { authKey, kek };
}

async function hkdf(material: Uint8Array, info: string, salt: Uint8Array): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', toBuffer(material), 'HKDF', false, [
    'deriveBits',
  ]);

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toBuffer(salt),
      info: toBuffer(utf8Encode(info)),
    },
    base,
    KEY_BYTES * 8,
  );

  return new Uint8Array(bits);
}

/**
 * La KEK se importa como clave NO extraible y con los usos limitados a
 * envolver y desenvolver.
 *
 * Aunque un XSS lograra ejecutar codigo en la pagina, no podria exportar la
 * KEK ni usarla para cifrar datos arbitrarios: solo para desenvolver la MK.
 * No es una defensa completa, pero recorta bastante lo que un atacante puede
 * hacer con ella.
 */
async function importKekForWrapping(raw: Uint8Array): Promise<CryptoKey> {
  const key = await crypto.subtle.importKey('raw', toBuffer(raw), 'AES-KW', false, [
    'wrapKey',
    'unwrapKey',
  ]);
  raw.fill(0);
  return key;
}

/** WebCrypto quiere un ArrayBuffer limpio, no una vista sobre un buffer mayor. */
export function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}
