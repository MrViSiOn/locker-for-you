/**
 * Utilidades de codificacion compartidas por cliente y servidor.
 *
 * Sin dependencias de Node ni del DOM a proposito: este paquete tiene que
 * correr identico en el navegador y en los tests de Node.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8Encode(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function utf8Decode(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * base64 implementado a mano en vez de con `btoa`/`Buffer`.
 *
 * `btoa` solo existe en el navegador y `Buffer` solo en Node: usar cualquiera
 * de los dos ataria este paquete a un entorno. Y `btoa` ademas exige pasar por
 * una cadena binaria intermedia, que corrompe los bytes >0x7F si alguien se
 * despista con la codificacion.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];

    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out +=
      b1 === undefined
        ? '='
        : BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? '=' : BASE64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

const BASE64_LOOKUP: ReadonlyMap<string, number> = new Map(
  [...BASE64_ALPHABET].map((char, index) => [char, index]),
);

export function base64ToBytes(value: string): Uint8Array {
  const clean = value.replace(/=+$/, '');
  const out = new Uint8Array((clean.length * 3) >> 2);

  let outIndex = 0;
  let buffer = 0;
  let bitsInBuffer = 0;

  for (const char of clean) {
    const sextet = BASE64_LOOKUP.get(char);
    if (sextet === undefined) {
      throw new Error(`Caracter no valido en base64: ${JSON.stringify(char)}`);
    }
    buffer = (buffer << 6) | sextet;
    bitsInBuffer += 6;
    if (bitsInBuffer >= 8) {
      bitsInBuffer -= 8;
      out[outIndex++] = (buffer >> bitsInBuffer) & 0xff;
    }
  }

  return out;
}

export function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Comparacion en tiempo constante.
 *
 * Un `===` sobre bytes secretos sale antes en cuanto encuentra una diferencia,
 * y ese tiempo distinto permite adivinar el valor byte a byte. Aqui se recorren
 * siempre todos los bytes y se acumula la diferencia con OR.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}

/**
 * Limite de `crypto.getRandomValues` por llamada, fijado por la especificacion
 * de WebCrypto. Pedir mas lanza QuotaExceededError.
 */
const MAX_RANDOM_PER_CALL = 65536;

/**
 * Bytes aleatorios criptograficamente seguros, en la cantidad que sea.
 *
 * Se rellena por bloques porque `crypto.getRandomValues` se niega a devolver
 * mas de 64 KiB de una vez. Sin esto, el relleno de un fichero de mas de
 * 64 KiB reventaria con un QuotaExceededError que no dice nada del problema
 * real, y solo se descubriria al subir el primer fichero grande.
 */
export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += MAX_RANDOM_PER_CALL) {
    crypto.getRandomValues(out.subarray(offset, Math.min(offset + MAX_RANDOM_PER_CALL, length)));
  }
  return out;
}
