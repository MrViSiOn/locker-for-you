/**
 * Contratos compartidos entre la API y el cliente web.
 *
 * Todo lo que aqui se llama `...Encrypted` viaja como base64 de bytes opacos:
 * el servidor los almacena y los devuelve, pero no puede interpretarlos.
 */

/** Parametros de derivacion de clave. Se versionan para poder subirlos sin romper cuentas existentes. */
export interface KdfParams {
  readonly version: number;
  /** Memoria en KiB. */
  readonly memoryKib: number;
  readonly iterations: number;
  readonly parallelism: number;
}

export const KDF_PARAMS_V1: KdfParams = {
  version: 1,
  memoryKib: 65536,
  iterations: 3,
  parallelism: 1,
};

export type NodeKind = 'folder' | 'file';

/** Un nodo del arbol tal y como lo devuelve la API: los nombres siguen cifrados. */
export interface NodeDto {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: NodeKind;
  /** base64 del nombre cifrado con AES-256-GCM. */
  readonly nameEncrypted: string;
  readonly blobId: string | null;
  /** base64 de la DEK envuelta con la MK. Null en carpetas. */
  readonly wrappedDek: string | null;
  /** Tamano del blob cifrado en disco, no el del fichero original. */
  readonly sizeBytes: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

/** Respuesta al challenge de login: lo que el cliente necesita para derivar sus claves. */
export interface AuthChallengeResponse {
  readonly kdfSalt: string;
  readonly kdfParams: KdfParams;
}

export interface ApiError {
  readonly error: string;
  readonly message: string;
}

/** Limites del servidor, expuestos para que el cliente valide antes de cifrar. */
export interface ServerLimits {
  readonly maxFileSizeBytes: number;
  readonly maxDepth: number;
}

export const DEFAULT_LIMITS: ServerLimits = {
  maxFileSizeBytes: 50 * 1024 * 1024,
  maxDepth: 32,
};

/**
 * Content-Security-Policy de la aplicacion.
 *
 * Vive en `shared` y no en el servidor por un motivo practico: el servidor de
 * desarrollo (Vite) sirve la pagina por su cuenta, asi que sin esto la CSP
 * solo existiria en produccion... y los fallos que provoca aparecerian el dia
 * del despliegue. Paso exactamente eso con Argon2id (ver 'wasm-unsafe-eval').
 * Con una sola definicion, lo que rompe en produccion rompe tambien en local.
 *
 * EN ESTA APP EL XSS ES EL FALLO TOTAL, no un fallo grave: cualquier
 * JavaScript que llegue a ejecutarse corre con la clave maestra en memoria y
 * puede sacarlo todo en claro sin tocar el servidor.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",

  // 'wasm-unsafe-eval' NO es 'unsafe-eval', y hace falta: Argon2id corre en
  // WebAssembly (hash-wasm) y compilarlo exige este permiso. Sin el la app NI
  // SIQUIERA DEJA ENTRAR. Solo autoriza compilar WebAssembly; `eval()` de
  // JavaScript sigue prohibido, que es lo que convierte texto inyectado en
  // codigo ejecutandose. La alternativa, Argon2 en JavaScript puro, pasa de
  // ~100 ms a varios segundos por inicio de sesion.
  "script-src 'self' 'wasm-unsafe-eval'",

  // 'unsafe-inline' aqui es deuda consciente: la interfaz se pinta con
  // `style={{...}}` de React, que la CSP trata como estilo inline. Quitarlo
  // exigiria reescribir todas las pantallas a clases. El CSS no ejecuta
  // codigo, y para abusar de el hay que poder inyectar marcado, que es justo
  // lo que impide la linea de arriba.
  "style-src 'self' 'unsafe-inline'",

  // Las fuentes se sirven desde el propio origen: ni Google ni ningun CDN.
  "font-src 'self'",

  // data: por los iconos SVG en linea, blob: por las descargas. Ninguno
  // ejecuta nada.
  "img-src 'self' data: blob:",

  // El navegador no puede hablar con nadie mas. Si algun dia entrara codigo
  // hostil, no tendria a donde mandar lo que robe.
  "connect-src 'self'",

  "object-src 'none'",
  // <base href> puede desviar rutas relativas a otro origen.
  "base-uri 'none'",
  "form-action 'self'",
  // Sin esto, cualquier sitio podria superponer su interfaz sobre la boveda.
  "frame-ancestors 'none'",
  // El worker de cifrado es local.
  "worker-src 'self' blob:",
].join('; ');

/** Cabeceras que acompanan a la CSP. Las mismas en produccion y en local. */
export const CABECERAS_DE_SEGURIDAD: Readonly<Record<string, string>> = {
  // Duplica frame-ancestors para navegadores que no leen la CSP.
  'X-Frame-Options': 'DENY',
  // Sin esto, algo servido como octet-stream puede acabar interpretado como
  // HTML por el navegador.
  'X-Content-Type-Options': 'nosniff',
  // Ni el dominio se filtra al salir: en una boveda personal, el propio hecho
  // de estar usandola ya es informacion sobre su dueno.
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
};
