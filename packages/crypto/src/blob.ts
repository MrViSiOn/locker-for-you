import { concatBytes, randomBytes } from './encoding.js';
import { toBuffer } from './kdf.js';

/**
 * Formato del blob cifrado. Ver FORMAT.md: es un contrato de por vida, porque
 * define como se leeran ficheros guardados hace anos.
 *
 *   [magic "LCKR"][version u8][chunkSize u32 BE][nonceBase 8B]   <- cabecera, 17 B
 *   [chunk 0: ciphertext + tag 16B]
 *   [chunk 1: ciphertext + tag 16B]
 *   ...
 */

const MAGIC = new Uint8Array([0x4c, 0x43, 0x4b, 0x52]); // "LCKR"
export const FORMAT_VERSION = 1;

const NONCE_BASE_BYTES = 8;
const HEADER_BYTES = MAGIC.length + 1 + 4 + NONCE_BASE_BYTES;
const GCM_TAG_BYTES = 16;

/** 1 MiB. Compromiso entre numero de operaciones y memoria por chunk. */
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;

/**
 * Los tamanos se redondean a multiplos de 4 KiB antes de cifrar (DRAPPS-1039).
 *
 * En claves privadas el tamano exacto es casi una huella dactilar: Ed25519
 * ronda los 400 B, RSA-2048 los 1,7 KB y RSA-4096 los 3,2 KB. Sin relleno,
 * quien tuviera acceso al disco sabria que tipo de claves guardas y cuantas
 * de cada, sin descifrar nada.
 */
export const PADDING_BLOCK = 4096;

/** Prefijo con la longitud real, para poder recortar el relleno al descifrar. */
const LENGTH_PREFIX_BYTES = 4;

export class BlobFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobFormatError';
  }
}

/**
 * Cifra un fichero completo.
 *
 * El relleno se aplica AL TEXTO PLANO, antes de cifrar. Al reves no serviria
 * de nada: el tamano del ciphertext seguiria delatando el del original.
 *
 * `alProgresar` se llama al terminar cada chunk. Existe porque cifrar es la
 * parte lenta de una subida y sin este dato la barra se queda quieta
 * justamente durante el rato que mas parece un cuelgue.
 */
export async function encryptBlob(
  plaintext: Uint8Array,
  dek: CryptoKey,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  alProgresar?: (hechos: number, total: number) => void,
): Promise<Uint8Array> {
  const nonceBase = randomBytes(NONCE_BASE_BYTES);
  const header = buildHeader(chunkSize, nonceBase);
  const padded = addPadding(plaintext);

  // Un fichero vacio sigue teniendo un chunk: su prefijo de longitud y su
  // relleno. Sin el, no habria nada que autenticar y un blob truncado a cero
  // pasaria por un fichero vacio legitimo.
  const totalChunks = Math.max(1, Math.ceil(padded.length / chunkSize));
  const partes: Uint8Array[] = [header];

  for (let indice = 0; indice < totalChunks; indice++) {
    const trozo = padded.subarray(indice * chunkSize, (indice + 1) * chunkSize);
    const esUltimo = indice === totalChunks - 1;

    const cifrado = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: toBuffer(buildNonce(nonceBase, indice)),
        additionalData: toBuffer(buildAad(header, indice, esUltimo)),
      },
      dek,
      toBuffer(trozo),
    );

    partes.push(new Uint8Array(cifrado));
    alProgresar?.(indice + 1, totalChunks);
  }

  return concatBytes(...partes);
}

/**
 * Descifra un blob completo.
 *
 * Cualquier fallo de autenticacion aborta con un error explicito. Nunca se
 * devuelven bytes a medio verificar: entregar un fichero parcialmente
 * descifrado como si fuera bueno es peor que no entregar nada, porque el
 * usuario creeria que su clave privada esta corrupta cuando en realidad
 * esta intacta.
 */
export async function decryptBlob(blob: Uint8Array, dek: CryptoKey): Promise<Uint8Array> {
  const { chunkSize, nonceBase, header } = parseHeader(blob);

  const cuerpo = blob.subarray(HEADER_BYTES);
  const chunkCifrado = chunkSize + GCM_TAG_BYTES;
  const totalChunks = Math.ceil(cuerpo.length / chunkCifrado);

  if (totalChunks === 0) {
    throw new BlobFormatError('El blob no contiene ningun chunk.');
  }

  const trozos: Uint8Array[] = [];

  for (let indice = 0; indice < totalChunks; indice++) {
    const trozo = cuerpo.subarray(indice * chunkCifrado, (indice + 1) * chunkCifrado);
    const esUltimo = indice === totalChunks - 1;

    let claro: ArrayBuffer;
    try {
      claro = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: toBuffer(buildNonce(nonceBase, indice)),
          additionalData: toBuffer(buildAad(header, indice, esUltimo)),
        },
        dek,
        toBuffer(trozo),
      );
    } catch {
      // El mensaje no distingue entre clave incorrecta, bit corrompido,
      // chunk reordenado o fichero truncado a proposito: todos son "estos
      // bytes no son de fiar" y detallarlo solo ayudaria a quien sondea.
      throw new BlobFormatError(
        `Fallo la verificacion del chunk ${indice}: el fichero esta corrupto o manipulado.`,
      );
    }

    trozos.push(new Uint8Array(claro));
  }

  return removePadding(concatBytes(...trozos));
}

