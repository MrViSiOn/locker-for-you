import { KDF_PARAMS_V1, type KdfParams } from '@locker/shared';

import { base64ToBytes, bytesToBase64 } from './encoding.js';
import { deriveSecrets, generateSalt, KEY_BYTES, toBuffer } from './kdf.js';

/**
 * Jerarquia de claves de la boveda.
 *
 *   password --Argon2id+HKDF--> KEK --AES-KW--> MK --AES-KW--> DEK --AES-GCM--> fichero
 *                                │               │
 *                    se rehace al entrar     aleatoria, generada una vez
 *                    (nunca se guarda)       (el servidor solo tiene wrappedMasterKey)
 *
 * Cada fichero tiene su propia DEK. Limita el dano si una se filtrara -- solo
 * cae ese fichero -- y deja la puerta abierta a compartir un fichero suelto
 * algun dia sin dar acceso a la boveda entera.
 */

const HKDF_INFO_NAMES = 'locker-names-v1';

/** Lo que el servidor almacena de una cuenta. Todo opaco para el. */
export interface VaultCredentials {
  readonly kdfSalt: string;
  readonly kdfParams: KdfParams;
  /** base64 de la authKey; el servidor guarda su hash, no esto. */
  readonly authKey: string;
  /** base64 de AES-KW(KEK, MK). Sin la contrasena no se puede desenvolver. */
  readonly wrappedMasterKey: string;
}

/** Claves vivas en memoria durante la sesion. Nunca se serializan. */
export interface UnlockedVault {
  /** Envuelve y desenvuelve las DEK. No extraible. */
  readonly masterKey: CryptoKey;
  /** Cifra nombres de fichero y carpeta (DRAPPS-1039). No extraible. */
  readonly nameKey: CryptoKey;
}

/**
 * Crea una boveda nueva. Se ejecuta una sola vez, al dar de alta la cuenta.
 *
 * La MK se genera aleatoria y NO se deriva de la contrasena: asi cambiarla
 * mas adelante solo reenvuelve 40 bytes en lugar de obligar a recifrar todo.
 */
export async function createVault(
  password: string,
  params: KdfParams = KDF_PARAMS_V1,
): Promise<{ credentials: VaultCredentials; vault: UnlockedVault }> {
  const kdfSalt = generateSalt();
  const { authKey, kek } = await deriveSecrets(password, kdfSalt, params);

  // extractable: true es imprescindible aqui -- AES-KW solo puede envolver
  // claves extraibles. La MK se reimporta despues como no extraible, que es
  // la que se queda viva durante la sesion.
  const masterKeyRaw = await crypto.subtle.generateKey({ name: 'AES-KW', length: 256 }, true, [
    'wrapKey',
    'unwrapKey',
  ]);

  const wrapped = await crypto.subtle.wrapKey('raw', masterKeyRaw, kek, 'AES-KW');
  const masterKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', masterKeyRaw));

  return {
    credentials: {
      kdfSalt: bytesToBase64(kdfSalt),
      kdfParams: params,
      authKey: bytesToBase64(authKey),
      wrappedMasterKey: bytesToBase64(new Uint8Array(wrapped)),
    },
    vault: await buildVault(masterKeyBytes),
  };
}

/**
 * Devuelve los bytes de la clave maestra en claro.
 *
 * USO RESTRINGIDO: solo para crear el fichero de recuperacion (DRAPPS-1044),
 * que necesita envolver una SEGUNDA copia de la misma MK con otra clave. En
 * el resto del codigo se usa `unlockVault`, que la deja como CryptoKey no
 * extraible y por tanto imposible de sacar de la pagina.
 *
 * Quien llame a esto debe usar los bytes de inmediato y borrarlos con
 * `fill(0)`: cuanto menos tiempo viva la MK en claro en memoria, mejor.
 */
export async function exportarMasterKeyParaRecuperacion(
  password: string,
  credentials: VaultCredentials,
): Promise<Uint8Array> {
  const { kek } = await deriveSecrets(
    password,
    base64ToBytes(credentials.kdfSalt),
    credentials.kdfParams,
  );

  const masterKeyRaw = await crypto.subtle.unwrapKey(
    'raw',
    toBuffer(base64ToBytes(credentials.wrappedMasterKey)),
    kek,
    'AES-KW',
    { name: 'AES-KW', length: 256 },
    true,
    ['wrapKey', 'unwrapKey'],
  );

  return new Uint8Array(await crypto.subtle.exportKey('raw', masterKeyRaw));
}

/**
 * Reenvuelve una clave maestra ya conocida con una contrasena nueva.
 *
 * Es lo que cierra el flujo de recuperacion: quien entra con el Emergency Kit
 * tiene la MK pero no la contrasena, asi que hay que fijar una nueva y
 * envolver la MK con ella. Los ficheros y sus DEK no se tocan.
 */
export async function reenvolverConNuevaPassword(
  masterKeyBytes: Uint8Array,
  passwordNueva: string,
  params: KdfParams = KDF_PARAMS_V1,
): Promise<VaultCredentials> {
  const kdfSalt = generateSalt();
  const { authKey, kek } = await deriveSecrets(passwordNueva, kdfSalt, params);

  const mkExportable = await crypto.subtle.importKey(
    'raw',
    toBuffer(masterKeyBytes),
    'AES-KW',
    true,
    ['wrapKey', 'unwrapKey'],
  );

  const envuelta = await crypto.subtle.wrapKey('raw', mkExportable, kek, 'AES-KW');

  return {
    kdfSalt: bytesToBase64(kdfSalt),
    kdfParams: params,
    authKey: bytesToBase64(authKey),
    wrappedMasterKey: bytesToBase64(new Uint8Array(envuelta)),
  };
}

