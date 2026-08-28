/**
 * La lógica del árbol de carpetas de la barra lateral, sin React.
 *
 * Está separada del componente por una razón práctica: son cuatro reglas
 * pequeñas de las que depende que el árbol no entre en bucle ni pierda el
 * sitio, y aquí se pueden probar sin montar media aplicación.
 *
 * El árbol NO guarda el nombre de las carpetas ajenas al camino abierto: los
 * nombres viajan cifrados y solo se descifran al pedir el listado de una
 * carpeta, así que el árbol se construye desplegando, nunca de golpe.
 */

/** Un escalón del camino hasta la carpeta actual. La raíz tiene `id` nulo. */
export interface Migaja {
  readonly id: string | null;
  readonly nombre: string;
}

/** La bóveda entera: el escalón que siempre encabeza cualquier camino. */
export const RAIZ: Migaja = { id: null, nombre: 'Bóveda' };

/** Despliega lo plegado y pliega lo desplegado. */
export function alternar(expandidos: ReadonlySet<string>, id: string): Set<string> {
  const siguiente = new Set(expandidos);

  if (!siguiente.delete(id)) {
    siguiente.add(id);
  }

  return siguiente;
}

/**
 * Deja desplegadas todas las carpetas del camino indicado.
 *
 * Lo usa el árbol cuando la navegación viene del explorador: si alguien
 * entra en una carpeta con doble clic, el árbol tiene que abrirse hasta
 * ella o el usuario perdería de vista dónde está.
 *
 * DEVUELVE EL MISMO CONJUNTO SI NO HAY NADA QUE ABRIR, y eso no es un
 * detalle: el resultado se guarda en el estado de React desde un efecto que
 * depende de él. Un conjunto nuevo cada vez sería un repintado infinito.
 */
export function abrirCamino(
  expandidos: ReadonlySet<string>,
  ruta: readonly Migaja[],
): ReadonlySet<string> {
  const faltan = ruta.filter(
    (migaja): migaja is Migaja & { id: string } => migaja.id !== null && !expandidos.has(migaja.id),
  );

  if (faltan.length === 0) {
    return expandidos;
  }

  const siguiente = new Set(expandidos);
  for (const migaja of faltan) {
    siguiente.add(migaja.id);
  }

  return siguiente;
}

/** La carpeta donde está ahora el explorador: el último escalón del camino. */
export function carpetaActual(ruta: readonly Migaja[]): string | null {
  return ruta[ruta.length - 1]?.id ?? null;
}

/** Cierto si esa carpeta es un escalón del camino abierto (para resaltarla). */
export function estaEnElCamino(ruta: readonly Migaja[], id: string | null): boolean {
  return ruta.some((migaja) => migaja.id === id);
}

/** El camino que hay que abrir al pulsar `hijo` estando dentro de `camino`. */
export function caminoHacia(camino: readonly Migaja[], hijo: Migaja): Migaja[] {
  return [...camino, hijo];
}

/**
 * Las carpetas cuyo listado hay que volver a pedir tras un cambio.
 *
 * Solo las del camino abierto, y no todas las desplegadas: crear, renombrar,
 * mover o borrar ocurre siempre en la carpeta que se está mirando o en su
 * padre. Refrescar el árbol entero costaría una petición por rama abierta
 * cada vez que se navega, para enterarse de cambios que no ha habido.
 */
export function aRefrescar(
  ruta: readonly Migaja[],
  expandidos: ReadonlySet<string>,
): (string | null)[] {
  return ruta.filter((migaja) => migaja.id === null || expandidos.has(migaja.id)).map((m) => m.id);
}
