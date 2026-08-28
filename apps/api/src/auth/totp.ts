import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Segundo factor TOTP (RFC 6238).
 *
 * DECISION IMPORTANTE, distinta de lo que planteaba la issue: el secreto se
 * cifra con una clave DEL SERVIDOR y se valida EN EL SERVIDOR. NO con la
 * clave maestra del usuario.
 *
 * El motivo es que el 2FA existe precisamente para el caso en que la
 * contrasena ya esta comprometida. Si el secreto se cifrara con la MK, el
 * cliente tendria que descifrarlo y validar el codigo por su cuenta... pero
 * quien tenga la contrasena tiene la MK, y ademas puede hablar con la API
 * directamente sin pasar por nuestro JavaScript. Le bastaria con llamar al
 * endpoint diciendo "codigo correcto" para saltarse el factor entero.
 *
 * Un 2FA que el atacante puede autoafirmar no es un 2FA. Asi que se valida
 * en el servidor, y para que quien robe solo la base de datos no pueda
 * generar codigos, el secreto se guarda cifrado con una clave que vive en el
 * .env del servidor y nunca en la BD.
 *
 * Esto NO debilita el modelo E2EE: el secreto TOTP no sirve para descifrar
 * ni un solo fichero. Es una credencial de acceso, no una clave de cifrado.
 */

const PERIODO_SEGUNDOS = 30;
const DIGITOS = 6;

/** Tolerancia de +-1 periodo: cubre relojes ligeramente desfasados. */
const VENTANA = 1;

const ALFABETO_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Genera un secreto nuevo, en base32 como esperan las apps autenticadoras. */
export function generarSecretoTotp(): string {
  return aBase32(randomBytes(20));
}

/**
 * URI que se convierte en QR para Google Authenticator, Authy, 1Password...
 *
 * El emisor y la cuenta van escapados: un email con caracteres raros podria
 * romper la URI y dejar el QR ilegible.
 */
export function uriOtpauth(secreto: string, email: string, emisor = 'Locker DrApps'): string {
  const etiqueta = `${encodeURIComponent(emisor)}:${encodeURIComponent(email)}`;
  const parametros = new URLSearchParams({
    secret: secreto,
    issuer: emisor,
    algorithm: 'SHA1',
    digits: String(DIGITOS),
    period: String(PERIODO_SEGUNDOS),
  });

  return `otpauth://totp/${etiqueta}?${parametros.toString()}`;
}

/** Codigo TOTP para un contador dado. Expuesto para poder testearlo. */
export function codigoParaContador(secreto: string, contador: number): string {
  const clave = deBase32(secreto);

  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(contador));

  const hmac = createHmac('sha1', clave).update(buffer).digest();

  // Truncado dinamico del RFC 4226: los 4 bits bajos del ultimo byte dicen
  // desde donde leer los 4 bytes que forman el codigo.
  const offset = (hmac[hmac.length - 1] as number) & 0x0f;
  const binario =
    (((hmac[offset] as number) & 0x7f) << 24) |
    (((hmac[offset + 1] as number) & 0xff) << 16) |
    (((hmac[offset + 2] as number) & 0xff) << 8) |
    ((hmac[offset + 3] as number) & 0xff);

  return String(binario % 10 ** DIGITOS).padStart(DIGITOS, '0');
}

export function contadorActual(ahoraMs = Date.now()): number {
  return Math.floor(ahoraMs / 1000 / PERIODO_SEGUNDOS);
}

export interface ResultadoTotp {
  valido: boolean;
  /** Contador con el que coincidio. Se guarda para impedir la reutilizacion. */
  contador: number;
}

/**
 * Verifica un codigo dentro de la ventana de tolerancia.
 *
 * `ultimoContadorUsado` implementa el anti-replay: sin el, un codigo
 * interceptado seguiria valiendo durante sus 30 segundos, y quien lo hubiera
 * visto (por encima del hombro, en un log, en un historial) podria usarlo
 * antes que el usuario legitimo.
 */
export function verificarTotp(
  secreto: string,
  codigo: string,
  ultimoContadorUsado: number | null,
  ahoraMs = Date.now(),
): ResultadoTotp {
  const limpio = codigo.replace(/\s/g, '');
  if (!/^\d{6}$/.test(limpio)) {
    return { valido: false, contador: -1 };
  }

  const actual = contadorActual(ahoraMs);

  for (let salto = -VENTANA; salto <= VENTANA; salto++) {
    const contador = actual + salto;

    if (ultimoContadorUsado !== null && contador <= ultimoContadorUsado) {
      // Ya se uso este codigo o uno posterior: no se acepta de nuevo.
      continue;
    }

    if (igualesEnTiempoConstante(codigoParaContador(secreto, contador), limpio)) {
      return { valido: true, contador };
    }
  }

  return { valido: false, contador: -1 };
}

/**
 * Cifra el secreto con la clave del servidor.
 *
 * Formato: [nonce 12 B][ciphertext + tag 16 B], en base64. Asi quien vuelque
 * la base de datos se lleva bytes opacos y no puede generar codigos sin
 * tener tambien el .env del servidor.
 */
export function cifrarSecreto(secreto: string, claveServidor: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', claveServidor, nonce);
  const cifrado = Buffer.concat([cipher.update(secreto, 'utf8'), cipher.final()]);

  return Buffer.concat([nonce, cifrado, cipher.getAuthTag()]).toString('base64');
}

export function descifrarSecreto(cifradoBase64: string, claveServidor: Buffer): string {
  const bytes = Buffer.from(cifradoBase64, 'base64');

  const nonce = bytes.subarray(0, 12);
  const tag = bytes.subarray(bytes.length - 16);
  const cifrado = bytes.subarray(12, bytes.length - 16);

  const decipher = createDecipheriv('aes-256-gcm', claveServidor, nonce);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(cifrado), decipher.final()]).toString('utf8');
}

function igualesEnTiempoConstante(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');

  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return timingSafeEqual(bufferA, bufferB);
}

function aBase32(bytes: Buffer): string {
  let bits = 0;
  let valor = 0;
  let salida = '';

  for (const byte of bytes) {
    valor = (valor << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      salida += ALFABETO_BASE32[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    salida += ALFABETO_BASE32[(valor << (5 - bits)) & 31];
  }

  return salida;
}

function deBase32(texto: string): Buffer {
  let bits = 0;
  let valor = 0;
  const salida: number[] = [];

  for (const caracter of texto.replace(/=+$/, '').toUpperCase()) {
    const indice = ALFABETO_BASE32.indexOf(caracter);
    if (indice === -1) {
      throw new Error(`Caracter no valido en base32: ${caracter}`);
    }

    valor = (valor << 5) | indice;
    bits += 5;

    if (bits >= 8) {
      salida.push((valor >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(salida);
}
