/**
 * Sistema de diseño del Locker.
 *
 * Los valores salen LITERALMENTE del canvas de diseño (`design/*.dc.html`),
 * no de redondearlos a una rejilla de 4/8px. Si algo aquí no cuadra con el
 * canvas, manda el canvas.
 *
 * La regla que ordena todo es tipográfica:
 *   MONO   = dato      (nombres de fichero, tamaños, fechas, la passphrase)
 *   SERIFA = la app habla  (aparece poco, y por eso pesa)
 *   SANS   = interfaz  (botones, etiquetas, navegación)
 *
 * Un nombre de fichero aquí es un identificador exacto, no una etiqueta: por
 * eso va en monoespaciada, como el resto de los datos.
 */

export const fuente = {
  /** La app habla. Titulares y los tres momentos irreversibles. */
  serifa: "'Instrument Serif', Georgia, 'Times New Roman', serif",
  /** Interfaz: botones, etiquetas, navegación. */
  sans: "'Archivo', system-ui, -apple-system, 'Segoe UI', sans-serif",
  /** Dato exacto: nombres, tamaños, fechas, IPs, passphrase. */
  mono: "'IBM Plex Mono', ui-monospace, 'SF Mono', Consolas, monospace",
} as const;

/** Escala tipográfica del canvas. Sin redondear. */
export const texto = {
  micro: '9.5px',
  menudo: '11.5px',
  auxiliar: '12.5px',
  cuerpo: '13.5px',
  destacado: '15px',
  subtitulo: '17px',
  titulo: '23px',
  granTitulo: '38px',
  display: '46px',
} as const;

/**
 * Color.
 *
 * El fondo es negro y la barra lateral lleva un degradado granate: decisión
 * de Dani sobre el canvas. Las superficies se rebajaron para acompañar al
 * negro -- las originales estaban pensadas para un grafito 0.155 y sobre
 * negro puro parecían flotar.
 */
export const color = {
  fondo: '#000000',
  /** Barra lateral. El granate es identidad, no estado. */
  lateral: 'linear-gradient(180deg, #4F1818, #000000)',

  /** Superficies, de menos a más presencia. */
  superficie: {
    tenue: 'oklch(0.105 0.007 78)',
    cabecera: 'oklch(0.118 0.007 78)',
    panel: 'oklch(0.138 0.008 78)',
    chip: 'oklch(0.158 0.008 78)',
  },

  borde: {
    sutil: 'oklch(0.165 0.008 78)',
    medio: 'oklch(0.185 0.009 78)',
    fuerte: 'oklch(0.205 0.009 78)',
  },

  tinta: {
    fuerte: 'oklch(0.94 0.006 88)',
    media: 'oklch(0.74 0.008 82)',
    tenue: 'oklch(0.575 0.010 82)',
  },

  /**
   * Los dos acentos comparten croma y luminosidad: solo cambia el tono. Eso
   * hace que convivan sin competir.
   */
  laton: 'oklch(0.72 0.115 75)',
  verdin: 'oklch(0.72 0.115 185)',

  /**
   * Destructivo y error.
   *
   * Convive con el granate del fondo porque el granate es muy oscuro
   * (L≈0.25) y este mucho más luminoso (L=0.62): no se confunden.
   */
  peligro: 'oklch(0.62 0.135 28)',

  /** La ÚNICA superficie clara de la app: el papel del Emergency Kit. */
  papel: 'oklch(0.955 0.008 85)',
  papelTinta: 'oklch(0.22 0.010 60)',
} as const;

/** Espaciado del canvas. */
export const espacio = {
  xs: '4px',
  s: '8px',
  m: '12px',
  l: '18px',
  xl: '26px',
  xxl: '40px',
} as const;

export const radio = {
  s: '2px',
  m: '3px',
  l: '4px',
} as const;

/**
 * Altura mínima de cualquier cosa que se pueda pulsar.
 *
 * 44px no es negociable: por debajo, en una pantalla táctil se falla el
 * objetivo y en una bóveda de claves un clic errado puede ser un borrado.
 */
export const objetivoTactil = '44px';

/** Ruido sutil de fondo. Da textura sin recurrir a un degradado. */
export const texturaRuido =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.055'/%3E%3C/svg%3E\")";

/**
 * Formatea un tamaño en bytes.
 *
 * Se muestra el tamaño EN DISCO, no el original, y por eso siempre sale un
 * múltiplo de 4 KB: es el relleno que oculta el tamaño real del fichero. En
 * vez de esconder ese detalle, la columna se llama "Tamaño en disco" y el
 * pie de la tabla lo explica.
 */
export function formatearTamano(bytes: number | null): string {
  if (bytes === null) {
    return '—';
  }
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

/** Fecha corta en castellano: "27 ago 2026". */
export function formatearFecha(iso: string): string {
  return new Date(iso).toLocaleDateString('es-ES', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
