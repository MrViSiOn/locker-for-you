import { useCallback, useEffect, useRef, useState } from 'react';

import { nodos } from '../api/cliente.js';
import { type Migaja } from '../ui/arbol.js';
import { Casilla } from '../ui/Casilla.js';
import { Boton, EsqueletoDeFilas, PildoraDeClave } from '../ui/componentes.js';
import {
  columnasDelExplorador,
  esEstrecho,
  margenLateral,
  rellenoDeFila,
  useTamanoDePantalla,
  type Tamano,
} from '../ui/pantalla.js';
import { PanelDeSubidas, useArrastreEnLaVentana, ZonaDeSoltar } from '../ui/Subidas.js';
import {
  IconoCarpeta,
  IconoChevron,
  IconoDescargar,
  IconoFichero,
  IconoNuevaCarpeta,
  IconoPapelera,
  IconoSinVista,
  IconoSubir,
} from '../ui/Iconos.js';
import {
  color,
  espacio,
  formatearFecha,
  formatearTamano,
  fuente,
  radio,
  texto,
} from '../ui/tokens.js';
import {
  crearCarpeta,
  descargarFichero,
  guardarEnDisco,
  listarCarpeta,
  mover,
  nombreDuplicado,
  renombrar,
  type NodoLegible,
} from '../vault/operaciones.js';
import {
  encolar,
  hayCosasEnMarcha,
  recogerDelArrastre,
  type ArchivoConRuta,
} from '../vault/subidas.js';
import { descargarSeleccionComoZip } from '../vault/zip.js';

/**
 * El explorador: la pantalla donde se pasa el tiempo.
 *
 * Se comporta como un explorador de escritorio, con una diferencia que no es
 * un recorte sino una decisión: NO HAY VISTA PREVIA. La única forma de ver
 * una clave es descargarla. Mostrarla en pantalla la dejaría en el DOM, en
 * la memoria del navegador y a merced de cualquier XSS, para ahorrar un
 * clic.
 */

export type CampoDeOrden = 'nombre' | 'tamano' | 'fecha';

interface Orden {
  campo: CampoDeOrden;
  ascendente: boolean;
}

/**
 * Filtra por nombre dentro de la carpeta actual.
 *
 * En el cliente porque no queda otra: el servidor guarda los nombres
 * cifrados y no puede buscar en ellos. La ventaja es que la busqueda es
 * instantanea y no genera ni una peticion.
 */
function filtrar(lista: readonly NodoLegible[], busqueda: string): NodoLegible[] {
  const texto = busqueda.trim().toLocaleLowerCase('es');
  if (texto === '') {
    return [...lista];
  }
  return lista.filter((n) => n.nombre.toLocaleLowerCase('es').includes(texto));
}

/**
 * Ordena, con las carpetas SIEMPRE primero.
 *
 * Que las carpetas encabecen no es una preferencia estetica: son el unico
 * elemento navegable, y mezclarlas entre cincuenta ficheros obliga a
 * buscarlas con la vista cada vez.
 */
function ordenar(lista: NodoLegible[], orden: Orden): NodoLegible[] {
  const signo = orden.ascendente ? 1 : -1;

  return [...lista].sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'folder' ? -1 : 1;
    }

    if (orden.campo === 'tamano') {
      return ((a.sizeBytes ?? 0) - (b.sizeBytes ?? 0)) * signo;
    }

    if (orden.campo === 'fecha') {
      return (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()) * signo;
    }

    // `localeCompare` con numeric para que fichero-2 vaya antes que
    // fichero-10, que es lo que espera cualquiera que numere sus claves.
    return a.nombre.localeCompare(b.nombre, 'es', { numeric: true }) * signo;
  });
}

