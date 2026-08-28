import { useCallback, useEffect, useState } from 'react';

import { listarCarpeta, type NodoLegible } from '../vault/operaciones.js';
import {
  abrirCamino,
  alternar,
  aRefrescar,
  caminoHacia,
  carpetaActual,
  RAIZ,
  type Migaja,
} from './arbol.js';
import { IconoCarpeta, IconoChevron } from './Iconos.js';
import { color, espacio, fuente, radio, texto } from './tokens.js';

/**
 * El árbol de carpetas de la barra lateral.
 *
 * SE DESPLIEGA A DEMANDA, y no por ahorrar peticiones: los nombres de las
 * carpetas están cifrados y solo se descifran al pedir el listado de una
 * carpeta concreta. Pintar el árbol entero de golpe obligaría a bajar y
 * descifrar toda la bóveda para dibujar un menú.
 *
 * Solo aparece con sitio de sobra. En la barra de pie del móvil no cabe, y
 * ahí el explorador con sus migas ya es la navegación.
 */
export function ArbolDeCarpetas({
  ruta,
  alNavegar,
  /** Sube cuando algo cambia en la bóveda; es la señal para releer el camino. */
  version = 0,
}: {
  ruta: readonly Migaja[];
  alNavegar: (ruta: Migaja[]) => void;
  version?: number;
}): React.JSX.Element | null {
  const [expandidos, setExpandidos] = useState<ReadonlySet<string>>(new Set());
  const [hijos, setHijos] = useState<ReadonlyMap<string | null, readonly NodoLegible[]>>(new Map());

  const cargar = useCallback(async (id: string | null): Promise<void> => {
    try {
      const lista = await listarCarpeta(id);
      const carpetas = lista.filter((nodo) => nodo.kind === 'folder');
      setHijos((anterior) => new Map(anterior).set(id, carpetas));
    } catch {
      // Una rama que no carga no es motivo para romper la barra lateral:
      // se queda sin desplegar y el explorador sigue funcionando.
      setHijos((anterior) => (anterior.has(id) ? anterior : new Map(anterior).set(id, [])));
    }
  }, []);

  // Navegar desde el explorador abre el árbol hasta donde se ha entrado.
  useEffect(() => {
    setExpandidos((anterior) => abrirCamino(anterior, ruta));
  }, [ruta]);

  // Lo que se despliega y aún no se ha pedido, se pide.
  useEffect(() => {
    if (!hijos.has(null)) {
      void cargar(null);
    }

    for (const id of expandidos) {
      if (!hijos.has(id)) {
        void cargar(id);
      }
    }
  }, [expandidos, hijos, cargar]);

  // Y lo que ya está pedido se vuelve a pedir cuando la bóveda cambia, pero
  // solo en el camino abierto (ver `aRefrescar`).
  useEffect(() => {
    if (version === 0) {
      return;
    }

    for (const id of aRefrescar(ruta, expandidos)) {
      void cargar(id);
    }
    // `ruta` y `expandidos` quedan fuera a propósito. El efecto lee los dos,
    // pero solo debe dispararlo `version`: navegar ya sube `version` (el
    // explorador avisa al recargar), así que ponerlos en la lista haría dos
    // rondas de peticiones por cada clic en lugar de una.
  }, [version, cargar]);

  const raiz = hijos.get(null) ?? [];

  // Una bóveda sin carpetas no necesita un árbol que lo anuncie.
  if (raiz.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '1px',
        overflowY: 'auto',
        minHeight: 0,
        marginTop: espacio.xs,
      }}
    >
      {raiz.map((carpeta) => (
        <Rama
          key={carpeta.id}
          carpeta={carpeta}
          camino={[RAIZ]}
          nivel={0}
          ruta={ruta}
          expandidos={expandidos}
          hijos={hijos}
          alAlternar={(id) => {
            setExpandidos((anterior) => alternar(anterior, id));
          }}
          alNavegar={alNavegar}
        />
      ))}
    </div>
  );
}

function Rama({
  carpeta,
  camino,
  nivel,
  ruta,
  expandidos,
  hijos,
  alAlternar,
  alNavegar,
}: {
  carpeta: NodoLegible;
  /** El camino hasta el PADRE de esta carpeta; ella misma se añade al pulsar. */
  camino: readonly Migaja[];
  nivel: number;
  ruta: readonly Migaja[];
  expandidos: ReadonlySet<string>;
  hijos: ReadonlyMap<string | null, readonly NodoLegible[]>;
  alAlternar: (id: string) => void;
  alNavegar: (ruta: Migaja[]) => void;
}): React.JSX.Element {
  const migaja: Migaja = { id: carpeta.id, nombre: carpeta.nombre };
  const miCamino = caminoHacia(camino, migaja);
  const abierta = expandidos.has(carpeta.id);
  const dentro = hijos.get(carpeta.id);
  const activa = carpetaActual(ruta) === carpeta.id;

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          paddingLeft: `${String(nivel * 12)}px`,
          background: activa ? 'oklch(0.72 0.115 75 / 0.10)' : 'transparent',
          borderRadius: radio.m,
        }}
      >
        {/*
          El chevron se pinta en todas las carpetas, también en las que no
          tienen nada dentro: saber si hay subcarpetas exige pedir el listado,
          y hacerlo por adelantado para toda la bóveda es justo lo que este
          árbol evita. Quien despliegue una carpeta vacía verá que no se abre
          nada, que es una respuesta honesta.
        */}
        <button
          type="button"
          onClick={() => {
            alAlternar(carpeta.id);
          }}
          title={abierta ? 'Plegar' : 'Desplegar'}
          aria-expanded={abierta}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '20px',
            height: '28px',
            flexShrink: 0,
            background: 'none',
            border: 'none',
            padding: 0,
            color: color.tinta.tenue,
            cursor: 'pointer',
            transform: abierta ? 'rotate(90deg)' : 'none',
            transition: 'transform 120ms ease',
          }}
        >
          <IconoChevron tamano={14} />
        </button>

        <button
          type="button"
          onClick={() => {
            alNavegar(miCamino);
          }}
          title={carpeta.nombre}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: espacio.s,
            flexGrow: 1,
            minWidth: 0,
            height: '28px',
            padding: `0 ${espacio.s}`,
            background: 'none',
            border: 'none',
            borderRadius: radio.m,
            // Monoespaciada porque un nombre de carpeta aquí es el mismo dato
            // que en la tabla, no una etiqueta de menú.
            fontFamily: fuente.mono,
            fontSize: texto.menudo,
            color: activa ? color.laton : color.tinta.media,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <span style={{ flexShrink: 0, display: 'flex', color: activa ? color.laton : 'inherit' }}>
            <IconoCarpeta tamano={14} />
          </span>
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {carpeta.nombre}
          </span>
        </button>
      </div>

      {abierta &&
        dentro?.map((nieta) => (
          <Rama
            key={nieta.id}
            carpeta={nieta}
            camino={miCamino}
            nivel={nivel + 1}
            ruta={ruta}
            expandidos={expandidos}
            hijos={hijos}
            alAlternar={alAlternar}
            alNavegar={alNavegar}
          />
        ))}
    </>
  );
}
