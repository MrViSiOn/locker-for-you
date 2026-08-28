import { KDF_PARAMS_V1, type KdfParams } from '@locker/shared';
import { argon2id } from 'hash-wasm';

import { base64ToBytes, bytesToBase64, randomBytes } from './encoding.js';
import { generateSalt, KEY_BYTES, toBuffer } from './kdf.js';
import type { UnlockedVault, VaultCredentials } from './keys.js';

/**
 * Fichero de recuperacion (Emergency Kit).
 *
 * Red de seguridad contra el unico fallo irreversible del modelo: olvidar la
 * contrasena maestra. Mismo mecanismo que el Emergency Kit de 1Password.
 *
 * Funciona porque la clave maestra es aleatoria y esta ENVUELTA, no derivada
 * de la contrasena (DRAPPS-1036). Eso permite guardar una SEGUNDA copia de la
 * misma MK envuelta con otra clave -- la que sale de la passphrase de
 * recuperacion -- sin que ninguna de las dos sepa nada de la otra.
 *
 *   MK ──AES-KW(KEK de la contrasena)──> wrappedMasterKey
 *   MK ──AES-KW(clave de la passphrase)──> recoveryWrappedKey
 *
 * El servidor guarda las dos envueltas y no puede abrir ninguna. El modelo
 * zero-knowledge se mantiene intacto: simplemente hay dos puertas al mismo
 * sitio, y las dos llaves las tiene solo el usuario.
 */

/** 32 bytes = 256 bits de entropia real. */
const RECOVERY_BYTES = 32;

/** Grupos de 4 caracteres, como el Emergency Kit de 1Password. */
const TAMANO_GRUPO = 4;

/**
 * Alfabeto sin los caracteres que se confunden al leer o copiar a mano:
 * se quitan I, L, O, U, 0 y 1. Quien transcriba esto de un papel a las tres
 * de la manana con la boveda bloqueada agradecera no tener que adivinar si
 * ese simbolo es un uno o una ele.
 */
const ALFABETO = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

export class RecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryError';
  }
}

/**
 * Genera una passphrase de recuperacion legible.
 *
 * La entropia sale entera de `crypto.getRandomValues`: NUNCA de la
 * contrasena ni de nada derivado de ella. Esta passphrase es un segundo
 * camino a la boveda y vale exactamente lo mismo que la contrasena maestra.
 */
export function generarPassphraseDeRecuperacion(): string {
  const bytes = randomBytes(RECOVERY_BYTES);

  let texto = '';
  for (const byte of bytes) {
    // El modulo introduce un sesgo minimo (256 no es multiplo de 30), pero
    // con 32 bytes la entropia efectiva sigue muy por encima de 128 bits,
    // que es de sobra para lo que protege.
    texto += ALFABETO[byte % ALFABETO.length];
  }

  return (texto.match(new RegExp(`.{1,${String(TAMANO_GRUPO)}}`, 'g')) ?? []).join('-');
}

