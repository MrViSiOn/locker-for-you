import { decryptBlob, decryptName, unwrapDek } from '@locker/crypto';
import type { NodeDto } from '@locker/shared';
import { downloadZip } from 'client-zip';

import { ficheros, nodos } from '../api/cliente.js';
import { exigirBoveda } from './boveda.js';

/**
 * Descarga en bloque como ZIP.
 *
 * AQUI ES DONDE EL MODELO E2EE CAMBIA LA ARQUITECTURA: el ZIP no se puede
 * generar en el servidor, porque el servidor no puede descifrar nada. Se
 * arma entero en el navegador, descifrando fichero a fichero.
 *
 * Se usa `client-zip` y NO JSZip: JSZip acumula todo en memoria y con una
 * carpeta grande tumba la pestana. client-zip trabaja sobre streams.
 */

export interface ProgresoDelZip {
  hechos: number;
  total: number;
  /** Nombre del fichero que se esta procesando ahora. */
  actual: string;
  /** Los que no se pudieron descifrar. Se listan al final, no abortan. */
  fallidos: string[];
}

/** Aviso a partir del cual conviene preguntar antes de empezar. */
export const FICHEROS_PARA_AVISAR = 50;

interface EntradaDelZip {
  ruta: string;
  nodo: NodeDto;
}

/**
 * Recorre el subarbol y compone las rutas relativas descifradas.
 *
 * Las rutas se construyen DESPUES de descifrar los nombres: el servidor
 * devuelve la estructura, pero no sabe como se llama nada de lo que hay
 * dentro.
 */
async function componerEntradas(
  raiz: NodeDto,
  todos: readonly NodeDto[],
): Promise<EntradaDelZip[]> {
  const vault = exigirBoveda();

  const porPadre = new Map<string | null, NodeDto[]>();
  for (const nodo of todos) {
    const hermanos = porPadre.get(nodo.parentId) ?? [];
    hermanos.push(nodo);
    porPadre.set(nodo.parentId, hermanos);
  }

  const entradas: EntradaDelZip[] = [];

  async function recorrer(nodo: NodeDto, prefijo: string): Promise<void> {
    let nombre: string;
    try {
      nombre = await decryptName(nodo.nameEncrypted, vault.nameKey);
    } catch {
      // Un nombre ilegible no puede abortar el ZIP entero: se le da uno
      // reconocible y el usuario decide que hacer con el.
      nombre = `ilegible-${nodo.id.slice(0, 8)}`;
    }

    const ruta = prefijo === '' ? nombre : `${prefijo}/${nombre}`;

    if (nodo.kind === 'file') {
      entradas.push({ ruta, nodo });
      return;
    }

    for (const hijo of porPadre.get(nodo.id) ?? []) {
      await recorrer(hijo, ruta);
    }
  }

  await recorrer(raiz, '');
  return entradas;
}

/**
 * Descarga una carpeta entera como ZIP.
 *
 * Un fichero que falle la verificacion NO aborta el resto: se anota y se
 * sigue. Perder los 40 ficheros buenos porque uno esta corrupto seria
 * bastante peor que entregar 40 y avisar del que falta.
 */
