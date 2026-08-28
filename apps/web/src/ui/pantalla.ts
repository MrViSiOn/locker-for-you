import { useEffect, useState } from 'react';

/**
 * Ancho de la ventana, para adaptar la interfaz.
 *
 * POR QUE UN HOOK Y NO MEDIA QUERIES: toda esta interfaz se pinta con
 * `style={{...}}` inline, y un atributo `style` no admite `@media`. No es que
 * falten reglas CSS: es que no hay donde escribirlas. La alternativa seria
 * reescribir las pantallas a clases, que es un refactor mucho mayor y sin mas
 * ventaja que la teorica.
 *
 * El coste real de esto es un repintado al redimensionar, que ocurre cuando
 * alguien arrastra el borde de la ventana y no mientras usa la aplicacion.
 */

/**
 * Donde se rompe la tabla.
 *
 * No es un numero redondo de catalogo: es el ancho por debajo del cual las
 * cinco columnas del explorador dejan de caber sin que los nombres se
 * corten. La rejilla pide 30+26+150+176+44+44 px de columnas fijas mas los
 * huecos, y al nombre hay que dejarle sitio para ser legible.
 */
export const ANCHO_COMPACTO = 900;

/** Por debajo de esto no caben ni los botones con su texto. */
export const ANCHO_MINIMO = 560;

export type Tamano = 'ancho' | 'compacto' | 'minimo';

export function useTamanoDePantalla(): Tamano {
  const [tamano, setTamano] = useState<Tamano>(() => calcular(anchoActual()));

  useEffect(() => {
    function alCambiar(): void {
      setTamano(calcular(anchoActual()));
    }

    window.addEventListener('resize', alCambiar);
    // También al girar el móvil: en algunos navegadores el `resize` llega
    // antes de que las medidas nuevas estén disponibles.
    window.addEventListener('orientationchange', alCambiar);

    return () => {
      window.removeEventListener('resize', alCambiar);
      window.removeEventListener('orientationchange', alCambiar);
    };
  }, []);

  return tamano;
}

function anchoActual(): number {
  // `document.documentElement.clientWidth` y no `window.innerWidth`: el
  // segundo incluye la barra de desplazamiento, y con ella la interfaz se
  // adapta un poco tarde -- justo cuando el listado se llena, que es cuando
  // aparece la barra.
  return document.documentElement.clientWidth || window.innerWidth;
}

/**
 * El punto de corte, como funcion pura.
 *
 * Separada del hook a proposito: asi las decisiones de adaptacion se pueden
 * comprobar con tests, sin navegador de por medio. Lo que se rompe en una
 * pantalla estrecha no se descubre mirando -- se descubre cuando alguien lo
 * usa en el movil y no puede.
 */
export function tamanoParaAncho(ancho: number): Tamano {
  return calcular(ancho);
}

function calcular(ancho: number): Tamano {
  if (ancho < ANCHO_MINIMO) {
    return 'minimo';
  }
  if (ancho < ANCHO_COMPACTO) {
    return 'compacto';
  }
  return 'ancho';
}

/** Atajo: ¿hay que apretar la interfaz? */
export function esEstrecho(tamano: Tamano): boolean {
  return tamano !== 'ancho';
}

/**
 * Columnas del explorador segun el ancho.
 *
 * QUE SE CAE Y POR QUE: al encoger desaparece primero la fecha y despues el
 * tamano. Son contexto. Lo que NO se cae nunca es el nombre ni el boton de
 * descargar: en una boveda de claves el nombre ES la identidad del fichero, y
 * descargarlo es la unica forma de verlo. Una tabla sin nombres legibles no
 * sirve de nada, por muy bien alineada que este.
 */
export function columnasDelExplorador(tamano: Tamano): string {
  if (tamano === 'minimo') {
    // SIN CASILLA DE SELECCION, y es la renuncia mas discutible de aqui:
    // sirve para bajarse varios ficheros en un ZIP, que en un movil es un
    // caso raro. A cambio, el nombre gana los 38 px que ocupaba, y sin ellos
    // se queda en unos 147 px -- ni un "id_ed25519_produccion.pem" entero.
    //
    // Se puede seguir descargando fichero a fichero, que es lo que se hace
    // desde el telefono.
    //
    // icono · nombre · descargar · papelera
    return '26px minmax(0, 1fr) 38px 38px';
  }
  if (tamano === 'compacto') {
    return '30px 26px minmax(0, 1fr) 100px 40px 40px';
  }
  return '30px 26px minmax(0, 1fr) 150px 176px 44px 44px';
}

/**
 * Columnas de la papelera.
 *
 * Aqui lo que no se cae nunca es el nombre y los DIAS QUE QUEDAN: sin lo
 * segundo, la papelera es una lista de cosas borradas sin urgencia, y la
 * urgencia es justo su razon de ser.
 */
export function columnasDeLaPapelera(tamano: Tamano): string {
  if (tamano === 'minimo') {
    // icono · nombre · dias · acciones
    return '26px minmax(0, 1fr) 68px 76px';
  }
  if (tamano === 'compacto') {
    return '26px minmax(0, 1fr) 100px 92px 150px';
  }
  return '26px minmax(0, 1fr) 110px 130px 130px 210px';
}

/**
 * Margen lateral del contenido segun el ancho.
 *
 * En un movil cada pixel de margen sale del nombre del fichero, que es lo
 * unico que no se puede recortar. 26 px de aire a cada lado son elegantes en
 * un monitor y un lujo en 375.
 */
export function margenLateral(tamano: Tamano): string {
  if (tamano === 'minimo') {
    return '8px';
  }
  if (tamano === 'compacto') {
    return '12px';
  }
  return '26px';
}

/** Relleno lateral de las filas de una tabla. */
export function rellenoDeFila(tamano: Tamano): string {
  return tamano === 'minimo' ? '10px' : '18px';
}
