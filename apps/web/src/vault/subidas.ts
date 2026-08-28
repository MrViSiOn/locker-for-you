import { validateName } from '@locker/crypto';
import { DEFAULT_LIMITS } from '@locker/shared';

import { ErrorDeRed, SubidaCancelada } from '../api/cliente.js';
import { crearCarpeta, listarCarpeta, subirFichero } from './operaciones.js';

/**
 * La cola de subidas.
 *
 * Vive fuera de React, en un módulo, por el mismo motivo que la bóveda: una
 * subida en curso no debe depender de que un componente siga montado. Si la
 * cola viviera en el estado de la pantalla, navegar a otra carpeta abortaría
 * lo que estuviera a medio subir.
 *
 * La interfaz se suscribe y repinta; la cola no sabe nada de React.
 */

export type FaseDeTarea = 'esperando' | 'cifrando' | 'subiendo' | 'hecha' | 'fallida' | 'cancelada';

export interface Tarea {
  readonly id: string;
  /** Nombre del fichero, ya sin la ruta. */
  readonly nombre: string;
  /** Carpetas por las que cuelga, cuando se arrastró una carpeta entera. */
  readonly ruta: readonly string[];
  readonly bytes: number;
  readonly fase: FaseDeTarea;
  /** Fracción 0..1. La primera barra. */
  readonly cifrado: number;
  /** Fracción 0..1. La segunda barra. */
  readonly subido: number;
  /** Motivo legible cuando `fase` es 'fallida'. */
  readonly motivo: string | null;
  /** Cuántas veces se ha reintentado ya por caída de red. */
  readonly intentos: number;
}

/** Un fichero con la ruta de carpetas que le corresponde dentro de la bóveda. */
export interface ArchivoConRuta {
  archivo: File;
  ruta: string[];
}

/**
 * Tres a la vez.
 *
 * Ni uno (desaprovecha la red mientras se cifra) ni diez (compiten por CPU
 * al cifrar, y veinte peticiones en vuelo no llegan antes: llegan todas
 * peor).
 */
const SIMULTANEAS = 3;

/** Solo se reintenta el fallo de red, y poco: no es una cola de reparto. */
const REINTENTOS = 2;

interface TareaInterna extends Tarea {
  archivo: File;
  parentId: string | null;
  aborto: AbortController;
}

let tareas: TareaInterna[] = [];
let enCurso = 0;

const oyentes = new Set<(tareas: readonly Tarea[]) => void>();

export function suscribirseALaCola(oyente: (tareas: readonly Tarea[]) => void): () => void {
  oyentes.add(oyente);
  oyente(tareas);
  return () => oyentes.delete(oyente);
}

function avisar(): void {
  const copia = tareas.map((t) => ({ ...t }));
  for (const oyente of oyentes) {
    oyente(copia);
  }
}

function actualizar(id: string, cambios: Partial<Tarea>): void {
  tareas = tareas.map((t) => (t.id === id ? { ...t, ...cambios } : t));
  avisar();
}

let contador = 0;

/**
 * Encola ficheros para subir a una carpeta.
 *
 * Devuelve una promesa que se resuelve cuando TODOS han terminado (bien o
 * mal), para que quien llame pueda recargar el listado una sola vez al
 * final en vez de una por fichero.
 */
export async function encolar(
  entradas: readonly ArchivoConRuta[],
  destino: string | null,
  alTerminarUno?: () => void,
): Promise<void> {
  // Las carpetas se crean ANTES de encolar nada: si se fueran creando sobre
  // la marcha, dos ficheros hermanos podrían crear la misma carpeta a la vez
  // y acabar en dos carpetas distintas con el mismo nombre.
  const carpetas = await prepararCarpetas(entradas, destino);
  const yaEstaban = await nombresPorCarpeta(entradas, destino, carpetas);

  const nuevas: TareaInterna[] = [];

  for (const entrada of entradas) {
    const parentId = carpetas.get(entrada.ruta.join('/')) ?? destino;
    const clave = entrada.ruta.join('/');
    const hermanos = yaEstaban.get(clave) ?? new Set<string>();

    const tarea: TareaInterna = {
      id: `subida-${String(++contador)}`,
      nombre: entrada.archivo.name,
      ruta: entrada.ruta,
      bytes: entrada.archivo.size,
      fase: 'esperando',
      cifrado: 0,
      subido: 0,
      motivo: null,
      intentos: 0,
      archivo: entrada.archivo,
      parentId,
      aborto: new AbortController(),
    };

    const problema = revisar(entrada.archivo, hermanos);
    if (problema !== null) {
      nuevas.push({ ...tarea, fase: 'fallida', motivo: problema });
      continue;
    }

    // Se apunta ya como ocupado para que dos ficheros con el mismo nombre
    // dentro de la misma tanda tampoco se pisen entre ellos.
    hermanos.add(entrada.archivo.name.toLocaleLowerCase('es'));
    yaEstaban.set(clave, hermanos);
    nuevas.push(tarea);
  }

  tareas = [...tareas, ...nuevas];
  avisar();

  // Los trabajadores que faltan para llegar al tope, contando los que ya
  // esten con una tanda anterior: encolar dos veces seguidas no debe
  // duplicar la concurrencia.
  const trabajadores = Math.max(0, Math.min(SIMULTANEAS - enCurso, nuevas.length));

  await Promise.all(Array.from({ length: trabajadores }, () => trabajar(alTerminarUno)));
}

