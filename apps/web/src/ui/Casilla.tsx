import { color, espacio, fuente, texto } from './tokens.js';
import { radio } from './tokens.js';
import { IconoVisto } from './Iconos.js';

/**
 * Casilla de selección propia.
 *
 * La nativa se pinta con el estilo del sistema operativo y en un fondo negro
 * aparece como un cuadrado blanco que grita más que el nombre del fichero al
 * que acompaña. Esta usa los colores de la bóveda y se apaga hasta que se
 * marca.
 *
 * El input real sigue ahí, invisible pero presente: es lo que hace que el
 * teclado, el lector de pantalla y el clic sobre la etiqueta sigan
 * funcionando sin reimplementar nada.
 */
export function Casilla({
  marcada,
  alCambiar,
  etiqueta,
  conTexto = false,
}: {
  marcada: boolean;
  alCambiar: () => void;
  etiqueta: string;
  /**
   * Muestra la etiqueta al lado del cuadrado.
   *
   * Por defecto no se ve: en la tabla del explorador el texto visible es el
   * nombre del fichero y repetirlo seria ruido. Donde la casilla ES la
   * pregunta -- "entiendo que puedo perder mis ficheros" -- hay que verla, y
   * entonces todo el texto forma parte del area pulsable.
   */
  conTexto?: boolean;
}): React.JSX.Element {
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: conTexto ? 'flex-start' : 'center',
        justifyContent: conTexto ? 'flex-start' : 'center',
        gap: conTexto ? espacio.m : 0,
        width: conTexto ? 'auto' : '18px',
        height: conTexto ? 'auto' : '18px',
        cursor: 'pointer',
        position: 'relative',
      }}
    >
      <input
        type="checkbox"
        checked={marcada}
        onChange={alCambiar}
        aria-label={etiqueta}
        style={{
          position: 'absolute',
          opacity: 0,
          width: '100%',
          height: '100%',
          margin: 0,
          cursor: 'pointer',
        }}
      />

      <span
        aria-hidden="true"
        style={{
          width: '15px',
          height: '15px',
          flexShrink: 0,
          marginTop: conTexto ? '2px' : 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: marcada ? color.laton : 'transparent',
          border: `1px solid ${marcada ? color.laton : color.borde.fuerte}`,
          borderRadius: radio.s,
          color: '#17130c',
          transition: 'background 100ms ease, border-color 100ms ease',
        }}
      >
        {marcada && <IconoVisto tamano={11} />}
      </span>

      {conTexto && (
        <span
          style={{
            fontFamily: fuente.sans,
            fontSize: texto.cuerpo,
            color: color.tinta.media,
            lineHeight: 1.45,
          }}
        >
          {etiqueta}
        </span>
      )}
    </label>
  );
}
