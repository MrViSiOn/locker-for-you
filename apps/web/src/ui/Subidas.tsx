import { useEffect, useRef, useState } from 'react';

import {
  cancelar,
  limpiarTerminadas,
  suscribirseALaCola,
  type FaseDeTarea,
  type Tarea,
} from '../vault/subidas.js';
import { IconoAviso, IconoCruz, IconoLlave, IconoSubir, IconoVisto } from './Iconos.js';
import { useTamanoDePantalla, type Tamano } from './pantalla.js';
import { color, espacio, formatearTamano, fuente, radio, texto } from './tokens.js';

/**
 * La subida vista por el usuario.
 *
 * Dos barras y no una, con colores distintos, porque son dos cosas que le
 * importan de forma muy distinta: mientras avanza la primera (verdín), su
 * fichero está siendo cifrado y NO HA SALIDO NADA de su equipo; solo cuando
 * arranca la segunda (latón) empiezan a viajar bytes, y ya opacos. Esa
 * distinción es el producto entero, así que se ve.
 */

export function PanelDeSubidas(): React.JSX.Element | null {
  const [tareas, setTareas] = useState<readonly Tarea[]>([]);
  const tamano = useTamanoDePantalla();

  useEffect(() => suscribirseALaCola(setTareas), []);

  if (tareas.length === 0) {
    return null;
  }

  const terminadas = tareas.filter((t) => t.fase === 'hecha').length;

  return (
    <div
      style={{
        margin: tamano === 'ancho' ? `0 ${espacio.xl} ${espacio.l}` : `0 ${espacio.m} ${espacio.m}`,
        border: `1px solid ${color.borde.fuerte}`,
        borderRadius: radio.l,
        background: color.superficie.tenue,
        overflow: 'hidden',
        flexShrink: 0,
        maxHeight: '40vh',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          minHeight: '46px',
          padding: `0 ${espacio.l}`,
          borderBottom: `1px solid ${color.borde.fuerte}`,
          background: color.superficie.cabecera,
          display: 'flex',
          alignItems: 'center',
          gap: espacio.l,
          flexWrap: 'wrap',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: fuente.mono,
            fontSize: texto.micro,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: color.tinta.tenue,
          }}
        >
          Cola de subida
        </span>
        <span
          style={{ fontFamily: fuente.mono, fontSize: texto.auxiliar, color: color.tinta.media }}
        >
          {terminadas} de {tareas.length} terminado{tareas.length === 1 ? '' : 's'}
        </span>

        <span style={{ flexGrow: 1 }} />

        {tamano === 'ancho' && (
          <>
            <Leyenda color={color.verdin} texto="1 · cifrar aquí" />
            <Leyenda color={color.laton} texto="2 · subir" />
          </>
        )}

        {terminadas + tareas.filter((t) => t.fase !== 'hecha' && esFinal(t.fase)).length ===
          tareas.length && (
          <button
            type="button"
            onClick={limpiarTerminadas}
            style={{
              background: 'none',
              border: 'none',
              color: color.tinta.tenue,
              fontFamily: fuente.sans,
              fontSize: texto.menudo,
              cursor: 'pointer',
              textDecoration: 'underline',
              padding: espacio.s,
            }}
          >
            Vaciar la lista
          </button>
        )}
      </div>

      <div style={{ overflowY: 'auto' }}>
        {tareas.map((tarea) => (
          <FilaDeSubida key={tarea.id} tarea={tarea} tamano={tamano} />
        ))}
      </div>
    </div>
  );
}

function esFinal(fase: FaseDeTarea): boolean {
  return fase === 'hecha' || fase === 'fallida' || fase === 'cancelada';
}

function Leyenda({ color: tono, texto: rotulo }: { color: string; texto: string }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: espacio.s }}>
      <span style={{ width: '22px', height: '4px', borderRadius: '1px', background: tono }} />
      <span style={{ fontSize: texto.menudo, color: color.tinta.media }}>{rotulo}</span>
    </span>
  );
}

