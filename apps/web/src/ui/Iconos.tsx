/**
 * Iconos del Locker.
 *
 * SVG en línea, trazo 1.5, rejilla de 20px y `currentColor`: así escalan sin
 * pixelarse y toman el color del texto que los acompaña, sin necesidad de
 * variantes por color.
 *
 * Nunca emoji: en una herramienta de custodia desentonan y además cada
 * sistema los dibuja distinto.
 */

interface PropsDeIcono {
  tamano?: number;
  className?: string;
}

function Svg({
  tamano = 20,
  children,
}: PropsDeIcono & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width={tamano}
      height={tamano}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconoCarpeta(props: PropsDeIcono): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M2.5 5.5a1 1 0 0 1 1-1h3.3l1.4 1.8h8.3a1 1 0 0 1 1 1v8.2a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z" />
    </Svg>
  );
}

/** Un documento con la esquina doblada. Sirve para cualquier fichero. */
export function IconoFichero(props: PropsDeIcono): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M11.5 2.5H5.2a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h9.6a1 1 0 0 0 1-1V6.8z" />
      <path d="M11.5 2.5v3.3a1 1 0 0 0 1 1h3.3" />
    </Svg>
  );
}

/** Llave: la contraseña maestra y todo lo que abre la bóveda. */
export function IconoLlave(props: PropsDeIcono): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="7" cy="7" r="3.2" />
      <path d="M9.3 9.3 16 16" />
      <path d="M13.4 13.4 15 11.8" />
      <path d="M15.2 15.2 16.8 13.6" />
    </Svg>
  );
}

/** Candado cerrado: la bóveda y lo que está a salvo. */
export function IconoCandado(props: PropsDeIcono): React.JSX.Element {
  return (
    <Svg {...props}>
      <rect x="4" y="8.6" width="12" height="8.4" rx="1" />
      <path d="M6.8 8.6V6.2a3.2 3.2 0 0 1 6.4 0v2.4" />
    </Svg>
  );
}

export function IconoSubir(props: PropsDeIcono): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M10 13.5V4.2" />
      <path d="M6.4 7.6 10 4l3.6 3.6" />
      <path d="M3.6 13v2.4a1 1 0 0 0 1 1h10.8a1 1 0 0 0 1-1V13" />
    </Svg>
  );
}

export function IconoDescargar(props: PropsDeIcono): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M10 4v9.3" />
      <path d="M6.4 9.7 10 13.3l3.6-3.6" />
      <path d="M3.6 13v2.4a1 1 0 0 0 1 1h10.8a1 1 0 0 0 1-1V13" />
    </Svg>
  );
}

export function IconoPapelera(props: PropsDeIcono): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M3.8 5.6h12.4" />
      <path d="M8 5.6V4.2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.4" />
      <path d="M5.3 5.6v10.2a1 1 0 0 0 1 1h7.4a1 1 0 0 0 1-1V5.6" />
      <path d="M8.4 8.8v4.8M11.6 8.8v4.8" />
    </Svg>
  );
}

export function IconoRestaurar(props: PropsDeIcono): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M3.6 10a6.4 6.4 0 1 0 1.9-4.5" />
      <path d="M3.4 3.4v3.4h3.4" />
    </Svg>
  );
}

export function IconoAjustes(props: PropsDeIcono): React.JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="2.4" />
      <path d="M10 2.6v2M10 15.4v2M17.4 10h-2M4.6 10h-2M15.2 4.8l-1.4 1.4M6.2 13.8l-1.4 1.4M15.2 15.2l-1.4-1.4M6.2 6.2 4.8 4.8" />
    </Svg>
  );
}

/** Ojo tachado: no hay vista previa, y es a propósito. */
export function IconoSinVista(props: PropsDeIcono): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M7.3 4.6A7.4 7.4 0 0 1 10 4.2c4 0 7 3.5 7.6 4.6a1 1 0 0 1 0 .9 12 12 0 0 1-2.3 2.7" />
      <path d="M12.6 15.1a7.6 7.6 0 0 1-2.6.45c-4 0-7-3.5-7.6-4.6a1 1 0 0 1 0-.9A12.6 12.6 0 0 1 5 6.9" />
      <path d="M8.3 8.3a2.4 2.4 0 0 0 3.4 3.4" />
      <path d="M3.2 3.2 16.8 16.8" />
    </Svg>
  );
}

/** Aviso. Para lo irreversible. */
export function IconoAviso(props: PropsDeIcono): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M10 3.4 2.9 15.6a1 1 0 0 0 .87 1.5h12.46a1 1 0 0 0 .87-1.5z" />
      <path d="M10 8v3.4" />
      <path d="M10 14.1v.05" />
    </Svg>
  );
}

export function IconoVisto(props: PropsDeIcono): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M4 10.4 8.2 14.6 16 6.8" />
    </Svg>
  );
}

export function IconoCruz(props: PropsDeIcono): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M5 5l10 10M15 5 5 15" />
    </Svg>
  );
}

export function IconoNuevaCarpeta(props: PropsDeIcono): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M2.5 5.5a1 1 0 0 1 1-1h3.3l1.4 1.8h8.3a1 1 0 0 1 1 1v3" />
      <path d="M2.5 5.5v10a1 1 0 0 0 1 1h6" />
      <path d="M14.4 11.6v5.2M11.8 14.2H17" />
    </Svg>
  );
}

/** Flecha de breadcrumb. */
export function IconoChevron(props: PropsDeIcono): React.JSX.Element {
  return (
    <Svg {...props}>
      <path d="M7.8 4.5 13.2 10l-5.4 5.5" />
    </Svg>
  );
}