/**
 * Comprobaciones que solo puede hacer el cliente.
 *
 * El servidor no ve los nombres, así que no puede detectar un duplicado ni
 * validar el nombre: si no se hace aquí, no se hace en ningún sitio.
 */
function revisar(archivo: File, hermanos: Set<string>): string | null {
  if (archivo.size > DEFAULT_LIMITS.maxFileSizeBytes) {
    const limite = Math.round(DEFAULT_LIMITS.maxFileSizeBytes / (1024 * 1024));
    return `Supera el límite de ${String(limite)} MB por fichero. Pártelo o súbelo comprimido.`;
  }

  if (hermanos.has(archivo.name.toLocaleLowerCase('es'))) {
    return 'Ya hay un fichero con este nombre en la carpeta de destino.';
  }

  try {
    validateName(archivo.name);
  } catch (fallo) {
    return fallo instanceof Error ? fallo.message : 'El nombre del fichero no es válido.';
  }

  return null;
}

async function trabajar(alTerminarUno?: () => void): Promise<void> {
  for (;;) {
    const siguiente = tareas.find((t) => t.fase === 'esperando');
    if (siguiente === undefined) {
      return;
    }

    enCurso += 1;
    actualizar(siguiente.id, { fase: 'cifrando' });

    try {
      await intentar(siguiente);
      actualizar(siguiente.id, { fase: 'hecha', cifrado: 1, subido: 1 });
      alTerminarUno?.();
    } catch (fallo) {
      if (fallo instanceof SubidaCancelada) {
        actualizar(siguiente.id, { fase: 'cancelada' });
      } else {
        actualizar(siguiente.id, {
          fase: 'fallida',
          motivo: fallo instanceof Error ? fallo.message : 'No se pudo subir el fichero.',
        });
      }
    } finally {
      enCurso -= 1;
    }
  }
}

/**
 * Un fichero, con reintentos ante caída de red.
 *
 * Solo se reintenta `ErrorDeRed`: una respuesta del servidor (413, 401,
 * 507...) es una decisión, no un accidente, y repetirla solo repite el
 * mismo rechazo mientras retiene el hueco de la cola.
 */
async function intentar(tarea: TareaInterna): Promise<void> {
  for (let intento = 0; ; intento++) {
    try {
      await subirFichero(tarea.archivo, tarea.parentId, {
        senal: tarea.aborto.signal,
        alCifrar: (fraccion) => {
          actualizar(tarea.id, { fase: 'cifrando', cifrado: fraccion });
        },
        alSubir: (fraccion) => {
          actualizar(tarea.id, { fase: 'subiendo', cifrado: 1, subido: fraccion });
        },
      });
      return;
    } catch (fallo) {
      if (!(fallo instanceof ErrorDeRed) || intento >= REINTENTOS) {
        throw fallo;
      }

      // Se vuelve a cifrar desde cero, y es correcto: el blob se manda de
      // una pieza, así que no hay nada a medias que continuar. Las barras
      // vuelven a su sitio para que se vea que empieza otra vez.
      // NO se vuelve a 'esperando': esa fase es la bandeja de la que
      // cualquier trabajador libre coge tarea, y el mismo fichero acabaria
      // subiendose dos veces. La tarea nunca suelta a quien la lleva.
      actualizar(tarea.id, {
        fase: 'cifrando',
        cifrado: 0,
        subido: 0,
        intentos: intento + 1,
      });

      await esperar(500 * (intento + 1));
    }
  }
}

function esperar(ms: number): Promise<void> {
  return new Promise((resolver) => setTimeout(resolver, ms));
}

/**
 * Crea las subcarpetas necesarias y devuelve el id de cada ruta.
 *
 * Se reutiliza lo que ya exista: arrastrar dos veces la misma carpeta no
 * debe dejar dos carpetas con el mismo nombre.
 */
