import { useEffect, useState } from 'react';

import { nodos } from '../api/cliente.js';
import { cerrarBoveda } from '../vault/boveda.js';
import { ArbolDeCarpetas } from './ArbolDeCarpetas.js';
import { RAIZ, type Migaja } from './arbol.js';
import { Boton } from './componentes.js';
import { IconoAjustes, IconoCandado, IconoCarpeta, IconoPapelera } from './Iconos.js';
import { esEstrecho, useTamanoDePantalla } from './pantalla.js';
import { color, espacio, formatearTamano, fuente, radio, texto } from './tokens.js';

/**
 * El marco de la aplicación: barra lateral y hueco para la pantalla.
 *
 * Vive aparte de las pantallas porque la barra lateral es lo único que se
 * mantiene fijo mientras se navega, y duplicarla en cada una acabaría con
 * tres versiones ligeramente distintas del mismo menú.
 */

export type Seccion = 'ficheros' | 'papelera' | 'ajustes';

export function Marco({
  seccion,
  alIr,
  alCerrarSesion,
  /** El camino abierto en el explorador, compartido con el árbol de la barra. */
  ruta,
  alNavegar,
  /**
   * Sube de valor cuando algo cambia el espacio ocupado (una subida, un
   * borrado, un vaciado de papelera). Es la señal para volver a pedirlo:
   * sin ella, la barra seguiría enseñando el dato de hace diez minutos.
   */
  version = 0,
  children,
}: {
  seccion: Seccion;
  alIr: (seccion: Seccion) => void;
  alCerrarSesion: () => void;
  ruta: readonly Migaja[];
  alNavegar: (ruta: Migaja[]) => void;
  version?: number;
  children: React.ReactNode;
}): React.JSX.Element {
  const [almacenamiento, setAlmacenamiento] = useState<{ usado: number; cuota: number } | null>(
    null,
  );
  const tamano = useTamanoDePantalla();
  const estrecho = esEstrecho(tamano);

  useEffect(() => {
    void nodos
      .almacenamiento()
      .then((datos) => {
        setAlmacenamiento({ usado: datos.usadoBytes, cuota: datos.cuotaBytes });
      })
      .catch(() => {
        // Que no se sepa el espacio no es motivo para romper la pantalla:
        // simplemente no se enseña la barra.
        setAlmacenamiento(null);
      });
  }, [version]);

  return (
    <div
      style={{
        display: 'flex',
        // En estrecho la navegacion baja al pie: es donde llega el pulgar, y
        // ademas devuelve al contenido los 232 px que se comia la columna.
        flexDirection: estrecho ? 'column-reverse' : 'row',
        height: '100vh',
        background: color.fondo,
        color: color.tinta.fuerte,
      }}
    >
      <div
        style={{
          width: estrecho ? '100%' : '232px',
          flexShrink: 0,
          boxSizing: 'border-box',
          // El granate es identidad, no estado: solo vive aquí.
          background: color.lateral,
          borderRight: estrecho ? 'none' : `1px solid ${color.borde.fuerte}`,
          borderTop: estrecho ? `1px solid ${color.borde.fuerte}` : 'none',
          padding: estrecho ? `${espacio.s} ${espacio.m}` : `${espacio.xl} ${espacio.l}`,
          display: 'flex',
          flexDirection: estrecho ? 'row' : 'column',
          alignItems: estrecho ? 'center' : 'stretch',
          gap: estrecho ? espacio.s : espacio.xl,
        }}
      >
        {/*
          El logo se va en estrecho. En una barra de pie de 56 px no aporta
          nada y le quita sitio a lo unico que ahi importa: llegar a las tres
          secciones con el pulgar.
        */}
        <div
          style={{
            display: estrecho ? 'none' : 'flex',
            flexDirection: 'column',
            gap: espacio.xs,
          }}
        >
          <span
            style={{
              fontFamily: fuente.serifa,
              fontSize: texto.subtitulo,
              color: color.tinta.fuerte,
            }}
          >
            Locker
          </span>
          <span
            style={{
              fontFamily: fuente.mono,
              fontSize: texto.micro,
              letterSpacing: '0.1em',
              color: color.tinta.tenue,
            }}
          >
            BÓVEDA CIFRADA
          </span>
        </div>

        <nav
          style={{
            display: 'flex',
            flexDirection: estrecho ? 'row' : 'column',
            gap: '2px',
            // En ancho el nav se queda con el hueco sobrante para que el
            // árbol pueda desplazarse dentro sin empujar lo de abajo.
            flexGrow: 1,
            minHeight: 0,
          }}
        >
          <EntradaDeMenu
            icono={<IconoCarpeta tamano={18} />}
            activo={seccion === 'ficheros'}
            estrecho={estrecho}
            onClick={() => {
              alIr('ficheros');
              alNavegar([RAIZ]);
            }}
          >
            {tamano === 'minimo' ? 'Ficheros' : 'Mis ficheros'}
          </EntradaDeMenu>

          {/*
            El árbol cuelga de "Mis ficheros" porque es lo que es: sus
            carpetas. En estrecho no se pinta — la barra es un pie de tres
            botones y ahí navegar se hace con las migas del explorador.
          */}
          {!estrecho && (
            <ArbolDeCarpetas
              ruta={ruta}
              version={version}
              alNavegar={(destino) => {
                alIr('ficheros');
                alNavegar(destino);
              }}
            />
          )}
          <EntradaDeMenu
            icono={<IconoPapelera tamano={18} />}
            activo={seccion === 'papelera'}
            estrecho={estrecho}
            onClick={() => {
              alIr('papelera');
            }}
          >
            Papelera
          </EntradaDeMenu>
          <EntradaDeMenu
            icono={<IconoAjustes tamano={18} />}
            activo={seccion === 'ajustes'}
            estrecho={estrecho}
            onClick={() => {
              alIr('ajustes');
            }}
          >
            Ajustes
          </EntradaDeMenu>
        </nav>

        <div
          style={{
            marginTop: estrecho ? 0 : 'auto',
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: espacio.m,
          }}
        >
          {/*
            El contador de espacio se va en estrecho: es informacion de
            contexto, y en una barra de pie compite con lo unico accionable
            que hay ahi.
          */}
          {!estrecho && almacenamiento !== null && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: espacio.s }}>
              <div
                style={{
                  height: '3px',
                  background: color.superficie.chip,
                  borderRadius: '2px',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${String(
                      almacenamiento.cuota === 0
                        ? 0
                        : Math.min(100, (almacenamiento.usado / almacenamiento.cuota) * 100),
                    )}%`,
                    height: '100%',
                    background: color.laton,
                  }}
                />
              </div>
              <span
                style={{ fontFamily: fuente.mono, fontSize: texto.micro, color: color.tinta.tenue }}
              >
                {formatearTamano(almacenamiento.usado)} de {formatearTamano(almacenamiento.cuota)}
              </span>
            </div>
          )}

          <Boton
            tono="fantasma"
            ancho={!estrecho}
            title="Cerrar bóveda"
            onClick={() => {
              cerrarBoveda();
              alCerrarSesion();
            }}
          >
            {estrecho ? <IconoCandado tamano={18} /> : 'Cerrar bóveda'}
          </Boton>
        </div>
      </div>

      <div
        style={{
          flexGrow: 1,
          minWidth: 0,
          // `minHeight: 0` NO es decorativo: sin el, este hueco no se encoge
          // por debajo de lo que mida su contenido, y entonces la pantalla de
          // dentro -- que se desplaza en su propio marco -- nunca llega a
          // tener un limite contra el que desplazarse. En ancho no se notaba
          // porque la fila estirada ya le fija la altura; en estrecho la
          // columna se lo comia, y Ajustes se quedaba sin scroll.
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          background: color.fondo,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function EntradaDeMenu({
  children,
  icono,
  activo = false,
  estrecho = false,
  onClick,
}: {
  children: React.ReactNode;
  icono: React.ReactNode;
  activo?: boolean;
  estrecho?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        // En la barra de pie el icono va encima del rotulo: caben las tres
        // secciones sin abreviar ninguna.
        flexDirection: estrecho ? 'column' : 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: estrecho ? '2px' : espacio.m,
        flexGrow: estrecho ? 1 : 0,
        minHeight: estrecho ? '46px' : '38px',
        padding: estrecho ? `${espacio.xs} ${espacio.s}` : `0 ${espacio.m}`,
        background: activo ? 'oklch(0.72 0.115 75 / 0.10)' : 'transparent',
        border: 'none',
        borderRadius: radio.m,
        color: activo ? color.laton : color.tinta.media,
        fontFamily: fuente.sans,
        fontSize: estrecho ? texto.micro : texto.cuerpo,
        cursor: 'pointer',
        textAlign: estrecho ? 'center' : 'left',
        whiteSpace: 'nowrap',
      }}
    >
      {icono}
      {children}
    </button>
  );
}

/** Cabecera de una pantalla: título a la izquierda y lo que haga falta a la derecha. */
export function CabeceraDePantalla({
  titulo,
  descripcion,
  children,
}: {
  titulo: string;
  descripcion?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  const tamano = useTamanoDePantalla();

  return (
    <div
      style={{
        padding:
          tamano === 'ancho'
            ? `${espacio.xl} ${espacio.xl} ${espacio.l}`
            : `${espacio.l} ${espacio.m} ${espacio.m}`,
        display: 'flex',
        alignItems: 'flex-start',
        gap: espacio.l,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: espacio.xs }}>
        <span style={{ fontFamily: fuente.serifa, fontSize: texto.titulo }}>{titulo}</span>
        {descripcion !== undefined && (
          <span style={{ fontSize: texto.auxiliar, color: color.tinta.tenue }}>{descripcion}</span>
        )}
      </div>
      <span style={{ flexGrow: 1 }} />
      {children}
    </div>
  );
}