function FilaDeSubida({ tarea, tamano }: { tarea: Tarea; tamano: Tamano }): React.JSX.Element {
  const fallida = tarea.fase === 'fallida';

  return (
    <div
      style={{
        padding: `${espacio.l} ${espacio.l}`,
        borderBottom: `1px solid ${color.borde.sutil}`,
        background: fallida ? 'oklch(0.62 0.135 28 / 0.055)' : 'transparent',
        display: 'grid',
        // El tamano del fichero se cae en estrecho: mientras sube, lo que
        // importa es el nombre y por donde va, no cuanto pesa.
        gridTemplateColumns:
          tamano === 'minimo' ? '26px minmax(0, 1fr) 40px' : '26px minmax(0, 1fr) 96px 44px',
        gap: tamano === 'ancho' ? espacio.l : espacio.m,
        alignItems: 'center',
      }}
    >
      <span style={{ display: 'flex', color: colorDeFase(tarea.fase) }}>
        <IconoDeFase fase={tarea.fase} />
      </span>

      <div style={{ display: 'flex', flexDirection: 'column', gap: espacio.s, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: espacio.m }}>
          <span
            style={{
              fontFamily: fuente.mono,
              fontSize: texto.cuerpo,
              color: tarea.fase === 'hecha' ? color.tinta.media : color.tinta.fuerte,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {tarea.ruta.length > 0 && (
              <span style={{ color: color.tinta.tenue }}>{tarea.ruta.join('/')}/</span>
            )}
            {tarea.nombre}
          </span>
          <span style={{ flexGrow: 1 }} />
          <span
            style={{
              fontSize: texto.auxiliar,
              fontWeight: fallida ? 600 : 500,
              color: colorDeFase(tarea.fase),
              whiteSpace: 'nowrap',
            }}
          >
            {rotuloDeFase(tarea)}
          </span>
        </div>

        <div style={{ display: 'flex', gap: '6px' }}>
          <Barra fraccion={tarea.cifrado} tono={color.verdin} apagada={fallida} />
          <Barra
            fraccion={tarea.subido}
            tono={color.laton}
            apagada={fallida || tarea.fase === 'cifrando'}
          />
        </div>

        <span
          style={{ fontSize: texto.menudo, color: fallida ? color.tinta.media : color.tinta.tenue }}
        >
          {explicacion(tarea)}
        </span>
      </div>

      {tamano !== 'minimo' && (
        <span
          style={{
            fontFamily: fuente.mono,
            fontSize: texto.auxiliar,
            color: fallida ? color.peligro : color.tinta.media,
          }}
        >
          {formatearTamano(tarea.bytes)}
        </span>
      )}

      <span style={{ display: 'flex', justifyContent: 'center' }}>
        {!esFinal(tarea.fase) && (
          <button
            type="button"
            title="Cancelar"
            aria-label={`Cancelar la subida de ${tarea.nombre}`}
            onClick={() => {
              cancelar(tarea.id);
            }}
            style={{
              background: 'none',
              border: 'none',
              color: color.tinta.tenue,
              cursor: 'pointer',
              padding: espacio.s,
              display: 'flex',
            }}
          >
            <IconoCruz tamano={18} />
          </button>
        )}
      </span>
    </div>
  );
}

function Barra({
  fraccion,
  tono,
  apagada,
}: {
  fraccion: number;
  tono: string;
  apagada: boolean;
}): React.JSX.Element {
  return (
    <span
      style={{
        flexGrow: 1,
        height: '4px',
        borderRadius: '1px',
        background: apagada ? 'oklch(0.62 0.135 28 / 0.35)' : color.superficie.chip,
        overflow: 'hidden',
        display: 'block',
      }}
    >
      <span
        style={{
          display: 'block',
          width: `${String(Math.round(Math.min(1, Math.max(0, fraccion)) * 100))}%`,
          height: '100%',
          background: tono,
          transition: 'width 120ms linear',
        }}
      />
    </span>
  );
}

function colorDeFase(fase: FaseDeTarea): string {
  if (fase === 'fallida') {
    return color.peligro;
  }
  if (fase === 'cifrando') {
    return color.verdin;
  }
  if (fase === 'subiendo') {
    return color.laton;
  }
  return color.tinta.media;
}

function IconoDeFase({ fase }: { fase: FaseDeTarea }): React.JSX.Element {
  if (fase === 'fallida') {
    return <IconoAviso tamano={20} />;
  }
  if (fase === 'hecha') {
    return <IconoVisto tamano={20} />;
  }
  if (fase === 'cancelada') {
    return <IconoCruz tamano={20} />;
  }
  return <IconoLlave tamano={20} />;
}

function rotuloDeFase(tarea: Tarea): string {
  switch (tarea.fase) {
    case 'esperando':
      return 'En cola';
    case 'cifrando':
      return `Cifrando · ${String(Math.round(tarea.cifrado * 100))}%`;
    case 'subiendo':
      return `Subiendo · ${String(Math.round(tarea.subido * 100))}%`;
    case 'hecha':
      return 'Guardado';
    case 'cancelada':
      return 'Cancelado';
    case 'fallida':
      return 'No se ha subido';
  }
}

/**
 * La línea de debajo de las barras.
 *
 * Durante el cifrado dice explícitamente que no ha salido nada del equipo:
 * es el momento en que la promesa de la app se puede comprobar, y decirlo
 * ahí vale más que cualquier explicación en una página de ayuda.
 */
function explicacion(tarea: Tarea): string {
  switch (tarea.fase) {
    case 'esperando':
      return tarea.intentos > 0
        ? `Reintentando tras un fallo de red (intento ${String(tarea.intentos + 1)})`
        : 'A la espera de un hueco en la cola';
    case 'cifrando':
      return 'AES-256-GCM en tu navegador · aún no ha salido nada de este equipo';
    case 'subiendo':
      return 'Cifrado · enviando bytes opacos';
    case 'hecha':
      return 'En la bóveda, cifrado con una clave que solo tú puedes abrir';
    case 'cancelada':
      return 'Cancelado por ti · el servidor descartó lo que hubiera recibido';
    case 'fallida':
      return tarea.motivo ?? 'No se pudo subir.';
  }
}

/**
 * La zona donde soltar ficheros.
 *
 * Aparece en cuanto se arrastra algo sobre la ventana. No hay un panel
 * permanente ocupando sitio: la mesa de trabajo es el listado.
 */
export function ZonaDeSoltar({
  alSoltar,
  arrastrando,
}: {
  alSoltar: (datos: DataTransfer) => void;
  arrastrando: boolean;
}): React.JSX.Element | null {
  if (!arrastrando) {
    return null;
  }

  return (
    <div
      onDrop={(evento) => {
        evento.preventDefault();
        alSoltar(evento.dataTransfer);
      }}
      onDragOver={(evento) => {
        evento.preventDefault();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        background: 'oklch(0 0 0 / 0.72)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: espacio.xxl,
      }}
    >
      <div
        style={{
          width: 'min(560px, 100%)',
          padding: espacio.xxl,
          border: `1.5px dashed oklch(0.72 0.115 75 / 0.42)`,
          borderRadius: radio.l,
          background: 'oklch(0.72 0.115 75 / 0.045)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: espacio.m,
          textAlign: 'center',
        }}
      >
        <span style={{ color: color.laton, display: 'flex' }}>
          <IconoSubir tamano={30} />
        </span>
        <span style={{ fontSize: texto.subtitulo, fontWeight: 500, color: color.tinta.fuerte }}>
          Suelta aquí los ficheros
        </span>
        <span style={{ fontSize: texto.cuerpo, color: color.tinta.media }}>
          Se cifran en tu equipo antes de salir. Máximo 50 MB por fichero.
        </span>
      </div>
    </div>
  );
}

/**
 * Detecta el arrastre sobre TODA la ventana, no sobre un recuadro.
 *
 * Obligar a apuntar a una caja pequeña con la mano ocupada es una pelea
 * innecesaria; el objetivo es la ventana entera.
 *
 * El contador de entradas/salidas es imprescindible: `dragleave` salta
 * también al pasar por encima de cualquier hijo, y sin llevar la cuenta la
 * zona parpadearía al mover el ratón por dentro.
 */
export function useArrastreEnLaVentana(): boolean {
  const [arrastrando, setArrastrando] = useState(false);
  const profundidad = useRef(0);

  useEffect(() => {
    function entra(evento: DragEvent): void {
      if (evento.dataTransfer?.types.includes('Files') !== true) {
        return;
      }
      profundidad.current += 1;
      setArrastrando(true);
    }

    function sale(): void {
      profundidad.current = Math.max(0, profundidad.current - 1);
      if (profundidad.current === 0) {
        setArrastrando(false);
      }
    }

    function suelta(): void {
      profundidad.current = 0;
      setArrastrando(false);
    }

    // `dragover` con preventDefault en toda la ventana evita que el
    // navegador ABRA el fichero soltado fuera de la zona, que es su
    // comportamiento por defecto y significaría enseñar una clave privada
    // en una pestaña.
    function encima(evento: DragEvent): void {
      evento.preventDefault();
    }

    window.addEventListener('dragenter', entra);
    window.addEventListener('dragleave', sale);
    window.addEventListener('dragover', encima);
    window.addEventListener('drop', suelta);

    return () => {
      window.removeEventListener('dragenter', entra);
      window.removeEventListener('dragleave', sale);
      window.removeEventListener('dragover', encima);
      window.removeEventListener('drop', suelta);
    };
  }, []);

  return arrastrando;
}