export function Explorador({
  alCambiarDatos,
  /*
    El camino vive fuera: lo comparten el explorador y el árbol de la barra
    lateral, y con una copia en cada sitio acabarían discrepando en cuanto
    se navegase por el otro.
  */
  ruta,
  alCambiarRuta,
}: {
  /** Avisa al marco de que el espacio ocupado ha cambiado. */
  alCambiarDatos: () => void;
  ruta: Migaja[];
  alCambiarRuta: (ruta: Migaja[]) => void;
}): React.JSX.Element {
  const [contenido, setContenido] = useState<NodoLegible[] | null>(null);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState('');
  const [orden, setOrden] = useState<Orden>({ campo: 'nombre', ascendente: true });
  const [sobreCarpeta, setSobreCarpeta] = useState<string | null>(null);

  /** Ultima fila pulsada, para que shift+clic sepa desde donde extender. */
  const anclaDeSeleccion = useRef<string | null>(null);
  /** Lo que se esta arrastrando. Va en ref: no se pinta, y cambiarlo no debe repintar. */
  const arrastrado = useRef<string | null>(null);

  const carpetaActual = ruta[ruta.length - 1]?.id ?? null;
  const arrastrando = useArrastreEnLaVentana();
  const selectorDeFicheros = useRef<HTMLInputElement>(null);

  const recargar = useCallback(async () => {
    setContenido(null);
    setError(null);
    try {
      setContenido(await listarCarpeta(carpetaActual));
      alCambiarDatos();
    } catch (fallo) {
      setError(fallo instanceof Error ? fallo.message : 'No se pudo abrir la carpeta.');
      setContenido([]);
    }
  }, [carpetaActual, alCambiarDatos]);

  useEffect(() => {
    void recargar();
    setSeleccion(new Set());
  }, [recargar]);

  /**
   * Encola lo que llegue, venga de un arrastre o del selector.
   *
   * El listado se recarga al terminar CADA fichero y no solo al final: en
   * una tanda larga, ver aparecer los ficheros conforme entran es la prueba
   * de que la cola avanza de verdad.
   */
  const subir = useCallback(
    async (entradas: readonly ArchivoConRuta[]): Promise<void> => {
      if (entradas.length === 0) {
        return;
      }

      try {
        await encolar(entradas, carpetaActual, () => void recargar());
      } catch (fallo) {
        setError(fallo instanceof Error ? fallo.message : 'No se pudo preparar la subida.');
      }

      await recargar();
    },
    [carpetaActual, recargar],
  );

  // Cerrar la pestana con la cola a medias deja ficheros sin subir y,
  // peor, sin ningun rastro de que faltaban: el navegador solo pregunta si
  // se lo pedimos.
  useEffect(() => {
    function avisar(evento: BeforeUnloadEvent): void {
      if (hayCosasEnMarcha()) {
        evento.preventDefault();
      }
    }

    window.addEventListener('beforeunload', avisar);
    return () => {
      window.removeEventListener('beforeunload', avisar);
    };
  }, []);

  function entrarEn(nodo: NodoLegible): void {
    alCambiarRuta([...ruta, { id: nodo.id, nombre: nodo.nombre }]);
  }

  function volverA(indice: number): void {
    alCambiarRuta(ruta.slice(0, indice + 1));
  }

  function alternarSeleccion(id: string): void {
    const nueva = new Set(seleccion);
    if (nueva.has(id)) {
      nueva.delete(id);
    } else {
      nueva.add(id);
    }
    setSeleccion(nueva);
  }

  async function descargarUno(nodo: NodoLegible): Promise<void> {
    try {
      guardarEnDisco(nodo.nombre, await descargarFichero(nodo));
    } catch {
      setError(`No se pudo descifrar «${nodo.nombre}». El fichero puede estar dañado.`);
    }
  }

  async function descargarSeleccion(): Promise<void> {
    const elegidos = (contenido ?? []).filter((n) => seleccion.has(n.id) && n.kind === 'file');
    if (elegidos.length === 0) {
      return;
    }

    // El ZIP se arma aquí, en el navegador: el servidor no puede comprimir
    // lo que no puede descifrar.
    await descargarSeleccionComoZip(elegidos, 'locker-seleccion');
  }

  /**
   * Manda a la papelera, que no es borrar: el nodo se aparta 30 dias y se
   * puede recuperar. Por eso no hay confirmacion aqui — la hay en la
   * papelera, donde el borrado si es definitivo.
   */
  async function moverAPapelera(nodo: NodoLegible): Promise<void> {
    try {
      await nodos.aPapelera(nodo.id);
      setSeleccion(new Set());
      await recargar();
    } catch (fallo) {
      setError(
        fallo instanceof Error ? fallo.message : `No se pudo mover «${nodo.nombre}» a la papelera.`,
      );
    }
  }

  async function renombrarNodo(nodo: NodoLegible, nombre: string): Promise<void> {
    setEditando(null);

    // El duplicado se comprueba aqui porque el servidor no ve los nombres:
    // si no se hace en el cliente, no se hace en ningun sitio.
    const hermanos = (contenido ?? []).filter((n) => n.id !== nodo.id);
    if (nombreDuplicado(nombre, hermanos)) {
      setError(`Ya hay algo llamado «${nombre}» en esta carpeta.`);
      return;
    }

    try {
      await renombrar(nodo.id, nombre);
      await recargar();
    } catch (fallo) {
      setError(fallo instanceof Error ? fallo.message : 'No se pudo renombrar.');
    }
  }

  /**
   * Mueve un nodo a una carpeta de la lista.
   *
   * Los ciclos y el exceso de profundidad los rechaza el servidor, que es
   * quien tiene el arbol entero; aqui solo se evita lo evidente -- soltar
   * algo sobre si mismo -- para no gastar una peticion en ello.
   */
  async function moverA(nodoId: string, destino: NodoLegible): Promise<void> {
    setSobreCarpeta(null);

    if (nodoId === destino.id) {
      return;
    }

    try {
      await mover(nodoId, destino.id);
      setSeleccion(new Set());
      await recargar();
    } catch (fallo) {
      setError(
        fallo instanceof Error
          ? fallo.message
          : 'No se pudo mover. ¿Es una carpeta dentro de sí misma?',
      );
    }
  }

  /** Sube un nivel soltando sobre la migaja anterior. */
  async function moverAlPadre(nodoId: string, destino: string | null): Promise<void> {
    try {
      await mover(nodoId, destino);
      setSeleccion(new Set());
      await recargar();
    } catch (fallo) {
      setError(fallo instanceof Error ? fallo.message : 'No se pudo mover.');
    }
  }

  /**
   * Seleccion con raton, como en un explorador de escritorio.
   *
   * Clic solo: selecciona uno. Ctrl+clic: anade o quita. Shift+clic: extiende
   * desde la ultima pulsada. El ancla se guarda para que shift sepa desde
   * donde.
   */
  function seleccionarConRaton(nodo: NodoLegible, evento: React.MouseEvent): void {
    const lista = visibles;

    if (evento.shiftKey && anclaDeSeleccion.current !== null) {
      const desde = lista.findIndex((n) => n.id === anclaDeSeleccion.current);
      const hasta = lista.findIndex((n) => n.id === nodo.id);

      if (desde !== -1 && hasta !== -1) {
        const [a, b] = desde < hasta ? [desde, hasta] : [hasta, desde];
        setSeleccion(new Set(lista.slice(a, b + 1).map((n) => n.id)));
        return;
      }
    }

    if (evento.ctrlKey || evento.metaKey) {
      alternarSeleccion(nodo.id);
    } else {
      setSeleccion(new Set([nodo.id]));
    }

    anclaDeSeleccion.current = nodo.id;
  }

  async function nuevaCarpeta(): Promise<void> {
    const nombre = prompt('Nombre de la carpeta');
    if (nombre === null || nombre.trim() === '') {
      return;
    }

    try {
      await crearCarpeta(carpetaActual, nombre.trim());
      await recargar();
    } catch (fallo) {
      setError(fallo instanceof Error ? fallo.message : 'No se pudo crear la carpeta.');
    }
  }

  /**
   * Filtrado y ordenacion, AMBOS EN EL CLIENTE y por el mismo motivo: el
   * servidor no puede buscar ni ordenar lo que no lee. Con los nombres
   * cifrados, cualquier `ORDER BY name` devolveria un orden aleatorio.
   */
  const visibles = ordenar(filtrar(contenido ?? [], busqueda), orden);

  const ficherosSeleccionados = (contenido ?? []).filter(
    (n) => seleccion.has(n.id) && n.kind === 'file',
  ).length;

  return (
    <>
      <Cabecera
        ruta={ruta}
        alVolverA={volverA}
        busqueda={busqueda}
        alBuscar={setBusqueda}
        alSoltarEnMigaja={(indice) => {
          const id = arrastrado.current;
          arrastrado.current = null;
          if (id !== null) {
            void moverAlPadre(id, ruta[indice]?.id ?? null);
          }
        }}
        seleccionados={ficherosSeleccionados}
        alSubir={() => selectorDeFicheros.current?.click()}
        alNuevaCarpeta={() => void nuevaCarpeta()}
        alDescargarSeleccion={() => void descargarSeleccion()}
      />

      {error !== null && (
        <div
          style={{
            margin: `0 ${espacio.xl}`,
            padding: espacio.m,
            background: 'oklch(0.62 0.135 28 / 0.07)',
            border: `1px solid oklch(0.62 0.135 28 / 0.4)`,
            borderRadius: radio.m,
            fontFamily: fuente.sans,
            fontSize: texto.auxiliar,
            color: color.peligro,
          }}
        >
          {error}
        </div>
      )}

      <PanelDeSubidas />

      <Tabla
        contenido={contenido === null ? null : visibles}
        vacioPorBusqueda={contenido !== null && contenido.length > 0 && visibles.length === 0}
        seleccion={seleccion}
        orden={orden}
        editando={editando}
        sobreCarpeta={sobreCarpeta}
        alOrdenarPor={(campo) => {
          setOrden((anterior) =>
            anterior.campo === campo
              ? { campo, ascendente: !anterior.ascendente }
              : { campo, ascendente: true },
          );
        }}
        alAlternar={alternarSeleccion}
        alSeleccionar={seleccionarConRaton}
        alEntrar={entrarEn}
        alBorrar={(nodo) => void moverAPapelera(nodo)}
        alDescargar={(nodo) => void descargarUno(nodo)}
        alEmpezarAEditar={(nodo) => {
          setEditando(nodo.id);
        }}
        alCancelarEdicion={() => {
          setEditando(null);
        }}
        alRenombrar={(nodo, nombre) => void renombrarNodo(nodo, nombre)}
        alArrastrar={(nodo) => {
          arrastrado.current = nodo.id;
        }}
        alSobrevolar={setSobreCarpeta}
        alSoltarEn={(destino) => {
          const id = arrastrado.current;
          arrastrado.current = null;
          if (id !== null) {
            void moverA(id, destino);
          }
        }}
      />

      <PieDeTabla />

      <ZonaDeSoltar
        arrastrando={arrastrando}
        alSoltar={(datos) => {
          void recogerDelArrastre(datos).then(subir);
        }}
      />

      {/* El selector vive aqui, escondido, porque el <input type="file"> del
          sistema no se puede estilar y el boton de la cabecera si. */}
      <input
        ref={selectorDeFicheros}
        type="file"
        multiple
        hidden
        onChange={(evento) => {
          const elegidos = Array.from(evento.target.files ?? []).map((archivo) => ({
            archivo,
            ruta: [],
          }));
          // Se vacia el input para que elegir el MISMO fichero dos veces
          // seguidas vuelva a disparar el evento.
          evento.target.value = '';
          void subir(elegidos);
        }}
      />
    </>
  );
}

