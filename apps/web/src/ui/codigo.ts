/**
 * Cuándo un código de un solo uso está entero.
 *
 * Vive aparte del formulario porque de esta respuesta dependen dos cosas
 * que conviene no equivocar: si el botón se puede pulsar y si el código se
 * manda solo, sin esperar a que nadie lo pulse.
 */

/** Los dígitos que tiene un código TOTP. No es configurable: lo fija el estándar. */
export const DIGITOS_DEL_CODIGO = 6;

/**
 * El código listo para mandar, o `null` si todavía no lo está.
 *
 * Quita los espacios de los lados porque pegar desde un gestor de
 * contraseñas o desde el móvil los arrastra a menudo, y EXIGE QUE SEAN SEIS
 * DÍGITOS: contar caracteres a secas daría por bueno un `12 34 5` de una
 * pulsación torpe y gastaría un intento contra el límite de reintentos.
 */
export function codigoParaEnviar(escrito: string): string | null {
  const limpio = escrito.trim();

  return new RegExp(`^\\d{${String(DIGITOS_DEL_CODIGO)}}$`, 'u').test(limpio) ? limpio : null;
}
