import type { UnlockedVault, VaultCredentials } from '@locker/crypto';

/**
 * Custodia de la clave maestra durante la sesion.
 *
 * La boveda abierta vive AQUI y solo aqui: en una variable de modulo, en
 * memoria. Nunca en localStorage ni en sessionStorage, que son legibles por
 * cualquier XSS y sobreviven al cierre de la pestana.
 *
 * CONSECUENCIA VISIBLE PARA EL USUARIO: al recargar la pagina (F5) la boveda
 * se cierra y hay que volver a escribir la contrasena, aunque la sesion del
 * servidor siga viva. No es un fallo -- es exactamente lo que hace que la
 * clave no se pueda robar de ningun sitio. La interfaz tiene que explicarlo
 * en vez de disimularlo.
 */

let abierta: UnlockedVault | null = null;

/**
 * Material de derivacion de la sesion en curso: salt, parametros y la clave
 * maestra ENVUELTA.
 *
 * Nada de esto es secreto -- el servidor lo tiene igual y lo entrega al
 * iniciar sesion -- pero se guarda aqui para no tener que volver a pedirlo
 * al cambiar la contrasena o regenerar el Emergency Kit, que son las dos
 * operaciones que necesitan reenvolver la clave maestra.
 *
 * Lo que NUNCA se guarda es la contrasena: se pide de nuevo cada vez que
 * hace falta desenvolver algo.
 */
let credenciales: VaultCredentials | null = null;

type Suscriptor = (abierta: boolean) => void;
const suscriptores = new Set<Suscriptor>();

function avisar(): void {
  for (const suscriptor of suscriptores) {
    suscriptor(abierta !== null);
  }
}

export function abrirBoveda(vault: UnlockedVault, material?: VaultCredentials): void {
  abierta = vault;
  credenciales = material ?? null;
  avisar();
}

/** Material de derivacion de la sesion, o null si se abrio sin el. */
export function credencialesDeLaBoveda(): VaultCredentials | null {
  return credenciales;
}

/** Tras cambiar la contrasena, el material viejo ya no vale. */
export function actualizarCredenciales(material: VaultCredentials): void {
  credenciales = material;
}

/**
 * Devuelve la boveda abierta o lanza.
 *
 * Lanza en vez de devolver null a proposito: cualquier operacion que necesite
 * la clave y se encuentre sin ella es un error de flujo, y fallar aqui con un
 * mensaje claro es mejor que arrastrar un null hasta la capa de cifrado y
 * reventar con algo incomprensible.
 */
export function exigirBoveda(): UnlockedVault {
  if (abierta === null) {
    throw new BovedaCerradaError();
  }
  return abierta;
}

export function bovedaAbierta(): boolean {
  return abierta !== null;
}

/**
 * Cierra la boveda: la clave maestra deja de estar en memoria.
 *
 * Es mas contundente que un "cerrar sesion": la sesion del servidor puede
 * seguir viva, pero sin la clave no se puede descifrar absolutamente nada.
 */
export function cerrarBoveda(): void {
  abierta = null;
  credenciales = null;
  avisar();
}

export function suscribirse(suscriptor: Suscriptor): () => void {
  suscriptores.add(suscriptor);
  return () => {
    suscriptores.delete(suscriptor);
  };
}

export class BovedaCerradaError extends Error {
  constructor() {
    super('La boveda esta cerrada. Vuelve a introducir tu contrasena maestra.');
    this.name = 'BovedaCerradaError';
  }
}