function Cabecera({
  ruta,
  alVolverA,
  busqueda,
  alBuscar,
  alSoltarEnMigaja,
  seleccionados,
  alSubir,
  alNuevaCarpeta,
  alDescargarSeleccion,
}: {
  ruta: Migaja[];
  alVolverA: (indice: number) => void;
  busqueda: string;
  alBuscar: (texto: string) => void;
  alSoltarEnMigaja: (indice: number) => void;
  seleccionados: number;
  alSubir: () => void;
  alNuevaCarpeta: () => void;
  alDescargarSeleccion: () => void;
}): React.JSX.Element {
  const [migajaResaltada, setMigajaResaltada] = useState<number | null>(null);
  const tamano = useTamanoDePantalla();
  const estrecho = esEstrecho(tamano);

  return (
    <div
      style={{
        padding: estrecho ? `${espacio.m} ${espacio.m}` : `${espacio.l} ${espacio.xl}`,
        display: 'flex',
        flexDirection: 'column',
        gap: estrecho ? espacio.m : espacio.l,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: espacio.xs,
            fontFamily: fuente.mono,
            fontSize: texto.auxiliar,
          }}
        >
          {/*
            Subir un nivel. Solo aparece cuando hay a donde subir: un boton
            que no hace nada la mitad del tiempo ensena a ignorarlo.
          */}
          {ruta.length > 1 && (
            <button
              type="button"
              onClick={() => {
                alVolverA(ruta.length - 2);
              }}
              title="Subir un nivel"
              aria-label="Subir un nivel"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '26px',
                height: '26px',
                marginRight: espacio.xs,
                background: 'none',
                border: `1px solid ${color.borde.fuerte}`,
                borderRadius: radio.s,
                color: color.tinta.media,
                cursor: 'pointer',
              }}
            >
              <span style={{ display: 'flex', transform: 'rotate(-90deg)' }}>
                <IconoChevron tamano={14} />
              </span>
            </button>
          )}

          {ruta.map((migaja, indice) => (
            <span key={migaja.id ?? 'raiz'} style={{ display: 'flex', alignItems: 'center' }}>
              {indice > 0 && (
                <span style={{ color: color.tinta.tenue, display: 'flex' }}>
                  <IconoChevron tamano={14} />
                </span>
              )}
              {/*
                Las migajas admiten soltar: arrastrar un fichero sobre
                "Boveda" o sobre una carpeta anterior es como se sube de
                nivel. Sin esto solo se podria bajar, y sacar algo de una
                carpeta obligaria a descargarlo y volver a subirlo.
              */}
              <button
                type="button"
                onClick={() => {
                  alVolverA(indice);
                }}
                onDragOver={(evento) => {
                  evento.preventDefault();
                  setMigajaResaltada(indice);
                }}
                onDragLeave={() => {
                  setMigajaResaltada(null);
                }}
                onDrop={(evento) => {
                  evento.preventDefault();
                  setMigajaResaltada(null);
                  alSoltarEnMigaja(indice);
                }}
                style={{
                  background: migajaResaltada === indice ? 'oklch(0.72 0.115 185 / 0.15)' : 'none',
                  border: 'none',
                  borderRadius: radio.s,
                  padding: `2px ${espacio.xs}`,
                  cursor: 'pointer',
                  fontFamily: fuente.mono,
                  fontSize: texto.auxiliar,
                  color: indice === ruta.length - 1 ? color.tinta.fuerte : color.tinta.tenue,
                }}
              >
                {migaja.nombre}
              </button>
            </span>
          ))}
        </div>

        {/*
          La pildora se va en la pantalla mas pequena. Dice algo importante
          --que la clave vive en memoria-- pero es un recordatorio, no un
          control, y ahi compite por sitio con el breadcrumb, que si hace
          falta para moverse.
        */}
        {tamano !== 'minimo' && <PildoraDeClave />}
      </div>

      <div style={{ display: 'flex', gap: espacio.s, alignItems: 'center', flexWrap: 'wrap' }}>
        <Boton tono="primario" onClick={alSubir}>
          <IconoSubir tamano={16} />
          Subir
        </Boton>
        <Boton onClick={alNuevaCarpeta} title="Nueva carpeta">
          <IconoNuevaCarpeta tamano={16} />
          {tamano === 'minimo' ? '' : 'Nueva carpeta'}
        </Boton>

        <input
          value={busqueda}
          onChange={(evento) => {
            alBuscar(evento.target.value);
          }}
          placeholder="Buscar en esta carpeta…"
          aria-label="Buscar en esta carpeta"
          style={{
            minHeight: '38px',
            // En estrecho ocupa la linea entera en vez de quedarse en un
            // hueco de 220 px que ya no existe.
            width: estrecho ? '100%' : '220px',
            boxSizing: 'border-box',
            padding: `0 ${espacio.m}`,
            background: color.superficie.tenue,
            border: `1px solid ${color.borde.fuerte}`,
            borderRadius: radio.m,
            color: color.tinta.fuerte,
            fontFamily: fuente.sans,
            fontSize: texto.auxiliar,
            outline: 'none',
          }}
        />

        {seleccionados > 0 && (
          <>
            <div
              style={{ width: '1px', height: '24px', background: color.borde.fuerte }}
              aria-hidden="true"
            />
            <Boton onClick={alDescargarSeleccion}>
              <IconoDescargar tamano={16} />
              Descargar {String(seleccionados)} como ZIP
            </Boton>
          </>
        )}
      </div>
    </div>
  );
}