function buildHeader(chunkSize: number, nonceBase: Uint8Array): Uint8Array {
  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC, 0);
  header[MAGIC.length] = FORMAT_VERSION;
  new DataView(header.buffer).setUint32(MAGIC.length + 1, chunkSize, false);
  header.set(nonceBase, MAGIC.length + 1 + 4);
  return header;
}

function parseHeader(blob: Uint8Array): {
  chunkSize: number;
  nonceBase: Uint8Array;
  header: Uint8Array;
} {
  if (blob.length < HEADER_BYTES) {
    throw new BlobFormatError('El blob es mas corto que su propia cabecera.');
  }

  const header = blob.subarray(0, HEADER_BYTES);

  for (let i = 0; i < MAGIC.length; i++) {
    if (header[i] !== MAGIC[i]) {
      throw new BlobFormatError('Estos bytes no son un blob del Locker.');
    }
  }

  const version = header[MAGIC.length];
  if (version !== FORMAT_VERSION) {
    // Aqui es donde entraria la migracion el dia que cambie el formato. Por
    // eso el byte de version existe desde el primer fichero guardado: sin el,
    // cambiar de algoritmo dejaria la boveda vieja ilegible para siempre.
    throw new BlobFormatError(
      `Version de formato ${String(version)} desconocida (esta version entiende la ${FORMAT_VERSION}).`,
    );
  }

  const vista = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const chunkSize = vista.getUint32(MAGIC.length + 1, false);

  if (chunkSize === 0) {
    throw new BlobFormatError('La cabecera declara un tamano de chunk de cero.');
  }

  return {
    chunkSize,
    nonceBase: header.subarray(MAGIC.length + 1 + 4),
    header,
  };
}

/**
 * Nonce = nonceBase (8 B) || contador de chunk (4 B BE).
 *
 * El contador NO es opcional ni puede ser aleatorio: repetir un nonce con la
 * misma clave en GCM revela el XOR de los dos textos planos y permite forjar
 * mensajes. Derivarlo del indice garantiza que jamas se repite dentro de un
 * fichero, y el nonceBase aleatorio que no se repita entre ficheros.
 */
function buildNonce(nonceBase: Uint8Array, indice: number): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce.set(nonceBase, 0);
  new DataView(nonce.buffer).setUint32(NONCE_BASE_BYTES, indice, false);
  return nonce;
}

/**
 * Datos autenticados: cabecera || indice || esUltimo.
 *
 * Incluir el indice impide reordenar chunks. Incluir esUltimo impide el
 * ataque de truncado: cortar el fichero por la mitad haria que el ultimo
 * chunk restante se autenticara como "no ultimo" y la verificacion falle.
 * Incluir la cabecera ata los chunks a ESTE fichero, e impide mezclar chunks
 * de dos blobs cifrados con la misma clave.
 */
function buildAad(header: Uint8Array, indice: number, esUltimo: boolean): Uint8Array {
  const extra = new Uint8Array(5);
  new DataView(extra.buffer).setUint32(0, indice, false);
  extra[4] = esUltimo ? 1 : 0;
  return concatBytes(header, extra);
}

function addPadding(plaintext: Uint8Array): Uint8Array {
  const conPrefijo = LENGTH_PREFIX_BYTES + plaintext.length;
  const total = Math.ceil(conPrefijo / PADDING_BLOCK) * PADDING_BLOCK;

  // Relleno aleatorio y no ceros: cuesta lo mismo y mantiene el texto plano
  // uniforme si algun dia se analizara el blob por otro flanco.
  const salida = randomBytes(total);
  new DataView(salida.buffer).setUint32(0, plaintext.length, false);
  salida.set(plaintext, LENGTH_PREFIX_BYTES);
  return salida;
}

function removePadding(padded: Uint8Array): Uint8Array {
  if (padded.length < LENGTH_PREFIX_BYTES) {
    throw new BlobFormatError('El texto descifrado no llega ni al prefijo de longitud.');
  }

  const vista = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const longitud = vista.getUint32(0, false);

  if (LENGTH_PREFIX_BYTES + longitud > padded.length) {
    throw new BlobFormatError('La longitud declarada no cabe en el contenido descifrado.');
  }

  return padded.slice(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + longitud);
}
