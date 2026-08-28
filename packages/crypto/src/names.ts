import {
  base64ToBytes,
  bytesToBase64,
  concatBytes,
  randomBytes,
  utf8Decode,
  utf8Encode,
} from './encoding.js';
import { toBuffer } from './kdf.js';

/**
 * Cifrado de nombres de fichero y carpeta.
 *
 * Un fichero llamado `clave-ssh-produccion-banco.pem` filtra casi tanto como
 * su contenido: dice que existe, para que sirve y lo importante que es. Por
 * eso los nombres viajan y se almacenan cifrados, igual que los datos.
 *
 * Formato: [nonce 12 B][ciphertext + tag GCM 16 B], en base64.
 *
 * Consecuencias que hay que asumir, porque cambian como funciona la app:
 *
 *  - El servidor NO puede ordenar alfabeticamente ni buscar por nombre. La
 *    ordenacion y el filtrado se hacen en el cliente, sobre la carpeta ya
 *    descifrada.
 *  - El servidor NO puede detectar nombres duplicados. Se comprueba en el
 *    cliente antes de subir.
 *  - El mismo nombre cifrado dos veces da bytes distintos, porque cada uno
 *    lleva su propio nonce. Bien para la privacidad, pero impide usar el
 *    nombre cifrado como indice o clave unica.
 */

const NONCE_BYTES = 12;

/**
 * Los nombres se rellenan a multiplos de 64 bytes antes de cifrar.
 *
 * Sin relleno, la longitud del nombre cifrado delata la del original:
 * `id_rsa` (6) y `clave-banco-santander-produccion.pem` (36) se distinguirian
 * a simple vista, y la longitud sola ya insinua de que va cada fichero.
 *
 * 64 y no 32 porque casi todos los nombres reales caben en un solo bloque de
 * 62 bytes utiles, con lo que TODOS acaban ocupando lo mismo. Con bloques de
 * 32 los nombres de mas de 30 caracteres caian en un segundo bloque y volvian
 * a ser distinguibles de los cortos, que es justo lo que se quiere evitar.
 * El coste es de 64 bytes por nombre.
 *
 * Limitacion asumida: un nombre de mas de 62 bytes sigue siendo distinguible
 * de uno corto. Ocultarlo del todo obligaria a rellenar siempre a 255, y no
 * compensa.
 */
const NAME_PADDING_BLOCK = 64;

const LENGTH_PREFIX_BYTES = 2;

/** Limite de longitud, alineado con el de la mayoria de sistemas de ficheros. */
export const MAX_NAME_LENGTH = 255;

/**
 * Detecta caracteres de control (C0 y DEL).
 *
 * Se comprueba por codigo y no con una expresion regular a proposito: un
 * regex con estos caracteres obliga a escribirlos como literales, y un byte
 * de control dentro del fuente convierte el fichero en binario a ojos de
 * grep y de media herramienta de revision.
 */
function tieneCaracteresDeControl(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    const codigo = name.charCodeAt(i);
    if (codigo < 0x20 || codigo === 0x7f) {
      return true;
    }
  }
  return false;
}

export class InvalidNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidNameError';
  }
}

/**
 * Valida un nombre antes de cifrarlo.
 *
 * Esta comprobacion es la UNICA que hay: el servidor no puede validar lo que
 * no puede leer. Si un nombre como `../../.ssh/authorized_keys` llegara a
 * guardarse, reapareceria al descifrar y podria escaparse del directorio al
 * construir un ZIP o al escribir la descarga en disco.
 */