function Tabla({
  contenido,
  vacioPorBusqueda,
  seleccion,
  orden,
  editando,
  sobreCarpeta,
  alOrdenarPor,
  alAlternar,
  alSeleccionar,
  alEntrar,
  alDescargar,
  alBorrar,
  alEmpezarAEditar,
  alCancelarEdicion,
  alRenombrar,
  alArrastrar,
  alSobrevolar,
  alSoltarEn,
}: {
  contenido: NodoLegible[] | null;
  vacioPorBusqueda: boolean;
  seleccion: Set<string>;
  orden: Orden;
  editando: string | null;
  sobreCarpeta: string | null;
  alOrdenarPor: (campo: CampoDeOrden) => void;
  alAlternar: (id: string) => void;
  alSeleccionar: (nodo: NodoLegible, evento: React.MouseEvent) => void;
  alEntrar: (nodo: NodoLegible) => void;
  alDescargar: (nodo: NodoLegible) => void;
  alBorrar: (nodo: NodoLegible) => void;
  alEmpezarAEditar: (nodo: NodoLegible) => void;
  alCancelarEdicion: () => void;
  alRenombrar: (nodo: NodoLegible, nombre: string) => void;
  alArrastrar: (nodo: NodoLegible) => void;
  alSobrevolar: (id: string | null) => void;
  alSoltarEn: (destino: NodoLegible) => void;
}): React.JSX.Element {
  const tamano = useTamanoDePantalla();
  const rejilla = columnasDelExplorador(tamano);
  return (
    <div
      style={{
        flexGrow: 1,
        minHeight: 0,
        margin: `0 ${margenLateral(tamano)}`,
        border: `1px solid ${color.borde.fuerte}`,
        borderRadius: radio.l,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          height: '38px',
          flexShrink: 0,
          boxSizing: 'border-box',
          padding: `0 ${rellenoDeFila(tamano)}`,
          borderBottom: `1px solid ${color.borde.fuerte}`,
          background: color.superficie.cabecera,
          display: 'grid',
          gridTemplateColumns: rejilla,
          gap: tamano === 'ancho' ? '14px' : '8px',
          alignItems: 'center',
          fontFamily: fuente.sans,
          fontSize: texto.micro,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: color.tinta.tenue,
        }}
      >
        {tamano !== 'minimo' && <span />}
        <span />
        <ColumnaOrdenable campo="nombre" orden={orden} alPulsar={alOrdenarPor}>
          Nombre
        </ColumnaOrdenable>
        <ColumnaOrdenable campo="tamano" orden={orden} alPulsar={alOrdenarPor}>
          Tamaño en disco
        </ColumnaOrdenable>
        <ColumnaOrdenable campo="fecha" orden={orden} alPulsar={alOrdenarPor}>
          Modificado
        </ColumnaOrdenable>
        <span />
      </div>

      <div style={{ flexGrow: 1, minHeight: 0, overflowY: 'auto' }}>
        {contenido === null ? (
          <EsqueletoDeFilas />
        ) : contenido.length === 0 ? (
          vacioPorBusqueda ? (
            <SinResultados />
          ) : (
            <CarpetaVacia />
          )
        ) : (
          contenido.map((nodo) => (
            <Fila
              key={nodo.id}
              nodo={nodo}
              seleccionado={seleccion.has(nodo.id)}
              alAlternar={() => {
                alAlternar(nodo.id);
              }}
              alEntrar={() => {
                alEntrar(nodo);
              }}
              alBorrar={() => {
                alBorrar(nodo);
              }}
              alDescargar={() => {
                alDescargar(nodo);
              }}
              editando={editando === nodo.id}
              destinoDeArrastre={sobreCarpeta === nodo.id}
              alSeleccionar={(evento) => {
                alSeleccionar(nodo, evento);
              }}
              alEmpezarAEditar={() => {
                alEmpezarAEditar(nodo);
              }}
              alCancelarEdicion={alCancelarEdicion}
              alRenombrar={(nombre) => {
                alRenombrar(nodo, nombre);
              }}
              alArrastrar={() => {
                alArrastrar(nodo);
              }}
              alSobrevolar={alSobrevolar}
              alSoltarEncima={() => {
                alSoltarEn(nodo);
              }}
              tamano={tamano}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Fila({
  nodo,
  seleccionado,
  editando,
  destinoDeArrastre,
  alAlternar,
  alSeleccionar,
  alEntrar,
  alDescargar,
  alBorrar,
  alRenombrar,
  alEmpezarAEditar,
  alCancelarEdicion,
  alSoltarEncima,
  alArrastrar,
  alSobrevolar,
  tamano,
}: {
  nodo: NodoLegible;
  seleccionado: boolean;
  editando: boolean;
  destinoDeArrastre: boolean;
  alAlternar: () => void;
  alSeleccionar: (evento: React.MouseEvent) => void;
  alEntrar: () => void;
  alDescargar: () => void;
  alBorrar: () => void;
  alRenombrar: (nombre: string) => void;
  alEmpezarAEditar: () => void;
  alCancelarEdicion: () => void;
  alSoltarEncima: () => void;
  alArrastrar: () => void;
  alSobrevolar: (id: string | null) => void;
  tamano: Tamano;
}): React.JSX.Element {
  const esCarpeta = nodo.kind === 'folder';

  return (
    <div
      // Cualquier fila se puede arrastrar; solo las carpetas admiten soltar.
      draggable={!editando}
      onDragStart={alArrastrar}
      onDragOver={(evento) => {
        if (esCarpeta) {
          evento.preventDefault();
          alSobrevolar(nodo.id);
        }
      }}
      onDragLeave={() => {
        if (esCarpeta) {
          alSobrevolar(null);
        }
      }}
      onDragEnd={() => {
        alSobrevolar(null);
      }}
      onDrop={(evento) => {
        if (esCarpeta) {
          evento.preventDefault();
          evento.stopPropagation();
          alSoltarEncima();
        }
      }}
      onClick={alSeleccionar}
      style={{
        minHeight: '52px',
        boxSizing: 'border-box',
        padding: `0 ${rellenoDeFila(tamano)}`,
        borderBottom: `1px solid ${color.borde.sutil}`,
        background: destinoDeArrastre
          ? 'oklch(0.72 0.115 185 / 0.12)'
          : seleccionado
            ? 'oklch(0.72 0.115 75 / 0.085)'
            : 'transparent',
        // El destino de un arrastre se marca con un borde entero, no solo con
        // el fondo: sobre negro, un cambio de fondo sutil pasa desapercibido
        // justo cuando hay que saber DONDE se va a soltar.
        outline: destinoDeArrastre ? `1px solid ${color.verdin}` : 'none',
        outlineOffset: '-1px',
        display: 'grid',
        gridTemplateColumns: columnasDelExplorador(tamano),
        gap: tamano === 'ancho' ? '14px' : '8px',
        alignItems: 'center',
      }}
    >
      {tamano !== 'minimo' && (
        <Casilla
          marcada={seleccionado}
          alCambiar={alAlternar}
          etiqueta={`Seleccionar ${nodo.nombre}`}
        />
      )}

      <span style={{ color: esCarpeta ? color.laton : color.tinta.tenue, display: 'flex' }}>
        {esCarpeta ? <IconoCarpeta tamano={18} /> : <IconoFichero tamano={18} />}
      </span>

      {editando ? (
        <NombreEditable
          nombre={nodo.nombre}
          alConfirmar={alRenombrar}
          alCancelar={alCancelarEdicion}
        />
      ) : (
        <button
          type="button"
          onClick={(evento) => {
            if (esCarpeta) {
              evento.stopPropagation();
              alEntrar();
            }
          }}
          onDoubleClick={(evento) => {
            evento.stopPropagation();
            alEmpezarAEditar();
          }}
          title={esCarpeta ? 'Abrir · doble clic para renombrar' : 'Doble clic para renombrar'}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            textAlign: 'left',
            // El nombre va en monoespaciada: aqui es un identificador exacto,
            // no una etiqueta.
            fontFamily: fuente.mono,
            fontSize: texto.cuerpo,
            color: color.tinta.fuerte,
            cursor: esCarpeta ? 'pointer' : 'default',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {nodo.nombre}
        </button>
      )}

      {tamano !== 'minimo' && (
        <span
          style={{ fontFamily: fuente.mono, fontSize: texto.auxiliar, color: color.tinta.media }}
        >
          {esCarpeta ? '—' : formatearTamano(nodo.sizeBytes)}
        </span>
      )}

      {tamano === 'ancho' && (
        <span
          style={{ fontFamily: fuente.mono, fontSize: texto.auxiliar, color: color.tinta.tenue }}
        >
          {formatearFecha(nodo.updatedAt)}
        </span>
      )}

      {esCarpeta ? (
        <span />
      ) : (
        <BotonDeFila onClick={alDescargar} titulo={`Descargar ${nodo.nombre}`}>
          <IconoDescargar tamano={16} />
        </BotonDeFila>
      )}

      {/*
        Borrar no pide confirmacion aqui, y es deliberado: esto NO borra
        nada. Manda a la papelera, donde el fichero espera 30 dias y se puede
        recuperar. La confirmacion se guarda para el borrado definitivo, que
        es el que no tiene vuelta.
      */}
      <BotonDeFila onClick={alBorrar} titulo={`Mover ${nodo.nombre} a la papelera`}>
        <IconoPapelera tamano={16} />
      </BotonDeFila>
    </div>
  );
}

/**
 * Renombrado en la propia fila.
 *
 * Sin dialogos: el nombre se edita donde esta, que es lo que hace cualquier
 * explorador de escritorio. Enter confirma, Escape cancela y perder el foco
 * tambien confirma -- si alguien hace clic fuera despues de escribir un
 * nombre, lo que espera es que se guarde, no que se pierda.
 */
function NombreEditable({
  nombre,
  alConfirmar,
  alCancelar,
}: {
  nombre: string;
  alConfirmar: (nombre: string) => void;
  alCancelar: () => void;
}): React.JSX.Element {
  const [valor, setValor] = useState(nombre);

  function confirmar(): void {
    const limpio = valor.trim();
    if (limpio === '' || limpio === nombre) {
      alCancelar();
      return;
    }
    alConfirmar(limpio);
  }

  return (
    <input
      value={valor}
      autoFocus
      onFocus={(evento) => {
        // Se selecciona solo el nombre, sin la extension: al renombrar una
        // clave casi siempre se cambia el nombre y casi nunca el .pem.
        const punto = valor.lastIndexOf('.');
        evento.target.setSelectionRange(0, punto > 0 ? punto : valor.length);
      }}
      onClick={(evento) => {
        evento.stopPropagation();
      }}
      onChange={(evento) => {
        setValor(evento.target.value);
      }}
      onBlur={confirmar}
      onKeyDown={(evento) => {
        if (evento.key === 'Enter') {
          confirmar();
        } else if (evento.key === 'Escape') {
          alCancelar();
        }
      }}
      style={{
        width: '100%',
        boxSizing: 'border-box',
        padding: `${espacio.xs} ${espacio.s}`,
        background: color.superficie.tenue,
        border: `1px solid ${color.laton}`,
        borderRadius: radio.s,
        color: color.tinta.fuerte,
        fontFamily: fuente.mono,
        fontSize: texto.cuerpo,
        outline: 'none',
      }}
    />
  );
}

function BotonDeFila({
  onClick,
  titulo,
  children,
}: {
  onClick: () => void;
  titulo: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={titulo}
      aria-label={titulo}
      style={{
        width: '30px',
        height: '32px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        border: `1px solid ${color.borde.medio}`,
        borderRadius: radio.m,
        color: color.tinta.media,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

/**
 * Cabecera de columna que ordena al pulsarla.
 *
 * La flecha solo aparece en la columna activa: tres flechas a la vez no
 * dicen cual manda.
 */
function ColumnaOrdenable({
  campo,
  orden,
  alPulsar,
  children,
}: {
  campo: CampoDeOrden;
  orden: Orden;
  alPulsar: (campo: CampoDeOrden) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const activa = orden.campo === campo;

  return (
    <button
      type="button"
      onClick={() => {
        alPulsar(campo);
      }}
      style={{
        background: 'none',
        border: 'none',
        padding: 0,
        display: 'flex',
        alignItems: 'center',
        gap: espacio.xs,
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit',
        fontSize: 'inherit',
        letterSpacing: 'inherit',
        textTransform: 'inherit',
        color: activa ? color.laton : 'inherit',
      }}
    >
      {children}
      {activa && <span aria-hidden="true">{orden.ascendente ? '↑' : '↓'}</span>}
    </button>
  );
}

/** Cuando el filtro no deja nada: distinto de una carpeta vacia de verdad. */
function SinResultados(): React.JSX.Element {
  return (
    <div
      style={{
        padding: `${espacio.xxl} ${espacio.l}`,
        textAlign: 'center',
        color: color.tinta.tenue,
        fontFamily: fuente.sans,
        fontSize: texto.auxiliar,
      }}
    >
      Nada coincide con la búsqueda. Aquí sí hay ficheros: prueba con otro texto.
    </div>
  );
}

function CarpetaVacia(): React.JSX.Element {
  return (
    <div
      style={{
        padding: `${espacio.xxl} ${espacio.l}`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: espacio.m,
        color: color.tinta.tenue,
      }}
    >
      <IconoCarpeta tamano={28} />
      <span style={{ fontFamily: fuente.sans, fontSize: texto.auxiliar }}>
        Aquí no hay nada todavía. Arrastra un fichero para guardarlo cifrado.
      </span>
    </div>
  );
}

/**
 * El pie enuncia en POSITIVO las dos cosas que distinguen esta tabla de la de
 * cualquier gestor de ficheros. No son disculpas: son la razón de ser.
 */
function PieDeTabla(): React.JSX.Element {
  const tamano = useTamanoDePantalla();

  // En la pantalla mas pequena el pie desaparece: son dos frases que
  // explican el producto, valiosas la primera vez y ruido la centesima.
  // Ocupar con ellas un tercio de una pantalla de movil no sale a cuenta.
  if (tamano === 'minimo') {
    return <div style={{ height: espacio.s }} />;
  }

  return (
    <div
      style={{
        padding:
          tamano === 'ancho'
            ? `${espacio.m} ${espacio.xl} ${espacio.l}`
            : `${espacio.s} ${espacio.m} ${espacio.m}`,
        display: 'flex',
        flexWrap: 'wrap',
        gap: tamano === 'ancho' ? espacio.xl : espacio.m,
        fontFamily: fuente.sans,
        fontSize: texto.micro,
        color: color.tinta.tenue,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: espacio.s }}>
        <IconoSinVista tamano={14} />
        Sin vista previa: un fichero solo se ve al descargarlo
      </span>
      <span>
        Los tamaños son múltiplos de 4 KB — el relleno oculta el tamaño real de cada clave
      </span>
    </div>
  );
}