async function prepararCarpetas(
  entradas: readonly ArchivoConRuta[],
  destino: string | null,
): Promise<Map<string, string | null>> {
  const rutas = new Set<string>();
  for (const entrada of entradas) {
    for (let i = 1; i <= entrada.ruta.length; i++) {
      rutas.add(entrada.ruta.slice(0, i).join('/'));
    }
  }

  const porRuta = new Map<string, string | null>([['', destino]]);

  // Ordenadas por profundidad: una carpeta no se puede crear antes que su
  // padre, y así cada nivel encuentra el suyo ya resuelto.
  for (const ruta of [...rutas].sort((a, b) => a.split('/').length - b.split('/').length)) {
    const trozos = ruta.split('/');
    const nombre = trozos[trozos.length - 1] as string;
    const padre = porRuta.get(trozos.slice(0, -1).join('/')) ?? destino;

    const existentes = await listarCarpeta(padre);
    const yaEsta = existentes.find(
      (n) =>
        n.kind === 'folder' && n.nombre.toLocaleLowerCase('es') === nombre.toLocaleLowerCase('es'),
    );

    porRuta.set(ruta, yaEsta?.id ?? (await crearCarpeta(padre, nombre)).id);
  }

  return porRuta;
}

/** Los nombres que ya ocupan cada carpeta de destino, para detectar choques. */
async function nombresPorCarpeta(
  entradas: readonly ArchivoConRuta[],
  destino: string | null,
  carpetas: Map<string, string | null>,
): Promise<Map<string, Set<string>>> {
  const claves = new Set(entradas.map((e) => e.ruta.join('/')));
  const porClave = new Map<string, Set<string>>();

  for (const clave of claves) {
    const parentId = carpetas.get(clave) ?? destino;
    const hay = await listarCarpeta(parentId);
    porClave.set(
      clave,
      new Set(hay.filter((n) => n.kind === 'file').map((n) => n.nombre.toLocaleLowerCase('es'))),
    );
  }

  return porClave;
}

/** Cancela una subida. El servidor descarta el temporal al cortarse. */
export function cancelar(id: string): void {
  const tarea = tareas.find((t) => t.id === id);
  if (tarea === undefined) {
    return;
  }

  if (tarea.fase === 'esperando') {
    actualizar(id, { fase: 'cancelada' });
    return;
  }

  tarea.aborto.abort();
}

/** Quita de la lista lo que ya no está en marcha. */
export function limpiarTerminadas(): void {
  tareas = tareas.filter(
    (t) => t.fase !== 'hecha' && t.fase !== 'cancelada' && t.fase !== 'fallida',
  );
  avisar();
}

export function hayCosasEnMarcha(): boolean {
  return enCurso > 0 || tareas.some((t) => t.fase === 'esperando');
}

/**
 * Saca los ficheros de un arrastre, entrando en las carpetas.
 *
 * Se usa `webkitGetAsEntry`, que pese al prefijo es lo que implementan todos
 * los navegadores actuales: es la única forma de ver el contenido de una
 * carpeta arrastrada. Sin esto, soltar una carpeta no aporta ni un fichero.
 */
export async function recogerDelArrastre(datos: DataTransfer): Promise<ArchivoConRuta[]> {
  const raices: FileSystemEntry[] = [];

  for (const elemento of Array.from(datos.items)) {
    if (elemento.kind !== 'file') {
      continue;
    }
    const entrada = elemento.webkitGetAsEntry();
    if (entrada !== null) {
      raices.push(entrada);
    }
  }

  // Sin soporte de entries (o al soltar algo que no son ficheros), queda la
  // lista plana: se pierde la estructura de carpetas, no los ficheros.
  if (raices.length === 0) {
    return Array.from(datos.files).map((archivo) => ({ archivo, ruta: [] }));
  }

  const recogidos: ArchivoConRuta[] = [];
  for (const raiz of raices) {
    await recorrer(raiz, [], recogidos);
  }
  return recogidos;
}

async function recorrer(
  entrada: FileSystemEntry,
  ruta: string[],
  recogidos: ArchivoConRuta[],
): Promise<void> {
  if (entrada.isFile) {
    const archivo = await new Promise<File | null>((resolver) => {
      (entrada as FileSystemFileEntry).file(resolver, () => {
        resolver(null);
      });
    });

    if (archivo !== null) {
      recogidos.push({ archivo, ruta });
    }
    return;
  }

  if (!entrada.isDirectory) {
    return;
  }

  const lector = (entrada as FileSystemDirectoryEntry).createReader();

  // readEntries devuelve como mucho 100 entradas por llamada y hay que
  // seguir pidiendo hasta que conteste con una tanda vacía. Leerlo una sola
  // vez es el fallo clásico aquí: una carpeta con 150 ficheros subiría 100.
  for (;;) {
    const tanda = await new Promise<FileSystemEntry[]>((resolver) => {
      lector.readEntries(resolver, () => {
        resolver([]);
      });
    });

    if (tanda.length === 0) {
      return;
    }

    for (const hija of tanda) {
      await recorrer(hija, [...ruta, entrada.name], recogidos);
    }
  }
}
