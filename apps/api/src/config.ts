import { randomBytes } from 'node:crypto';

import { DEFAULT_LIMITS } from '@locker/shared';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`La variable ${name} no es un entero valido: ${raw}`);
  }
  return parsed;
}

const isProduction = process.env['NODE_ENV'] === 'production';

/**
 * Secreto del servidor para los salt falsos de emails inexistentes.
 *
 * En produccion es obligatorio: si cambiara entre reinicios, el salt devuelto
 * para un email inexistente cambiaria con el, y comparar dos respuestas
 * separadas por un reinicio revelaria que esa cuenta no existe -- justo la
 * fuga que este mecanismo tapa.
 *
 * En desarrollo se genera uno al vuelo para no obligar a configurar nada.
 */
function leerPepper(): string {
  const valor = process.env['SALT_PEPPER'];

  if (valor === undefined || valor === '') {
    if (isProduction) {
      throw new Error(
        'SALT_PEPPER es obligatoria en produccion. Genera una con: openssl rand -base64 32',
      );
    }
    return randomBytes(32).toString('base64');
  }

  return valor;
}

/**
 * Hash senuelo contra el que verificar cuando el email no existe.
 *
 * Sirve para que el login tarde lo mismo exista el usuario o no: sin esto,
 * un email inexistente responderia al instante y uno real tras el Argon2id,
 * y esa diferencia de tiempo dice quien tiene cuenta.
 *
 * Es un hash real de un valor aleatorio, asi que ninguna authKey lo cumple.
 */
const HASH_SENUELO =
  '$argon2id$v=19$m=19456,t=2,p=1$c2VudWVsby1uby1jb2luY2lkZQ$3E4dGVpc3RvSGFzaE5vQ29pbmNpZGVOdW5jYQ';

/**
 * Clave con la que se cifra el secreto TOTP en la base de datos.
 *
 * Vive en el .env del servidor y NUNCA en la BD: quien vuelque la base sin
 * tener tambien el .env no puede generar codigos. Si se pierde, el segundo
 * factor deja de validar y hay que volver a configurarlo (los ficheros NO se
 * ven afectados: esto no cifra nada de la boveda).
 */
function leerClaveTotp(): Buffer {
  const valor = process.env['TOTP_KEY'];

  if (valor === undefined || valor === '') {
    if (isProduction) {
      throw new Error(
        'TOTP_KEY es obligatoria en produccion. Genera una con: openssl rand -base64 32',
      );
    }
    return randomBytes(32);
  }

  const clave = Buffer.from(valor, 'base64');
  if (clave.length !== 32) {
    throw new Error(`TOTP_KEY debe ser de 32 bytes en base64 (tiene ${String(clave.length)}).`);
  }
  return clave;
}

/**
 * Configuracion SMTP para los avisos de intentos de acceso (DRAPPS-1058).
 *
 * Opcional: si no esta, la app funciona igual y simplemente no avisa. Un
 * aviso que no se puede mandar nunca debe impedir entrar en la boveda.
 */
function leerSmtp(): {
  host: string;
  port: number;
  user: string;
  pass: string;
  destinoAvisos: string;
} | null {
  const host = process.env['SMTP_HOST'];
  const user = process.env['SMTP_USER'];
  const pass = process.env['SMTP_PASS'];
  const destino = process.env['AVISO_DESTINO'];

  if (!host || !user || !pass || !destino) {
    return null;
  }

  return { host, port: envInt('SMTP_PORT', 587), user, pass, destinoAvisos: destino };
}

export const config = {
  port: envInt('PORT', 3000),
  host: process.env['HOST'] ?? '0.0.0.0',
  /** Directorio del fichero SQLite. Volumen `locker_data` en produccion. */
  dbDir: process.env['DB_DIR'] ?? './data/db',
  /** Directorio de los blobs cifrados. Volumen `locker_blobs` en produccion. */
  blobsDir: process.env['BLOBS_DIR'] ?? './data/blobs',
  maxFileSizeBytes: envInt('MAX_FILE_SIZE', DEFAULT_LIMITS.maxFileSizeBytes),
  /**
   * Detras del reverse proxy, sin esto `request.ip` seria siempre
   * 127.0.0.1 y el rate limit por IP no serviria de nada (DRAPPS-1043).
   */
  trustProxy: process.env['TRUST_PROXY'] !== 'false',
  isProduction,
  /**
   * Directorio de los estaticos ya compilados. Null en desarrollo, donde los
   * sirve Vite con hot reload.
   */
  webDist: process.env['WEB_DIST'] ?? null,
  saltPepper: leerPepper(),
  hashSenuelo: HASH_SENUELO,
  totpKey: leerClaveTotp(),
  smtp: leerSmtp(),
} as const;
