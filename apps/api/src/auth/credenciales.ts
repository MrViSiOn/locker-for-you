import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { SALT_BYTES } from '@locker/crypto';
import { argon2id, argon2Verify } from 'hash-wasm';

/**
 * Verificacion de credenciales en el servidor.
 *
 * Lo unico que llega aqui es la `authKey`: 32 bytes derivados en el navegador
 * a partir de la contrasena. El servidor NUNCA ve la contrasena, ni la clave
 * maestra, ni nada con lo que descifrar un fichero.
 *
 * Aun asi la authKey se guarda hasheada con Argon2id y no en claro: quien
 * robara la base de datos con las authKey en claro podria suplantar al
 * usuario ante el servidor, aunque siguiera sin poder descifrar nada.
 */

/**
 * Parametros del hash del lado servidor. Mas suaves que los del navegador a
 * proposito: aqui el trabajo caro (los 64 MiB de Argon2id sobre la
 * contrasena) ya lo hizo el cliente, y lo que se hashea es una clave de
 * 32 bytes con entropia completa -- no una contrasena adivinable. Poner 64 MiB
 * tambien aqui solo serviria para convertir cada login en un ataque de
 * denegacion de servicio contra el propio servidor.
 */
const PARAMS_SERVIDOR = {
  parallelism: 1,
  iterations: 2,
  memorySize: 19456,
  hashLength: 32,
} as const;

export async function hashAuthKey(authKeyBase64: string): Promise<string> {
  return argon2id({
    password: authKeyBase64,
    salt: randomBytes(16),
    ...PARAMS_SERVIDOR,
    outputType: 'encoded',
  });
}

export async function verifyAuthKey(authKeyBase64: string, hash: string): Promise<boolean> {
  try {
    return await argon2Verify({ password: authKeyBase64, hash });
  } catch {
    // Un hash con formato invalido en la base de datos no debe tumbar el
    // login con un 500: se trata como credencial incorrecta.
    return false;
  }
}

/**
 * Salt falso pero DETERMINISTA para un email que no existe.
 *
 * Sin esto, `/auth/challenge` seria un enumerador de usuarios: devolver 404
 * para unos emails y un salt para otros dice exactamente quien tiene cuenta.
 * Con esto, cualquier email recibe un salt de aspecto normal, el cliente
 * deriva su authKey igual que siempre y el login falla despues, sin haber
 * revelado nada.
 *
 * Es determinista porque un salt aleatorio en cada peticion tambien delataria:
 * bastaria con preguntar dos veces y ver si cambia.
 *
 * SE TRUNCAN LOS BYTES, NO LA CADENA, y esa distincion no es cosmetica: fue
 * un agujero real, encontrado en la auditoria de DRAPPS-1054 sobre la
 * instalacion de produccion.
 *
 * Antes se hacia `.digest('base64').slice(0, 24)`, que corta el texto base64
 * de un SHA-256 a 24 caracteres SIN relleno. Un salt de verdad son 16 bytes,
 * que en base64 son 24 caracteres CON "==" al final. Resultado:
 *
 *   correo sin cuenta -> W/ttPySc6dVzjuGfCW4FRFj6
 *   correo con cuenta -> qz6Vv3RDB12Uvbc9Sexpfw==
 *
 * Bastaba mirar el final de la cadena para saber quien tiene cuenta, con una
 * sola peticion y sin intentar entrar. Tomando los primeros SALT_BYTES del
 * digest y codificandolos despues, el falso es indistinguible del real.
 */
export function saltFalso(email: string, pepper: string): string {
  return createHmac('sha256', pepper)
    .update(`salt-inexistente:${email.toLowerCase()}`)
    .digest()
    .subarray(0, SALT_BYTES)
    .toString('base64');
}

/** Compara dos cadenas en tiempo constante, para no filtrar nada por temporizacion. */
export function igualesEnTiempoConstante(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');

  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return timingSafeEqual(bufferA, bufferB);
}

export function nuevoId(): string {
  return randomBytes(16).toString('hex');
}

/** Token de sesion. 32 bytes: imposible de adivinar por fuerza bruta. */
export function nuevoTokenDeSesion(): string {
  return randomBytes(32).toString('base64url');
}