/**
 * Abre una boveda existente con la contrasena.
 *
 * Lanza si la contrasena es incorrecta: AES-KW lleva su propia comprobacion
 * de integridad, asi que desenvolver con la clave equivocada FALLA en vez de
 * devolver 32 bytes de basura. Eso importa mucho -- una clave silenciosamente
 * incorrecta produciria descifrados corruptos que pareceria que son ficheros
 * danados.
 */
export async function unlockVault(
  password: string,
  credentials: VaultCredentials,
): Promise<{ vault: UnlockedVault; authKey: string }> {
  const salt = base64ToBytes(credentials.kdfSalt);
  const { authKey, kek } = await deriveSecrets(password, salt, credentials.kdfParams);

  const masterKeyRaw = await crypto.subtle.unwrapKey(
    'raw',
    toBuffer(base64ToBytes(credentials.wrappedMasterKey)),
    kek,
    'AES-KW',
    { name: 'AES-KW', length: 256 },
    true,
    ['wrapKey', 'unwrapKey'],
  );

  const masterKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', masterKeyRaw));

  return {
    vault: await buildVault(masterKeyBytes),
    authKey: bytesToBase64(authKey),
  };
}

/**
 * Cambia la contrasena.
 *
 * Solo se reenvuelve la MK: las DEK y los blobs no se tocan. Es una unica
 * fila de `users` la que cambia, asi que la atomicidad sale gratis y no
 * existe el estado intermedio donde unas claves estan envueltas con la
 * contrasena vieja y otras con la nueva.
 *
 * Se exige la contrasena actual a proposito: sin eso, alguien con la sesion
 * abierta -- una pestana olvidada, un XSS -- podria cambiarla sin conocerla y
 * quedarse con la boveda.
 */
export async function changePassword(
  passwordActual: string,
  passwordNueva: string,
  credentials: VaultCredentials,
  params: KdfParams = KDF_PARAMS_V1,
): Promise<VaultCredentials> {
  const saltViejo = base64ToBytes(credentials.kdfSalt);
  const { kek: kekVieja } = await deriveSecrets(passwordActual, saltViejo, credentials.kdfParams);

  // Si la contrasena actual no es la buena, esto lanza y no se toca nada.
  const masterKeyRaw = await crypto.subtle.unwrapKey(
    'raw',
    toBuffer(base64ToBytes(credentials.wrappedMasterKey)),
    kekVieja,
    'AES-KW',
    { name: 'AES-KW', length: 256 },
    true,
    ['wrapKey', 'unwrapKey'],
  );

  // Salt nuevo: reutilizarlo permitiria comparar los dos hashes de authKey y
  // saber si la contrasena cambio de verdad.
  const saltNuevo = generateSalt();
  const { authKey, kek: kekNueva } = await deriveSecrets(passwordNueva, saltNuevo, params);
  const rewrapped = await crypto.subtle.wrapKey('raw', masterKeyRaw, kekNueva, 'AES-KW');

  return {
    kdfSalt: bytesToBase64(saltNuevo),
    kdfParams: params,
    authKey: bytesToBase64(authKey),
    wrappedMasterKey: bytesToBase64(new Uint8Array(rewrapped)),
  };
}

/** Genera una DEK nueva y la devuelve envuelta con la MK. */
export async function createDek(
  vault: UnlockedVault,
): Promise<{ dek: CryptoKey; wrappedDek: string }> {
  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);

  const wrapped = await crypto.subtle.wrapKey('raw', dek, vault.masterKey, 'AES-KW');

  return { dek, wrappedDek: bytesToBase64(new Uint8Array(wrapped)) };
}

/** Recupera la DEK de un fichero. Lanza si la MK no es la que la envolvio. */
export async function unwrapDek(vault: UnlockedVault, wrappedDek: string): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    'raw',
    toBuffer(base64ToBytes(wrappedDek)),
    vault.masterKey,
    'AES-KW',
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Reimporta la MK como no extraible y deriva de ella la clave de nombres.
 *
 * A partir de aqui la MK ya no se puede exportar: ni siquiera un XSS podria
 * sacarla de la pagina, solo pedirle que envuelva o desenvuelva claves.
 */
async function buildVault(masterKeyBytes: Uint8Array): Promise<UnlockedVault> {
  const masterKey = await crypto.subtle.importKey(
    'raw',
    toBuffer(masterKeyBytes),
    'AES-KW',
    false,
    ['wrapKey', 'unwrapKey'],
  );

  const hkdfBase = await crypto.subtle.importKey('raw', toBuffer(masterKeyBytes), 'HKDF', false, [
    'deriveKey',
  ]);

  const nameKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(HKDF_INFO_NAMES),
    },
    hkdfBase,
    { name: 'AES-GCM', length: KEY_BYTES * 8 },
    false,
    ['encrypt', 'decrypt'],
  );

  masterKeyBytes.fill(0);

  return { masterKey, nameKey };
}