export function validateName(name: string): void {
  if (name.length === 0) {
    throw new InvalidNameError('El nombre no puede estar vacio.');
  }

  if (name.length > MAX_NAME_LENGTH) {
    throw new InvalidNameError(
      `El nombre supera los ${MAX_NAME_LENGTH} caracteres (tiene ${name.length}).`,
    );
  }

  if (name === '.' || name === '..') {
    throw new InvalidNameError('El nombre no puede ser "." ni "..".');
  }

  if (name.includes('/') || name.includes('\\')) {
    throw new InvalidNameError('El nombre no puede contener barras.');
  }

  // Invisibles al mirar el listado y capaces de enredar terminales y
  // cabeceras HTTP: un salto de linea en un nombre puede partir en dos una
  // cabecera Content-Disposition al descargar.
  if (tieneCaracteresDeControl(name)) {
    throw new InvalidNameError('El nombre no puede contener caracteres de control.');
  }

  // Un nombre que empieza o acaba en espacio se ve igual que otro que no, y
  // varios sistemas de ficheros lo recortan al descargar, con lo que dos
  // ficheros distintos acabarian pisandose.
  if (name !== name.trim()) {
    throw new InvalidNameError('El nombre no puede empezar ni acabar con espacios.');
  }
}

/** Cifra un nombre. Devuelve base64 listo para guardar. */
export async function encryptName(name: string, nameKey: CryptoKey): Promise<string> {
  validateName(name);

  const nonce = randomBytes(NONCE_BYTES);
  const relleno = addNamePadding(utf8Encode(name));

  const cifrado = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toBuffer(nonce) },
    nameKey,
    toBuffer(relleno),
  );

  return bytesToBase64(concatBytes(nonce, new Uint8Array(cifrado)));
}

/** Descifra un nombre. Lanza si fue manipulado o si la clave no es la suya. */
export async function decryptName(encrypted: string, nameKey: CryptoKey): Promise<string> {
  const bytes = base64ToBytes(encrypted);

  if (bytes.length <= NONCE_BYTES) {
    throw new InvalidNameError('El nombre cifrado esta incompleto.');
  }

  let claro: ArrayBuffer;
  try {
    claro = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBuffer(bytes.subarray(0, NONCE_BYTES)) },
      nameKey,
      toBuffer(bytes.subarray(NONCE_BYTES)),
    );
  } catch {
    throw new InvalidNameError('El nombre esta corrupto o fue cifrado con otra clave.');
  }

  const name = utf8Decode(removeNamePadding(new Uint8Array(claro)));

  // Se revalida al descifrar y no solo al cifrar: un nombre invalido en la
  // base de datos --de una version anterior, o metido a mano-- no debe llegar
  // hasta la capa que escribe ficheros en disco.
  validateName(name);

  return name;
}

/**
 * Ordena entradas por su nombre ya descifrado.
 *
 * Vive aqui porque es consecuencia directa del cifrado de nombres: el
 * servidor no puede ordenar lo que no lee, asi que el orden lo pone siempre
 * el cliente. `localeCompare` con `numeric` deja `clave2` antes que `clave10`,
 * que es lo que uno espera al mirar una lista.
 */
export function sortByName<T>(items: readonly T[], getName: (item: T) => string): T[] {
  return [...items].sort((a, b) =>
    getName(a).localeCompare(getName(b), 'es', { numeric: true, sensitivity: 'base' }),
  );
}

/** Comprueba si un nombre ya existe en la carpeta. El servidor no puede hacerlo. */
export function isDuplicateName(name: string, existentes: readonly string[]): boolean {
  const normalizado = name.normalize('NFC').toLocaleLowerCase('es');
  return existentes.some((otro) => otro.normalize('NFC').toLocaleLowerCase('es') === normalizado);
}

function addNamePadding(bytes: Uint8Array): Uint8Array {
  const conPrefijo = LENGTH_PREFIX_BYTES + bytes.length;
  const total = Math.ceil(conPrefijo / NAME_PADDING_BLOCK) * NAME_PADDING_BLOCK;

  const salida = randomBytes(total);
  new DataView(salida.buffer).setUint16(0, bytes.length, false);
  salida.set(bytes, LENGTH_PREFIX_BYTES);
  return salida;
}

function removeNamePadding(padded: Uint8Array): Uint8Array {
  if (padded.length < LENGTH_PREFIX_BYTES) {
    throw new InvalidNameError('El nombre descifrado no llega ni al prefijo de longitud.');
  }

  const vista = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const longitud = vista.getUint16(0, false);

  if (LENGTH_PREFIX_BYTES + longitud > padded.length) {
    throw new InvalidNameError('La longitud declarada no cabe en el nombre descifrado.');
  }

  return padded.slice(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + longitud);
}
