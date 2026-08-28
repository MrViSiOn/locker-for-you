import { encryptBlob } from '@locker/crypto';

import type { PeticionDeCifrado, RespuestaDeCifrado } from './cifrador.worker.js';

/**
 * Reparto del cifrado entre workers.
 *
 * Se mantiene un grupo pequeño de workers reutilizados en vez de crear uno
 * por fichero: arrancar un worker cuesta cargar y compilar el módulo entero,
 * y al subir veinte ficheros ese coste se pagaría veinte veces.
 *
 * SIEMPRE HAY PLAN B: si el navegador no admite workers de módulo o se niega
 * a clonar la `CryptoKey`, se cifra en el hilo principal. Sale una interfaz
 * que se atasca un momento, pero el fichero se guarda. Renunciar a subir
 * porque no hay worker sería cambiar una molestia por una avería.
 */

/** Uno por hueco de la cola de subidas: más workers no cifrarían más rápido. */
const MAXIMO_DE_WORKERS = 3;

interface Pendiente {
  resolver: (cifrado: Uint8Array) => void;
  rechazar: (error: Error) => void;
  alProgresar: ((fraccion: number) => void) | undefined;
}

interface Obrero {
  worker: Worker;
  ocupado: boolean;
  pendientes: Map<number, Pendiente>;
}

const obreros: Obrero[] = [];
const esperando: (() => void)[] = [];

let siguienteId = 1;
let workersDescartados = false;

function crearObrero(): Obrero | null {
  if (workersDescartados) {
    return null;
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL('./cifrador.worker.js', import.meta.url), { type: 'module' });
  } catch {
    workersDescartados = true;
    return null;
  }

  const obrero: Obrero = { worker, ocupado: false, pendientes: new Map() };

  worker.onmessage = (evento: MessageEvent<RespuestaDeCifrado>) => {
    const respuesta = evento.data;
    const pendiente = obrero.pendientes.get(respuesta.id);
    if (pendiente === undefined) {
      return;
    }

    if (respuesta.tipo === 'progreso') {
      pendiente.alProgresar?.(respuesta.total === 0 ? 1 : respuesta.hechos / respuesta.total);
      return;
    }

    obrero.pendientes.delete(respuesta.id);
    obrero.ocupado = false;
    liberar();

    if (respuesta.tipo === 'hecho') {
      pendiente.resolver(new Uint8Array(respuesta.cifrado));
    } else {
      pendiente.rechazar(new Error(respuesta.mensaje));
    }
  };

  // Un worker que revienta deja sus subidas colgadas para siempre si no se
  // rechazan aquí: no hay ningún otro mensaje que vaya a llegar.
  worker.onerror = () => {
    for (const pendiente of obrero.pendientes.values()) {
      pendiente.rechazar(new Error('El proceso de cifrado se interrumpió.'));
    }
    obrero.pendientes.clear();
    obrero.ocupado = false;
    liberar();
  };

  obreros.push(obrero);
  return obrero;
}

function liberar(): void {
  esperando.shift()?.();
}

async function pedirObrero(): Promise<Obrero | null> {
  const libre = obreros.find((o) => !o.ocupado);
  if (libre !== undefined) {
    libre.ocupado = true;
    return libre;
  }

  if (obreros.length < MAXIMO_DE_WORKERS) {
    const nuevo = crearObrero();
    if (nuevo === null) {
      return null;
    }
    nuevo.ocupado = true;
    return nuevo;
  }

  await new Promise<void>((resolver) => esperando.push(resolver));
  return pedirObrero();
}

/**
 * Cifra un contenido, en otro hilo si se puede.
 *
 * `contenido` se transfiere al worker, así que el `Uint8Array` que se pasa
 * queda inutilizable al volver. Es intencionado: el texto plano deja de
 * existir en este hilo en cuanto sale hacia el cifrado.
 */
export async function cifrarContenido(
  contenido: Uint8Array,
  dek: CryptoKey,
  alProgresar?: (fraccion: number) => void,
): Promise<Uint8Array> {
  // La comprobación va ANTES de tocar el contenido, y a propósito: si se
  // descubriera el fallo al mandar el mensaje, el buffer ya podría haberse
  // transferido y el plan B se encontraría un array vacío. Clonar la clave
  // no cuesta nada al lado de cifrar.
  if (!clonaClaves(dek)) {
    descartarWorkers();
    return cifrarAqui(contenido, dek, alProgresar);
  }

  const obrero = await pedirObrero();

  if (obrero === null) {
    return cifrarAqui(contenido, dek, alProgresar);
  }

  const id = siguienteId++;

  return new Promise<Uint8Array>((resolver, rechazar) => {
    obrero.pendientes.set(id, { resolver, rechazar, alProgresar });

    // El buffer se TRANSFIERE, no se copia: con ficheros grandes, clonarlo
    // duplicaría la memoria y añadiría al hilo principal justo la pausa que
    // este worker viene a evitar. El texto plano deja de existir aquí.
    const peticion: PeticionDeCifrado = { id, dek, contenido: bufferPropio(contenido) };

    try {
      obrero.worker.postMessage(peticion, [peticion.contenido]);
    } catch (fallo) {
      obrero.pendientes.delete(id);
      obrero.ocupado = false;
      liberar();
      rechazar(fallo instanceof Error ? fallo : new Error('No se pudo cifrar el fichero.'));
    }
  });
}

/**
 * ¿Sabe este navegador clonar una `CryptoKey`?
 *
 * Es lo único del mensaje que no está garantizado: los buffers se clonan en
 * todas partes. El resultado no se cachea entre claves porque la respuesta
 * depende del navegador, no de la clave, y `descartarWorkers()` ya se
 * encarga de no volver a preguntar.
 */
function clonaClaves(dek: CryptoKey): boolean {
  try {
    structuredClone(dek);
    return true;
  } catch {
    return false;
  }
}

/** El buffer exacto del array, copiándolo solo si comparte sitio con otros. */
function bufferPropio(datos: Uint8Array): ArrayBuffer {
  if (datos.byteOffset === 0 && datos.byteLength === datos.buffer.byteLength) {
    return datos.buffer as ArrayBuffer;
  }
  return datos.slice().buffer as ArrayBuffer;
}

function descartarWorkers(): void {
  workersDescartados = true;
  for (const obrero of obreros) {
    obrero.worker.terminate();
  }
  obreros.length = 0;
  while (esperando.length > 0) {
    liberar();
  }
}

function cifrarAqui(
  contenido: Uint8Array,
  dek: CryptoKey,
  alProgresar?: (fraccion: number) => void,
): Promise<Uint8Array> {
  return encryptBlob(contenido, dek, undefined, (hechos, total) => {
    alProgresar?.(total === 0 ? 1 : hechos / total);
  });
}