export async function descargarCarpetaComoZip(
  carpetaId: string,
  nombreDelZip: string,
  alProgresar?: (progreso: ProgresoDelZip) => void,
): Promise<{ incluidos: number; fallidos: string[] }> {
  const vault = exigirBoveda();

  const { nodes } = await nodos.subarbol(carpetaId);
  const raiz = nodes.find((n) => n.id === carpetaId);
  if (raiz === undefined) {
    throw new Error('La carpeta no existe.');
  }

  const entradas = await componerEntradas(raiz, nodes);
  const fallidos: string[] = [];
  const archivos: { name: string; input: Uint8Array }[] = [];

  for (const [indice, entrada] of entradas.entries()) {
    alProgresar?.({
      hechos: indice,
      total: entradas.length,
      actual: entrada.ruta,
      fallidos: [...fallidos],
    });

    try {
      if (entrada.nodo.wrappedDek === null) {
        throw new Error('sin clave');
      }

      const cifrado = await ficheros.descargar(entrada.nodo.id);
      const dek = await unwrapDek(vault, entrada.nodo.wrappedDek);

      archivos.push({ name: entrada.ruta, input: await decryptBlob(cifrado, dek) });
    } catch {
      fallidos.push(entrada.ruta);
    }
  }

  alProgresar?.({
    hechos: entradas.length,
    total: entradas.length,
    actual: '',
    fallidos: [...fallidos],
  });

  // Los nombres dentro del ZIP van en claro, y es correcto: para cuando el
  // ZIP existe, ya esta en la maquina del usuario.
  const blob = await downloadZip(archivos).blob();

  const url = URL.createObjectURL(blob);
  const enlace = document.createElement('a');
  enlace.href = url;
  enlace.download = nombreDelZip.endsWith('.zip') ? nombreDelZip : `${nombreDelZip}.zip`;
  enlace.click();
  URL.revokeObjectURL(url);

  return { incluidos: archivos.length, fallidos };
}

/**
 * Descarga una seleccion suelta de ficheros como ZIP, sin estructura de
 * carpetas: van todos a la raiz del comprimido.
 *
 * Si dos ficheros de carpetas distintas comparten nombre, el segundo recibe
 * un sufijo. Sin eso, uno pisaria al otro dentro del ZIP y el usuario se
 * llevaria menos ficheros de los que pidio, sin enterarse.
 */
export async function descargarSeleccionComoZip(
  seleccion: readonly { id: string; nombre: string; wrappedDek: string | null }[],
  nombreDelZip: string,
  alProgresar?: (progreso: ProgresoDelZip) => void,
): Promise<{ incluidos: number; fallidos: string[] }> {
  const vault = exigirBoveda();

  const fallidos: string[] = [];
  const archivos: { name: string; input: Uint8Array }[] = [];
  const usados = new Set<string>();

  for (const [indice, elemento] of seleccion.entries()) {
    alProgresar?.({
      hechos: indice,
      total: seleccion.length,
      actual: elemento.nombre,
      fallidos: [...fallidos],
    });

    try {
      if (elemento.wrappedDek === null) {
        throw new Error('sin clave');
      }

      const cifrado = await ficheros.descargar(elemento.id);
      const dek = await unwrapDek(vault, elemento.wrappedDek);

      archivos.push({
        name: nombreUnico(elemento.nombre, usados),
        input: await decryptBlob(cifrado, dek),
      });
    } catch {
      fallidos.push(elemento.nombre);
    }
  }

  alProgresar?.({
    hechos: seleccion.length,
    total: seleccion.length,
    actual: '',
    fallidos: [...fallidos],
  });

  const blob = await downloadZip(archivos).blob();

  const url = URL.createObjectURL(blob);
  const enlace = document.createElement('a');
  enlace.href = url;
  enlace.download = nombreDelZip.endsWith('.zip') ? nombreDelZip : `${nombreDelZip}.zip`;
  enlace.click();
  URL.revokeObjectURL(url);

  return { incluidos: archivos.length, fallidos };
}

function nombreUnico(nombre: string, usados: Set<string>): string {
  if (!usados.has(nombre)) {
    usados.add(nombre);
    return nombre;
  }

  const punto = nombre.lastIndexOf('.');
  const base = punto === -1 ? nombre : nombre.slice(0, punto);
  const extension = punto === -1 ? '' : nombre.slice(punto);

  let intento = 2;
  let candidato = `${base} (${String(intento)})${extension}`;
  while (usados.has(candidato)) {
    intento += 1;
    candidato = `${base} (${String(intento)})${extension}`;
  }

  usados.add(candidato);
  return candidato;
}