/** Normaliza lo que teclea el usuario: quita guiones, espacios y mayusculiza. */
export function normalizarPassphrase(passphrase: string): string {
  return passphrase.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Deriva la clave con la que se envuelve la copia de recuperacion de la MK.
 *
 * Usa Argon2id igual que la contrasena. Podria bastar con menos, porque la
 * passphrase tiene 256 bits de entropia real y no es adivinable, pero el
 * coste se paga una sola vez y no compensa arriesgarse.
 */
async function deriveClaveDeRecuperacion(
  passphrase: string,
  salt: Uint8Array,
  params: KdfParams,
): Promise<CryptoKey> {
  const material = await argon2id({
    password: normalizarPassphrase(passphrase),
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memoryKib,
    hashLength: KEY_BYTES,
    outputType: 'binary',
  });

  const clave = await crypto.subtle.importKey('raw', toBuffer(material), 'AES-KW', false, [
    'wrapKey',
    'unwrapKey',
  ]);

  material.fill(0);
  return clave;
}

export interface DatosDeRecuperacion {
  /** Lo que se muestra UNA VEZ y el usuario guarda offline. */
  readonly passphrase: string;
  /** base64 de AES-KW(claveDeRecuperacion, MK). Lo guarda el servidor. */
  readonly recoveryWrappedKey: string;
  readonly recoverySalt: string;
}

/**
 * Crea el Emergency Kit para una boveda abierta.
 *
 * Requiere la MK en claro, asi que solo puede hacerse con la boveda abierta:
 * al crear la cuenta o tras iniciar sesion. El servidor jamas participa.
 */
export async function crearRecuperacion(
  masterKeyBytes: Uint8Array,
  params: KdfParams = KDF_PARAMS_V1,
): Promise<DatosDeRecuperacion> {
  const passphrase = generarPassphraseDeRecuperacion();
  const salt = generateSalt();
  const claveRecuperacion = await deriveClaveDeRecuperacion(passphrase, salt, params);

  const mkExportable = await crypto.subtle.importKey(
    'raw',
    toBuffer(masterKeyBytes),
    'AES-KW',
    true,
    ['wrapKey', 'unwrapKey'],
  );

  const envuelta = await crypto.subtle.wrapKey('raw', mkExportable, claveRecuperacion, 'AES-KW');

  return {
    passphrase,
    recoveryWrappedKey: bytesToBase64(new Uint8Array(envuelta)),
    recoverySalt: bytesToBase64(salt),
  };
}

/**
 * Recupera la clave maestra a partir de la passphrase.
 *
 * Devuelve los bytes de la MK, que el llamante debe usar de inmediato para
 * fijar una contrasena nueva. AES-KW comprueba integridad, asi que una
 * passphrase equivocada lanza en vez de devolver basura.
 */
export async function recuperarClaveMaestra(
  passphrase: string,
  recoveryWrappedKey: string,
  recoverySalt: string,
  params: KdfParams = KDF_PARAMS_V1,
): Promise<Uint8Array> {
  const clave = await deriveClaveDeRecuperacion(passphrase, base64ToBytes(recoverySalt), params);

  let mk: CryptoKey;
  try {
    mk = await crypto.subtle.unwrapKey(
      'raw',
      toBuffer(base64ToBytes(recoveryWrappedKey)),
      clave,
      'AES-KW',
      { name: 'AES-KW', length: 256 },
      true,
      ['wrapKey', 'unwrapKey'],
    );
  } catch {
    throw new RecoveryError('La clave de recuperacion no es correcta.');
  }

  return new Uint8Array(await crypto.subtle.exportKey('raw', mk));
}

/**
 * Texto del fichero que se descarga.
 *
 * El aviso de que quien lo tenga tiene la boveda va arriba y sin rodeos: este
 * papel vale exactamente lo mismo que la contrasena maestra.
 */
export function textoDelFicheroDeRecuperacion(
  passphrase: string,
  email: string,
  fechaISO: string,
): string {
  return [
    'LOCKER DRAPPS - CLAVE DE RECUPERACION',
    '=====================================',
    '',
    `Cuenta:   ${email}`,
    `Generada: ${fechaISO.slice(0, 10)}`,
    '',
    'Tu clave de recuperacion:',
    '',
    `    ${passphrase}`,
    '',
    '-------------------------------------',
    'QUIEN TENGA ESTA CLAVE TIENE ACCESO A TODOS TUS FICHEROS.',
    'Guardala offline: impresa en un cajon, o en un pendrive que no',
    'este conectado. Nunca en el ordenador ni en la nube.',
    '',
    'Con ella recuperas la boveda aunque olvides la contrasena maestra.',
    'Sin ella y sin la contrasena, tus ficheros se pierden para siempre:',
    'ni el servidor ni nadie puede descifrarlos.',
    '',
    'Esta clave solo se muestra una vez. El servidor no la conserva.',
    '-------------------------------------',
  ].join('\n');
}

/** Comprueba si una bóveda ya tiene Emergency Kit configurado. */
export function tieneRecuperacion(
  credenciales: Pick<VaultCredentials, never> & {
    recoveryWrappedKey?: string | null;
  },
): boolean {
  return credenciales.recoveryWrappedKey !== null && credenciales.recoveryWrappedKey !== undefined;
}

export type { UnlockedVault };
