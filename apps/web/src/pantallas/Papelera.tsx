import { useCallback, useEffect, useState } from 'react';

import { papelera as api } from '../api/cliente.js';
import { Boton, EsqueletoDeFilas } from '../ui/componentes.js';
import { IconoCarpeta, IconoFichero, IconoPapelera, IconoRestaurar } from '../ui/Iconos.js';
import { CabeceraDePantalla } from '../ui/Marco.js';
import {
  columnasDeLaPapelera,
  margenLateral,
  rellenoDeFila,
  useTamanoDePantalla,
  type Tamano,
} from '../ui/pantalla.js';
import {
  color,
  espacio,
  formatearFecha,
  formatearTamano,
  fuente,
  radio,
  texto,
} from '../ui/tokens.js';
import { descifrarListado, type NodoLegible } from '../vault/operaciones.js';

/**
 * La papelera.
 *
 * Borrar en una bóveda de claves privadas es irreversible y doloroso, así
 * que no se borra: se aparta 30 días. Esta pantalla existe para que ese
 * plazo sea visible — un fichero que va a desaparecer el martes debe
 * decirlo, no esperar a que alguien lo eche de menos.
 */

/** Debe coincidir con DIAS_DE_RETENCION del servidor, que es quien purga. */
const DIAS_DE_RETENCION = 30;

export function Papelera({ alCambiarDatos }: { alCambiarDatos: () => void }): React.JSX.Element {
  const tamano = useTamanoDePantalla();
  const [contenido, setContenido] = useState<NodoLegible[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState<string | null>(null);
  const [vaciando, setVaciando] = useState(false);

  const recargar = useCallback(async () => {
    setContenido(null);
    setError(null);
    try {
      const { nodes } = await api.listar();
      setContenido(await descifrarListado(nodes));
    } catch (fallo) {
      setError(fallo instanceof Error ? fallo.message : 'No se pudo abrir la papelera.');
      setContenido([]);
    }
  }, []);

  useEffect(() => {
    void recargar();
  }, [recargar]);

  async function restaurar(nodo: NodoLegible): Promise<void> {
    try {
      await api.restaurar(nodo.id);
      await recargar();
      alCambiarDatos();
    } catch (fallo) {
      setError(fallo instanceof Error ? fallo.message : 'No se pudo restaurar.');
    }
  }

  async function borrar(nodo: NodoLegible): Promise<void> {
    try {
      await api.borrarDefinitivamente(nodo.id);
      setConfirmando(null);
      await recargar();
      alCambiarDatos();
    } catch (fallo) {
      setError(fallo instanceof Error ? fallo.message : 'No se pudo borrar.');
    }
  }

  async function vaciar(): Promise<void> {
    try {
      await api.vaciar();
      setVaciando(false);
      await recargar();
      alCambiarDatos();
    } catch (fallo) {
      setError(fallo instanceof Error ? fallo.message : 'No se pudo vaciar la papelera.');
    }
  }

  const ocupado = (contenido ?? []).reduce((suma, n) => suma + (n.sizeBytes ?? 0), 0);

  return (
    <>
      <CabeceraDePantalla
        titulo="Papelera"
        descripcion="Lo que borras se guarda 30 días y luego desaparece solo."
      >
        {(contenido ?? []).length > 0 && (
          <Boton
            tono="peligro"
            onClick={() => {
              setVaciando(true);
            }}
          >
            <IconoPapelera tamano={18} />
            Vaciar papelera
          </Boton>
        )}
      </CabeceraDePantalla>

      {error !== null && (
        <Franja tono="peligro">
          <span>{error}</span>
        </Franja>
      )}

      {ocupado > 0 && (
        <Franja>
          <span>
            Esto sigue ocupando cuota:{' '}
            <strong style={{ fontFamily: fuente.mono }}>{formatearTamano(ocupado)}</strong>. Borrar
            definitivamente es lo único que libera espacio.
          </span>
        </Franja>
      )}

      {vaciando && (
        <Franja tono="peligro">
          <span>
            <strong>
              Vaciar la papelera borra {String((contenido ?? []).length)} elemento(s) para siempre.
            </strong>{' '}
            No hay copia: los bytes se van del disco y nadie —tampoco el servidor— puede
            devolverlos.
          </span>
          <span style={{ flexGrow: 1 }} />
          <Boton
            onClick={() => {
              setVaciando(false);
            }}
          >
            No
          </Boton>
          <Boton tono="peligro" onClick={() => void vaciar()}>
            Sí, borrar para siempre
          </Boton>
        </Franja>
      )}

      <div
        style={{
          flexGrow: 1,
          minHeight: 0,
          margin: `0 ${margenLateral(tamano)}`,
          border: `1px solid ${color.borde.fuerte}`,
          borderRadius: radio.l,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
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
            gridTemplateColumns: columnasDeLaPapelera(tamano),
            gap: tamano === 'ancho' ? '14px' : '8px',
            alignItems: 'center',
            fontFamily: fuente.sans,
            fontSize: texto.micro,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: color.tinta.tenue,
          }}
        >
          <span />
          <span>Nombre</span>
          {tamano !== 'minimo' && <span>Tamaño</span>}
          {tamano === 'ancho' && <span>Borrado el</span>}
          <span>{tamano === 'minimo' ? 'Quedan' : 'Se destruye en'}</span>
          <span />
        </div>

        <div style={{ flexGrow: 1, minHeight: 0, overflowY: 'auto' }}>
          {contenido === null ? (
            <EsqueletoDeFilas filas={3} />
          ) : contenido.length === 0 ? (
            <div
              style={{
                padding: espacio.xxl,
                textAlign: 'center',
                color: color.tinta.tenue,
                fontSize: texto.cuerpo,
              }}
            >
              La papelera está vacía.
            </div>
          ) : (
            contenido.map((nodo) => (
              <Fila
                key={nodo.id}
                nodo={nodo}
                confirmando={confirmando === nodo.id}
                alRestaurar={() => void restaurar(nodo)}
                alPedirBorrado={() => {
                  setConfirmando(nodo.id);
                }}
                alCancelar={() => {
                  setConfirmando(null);
                }}
                alBorrar={() => void borrar(nodo)}
                tamano={tamano}
              />
            ))
          )}
        </div>
      </div>

      <div
        style={{
          padding: `${espacio.m} ${espacio.xl}`,
          borderTop: `1px solid ${color.borde.sutil}`,
          fontSize: texto.menudo,
          color: color.tinta.tenue,
        }}
      >
        Aquí dentro los ficheros siguen cifrados con tu clave, igual que en la bóveda.
      </div>
    </>
  );
}

function Fila({
  nodo,
  confirmando,
  alRestaurar,
  alPedirBorrado,
  alCancelar,
  alBorrar,
  tamano,
}: {
  nodo: NodoLegible;
  confirmando: boolean;
  alRestaurar: () => void;
  alPedirBorrado: () => void;
  alCancelar: () => void;
  alBorrar: () => void;
  tamano: Tamano;
}): React.JSX.Element {
  const quedan = diasQueQuedan(nodo.deletedAt);

  return (
    <div
      style={{
        minHeight: '52px',
        boxSizing: 'border-box',
        padding: `${espacio.s} ${rellenoDeFila(tamano)}`,
        borderBottom: `1px solid ${color.borde.sutil}`,
        display: 'grid',
        gridTemplateColumns: columnasDeLaPapelera(tamano),
        gap: tamano === 'ancho' ? '14px' : '8px',
        alignItems: 'center',
      }}
    >
      <span style={{ color: color.tinta.tenue, display: 'flex' }}>
        {nodo.kind === 'folder' ? <IconoCarpeta tamano={18} /> : <IconoFichero tamano={18} />}
      </span>

      <span
        style={{
          fontFamily: fuente.mono,
          fontSize: texto.cuerpo,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {nodo.nombre}
      </span>

      {tamano !== 'minimo' && (
        <span
          style={{ fontFamily: fuente.mono, fontSize: texto.auxiliar, color: color.tinta.media }}
        >
          {formatearTamano(nodo.sizeBytes)}
        </span>
      )}

      {tamano === 'ancho' && (
        <span
          style={{ fontFamily: fuente.mono, fontSize: texto.auxiliar, color: color.tinta.media }}
        >
          {nodo.deletedAt === null ? '—' : formatearFecha(nodo.deletedAt)}
        </span>
      )}

      <span
        style={{
          fontFamily: fuente.mono,
          fontSize: texto.auxiliar,
          // Los ultimos dias se avisan en rojo: es el unico momento en que
          // esta pantalla tiene prisa.
          color: quedan !== null && quedan <= 3 ? color.peligro : color.tinta.media,
        }}
      >
        {quedan === null ? '—' : quedan <= 0 ? 'hoy' : `${String(quedan)} días`}
      </span>

      <span style={{ display: 'flex', gap: espacio.s, justifyContent: 'flex-end' }}>
        {confirmando ? (
          <>
            <span style={{ fontSize: texto.menudo, color: color.peligro, alignSelf: 'center' }}>
              ¿Seguro?
            </span>
            <Boton onClick={alCancelar}>No</Boton>
            <Boton tono="peligro" onClick={alBorrar}>
              Borrar ya
            </Boton>
          </>
        ) : (
          <>
            <Boton onClick={alRestaurar} title="Devolver a la bóveda">
              <IconoRestaurar tamano={18} />
              {tamano === 'ancho' ? 'Restaurar' : ''}
            </Boton>
            <Boton tono="peligro" onClick={alPedirBorrado} title="Borrar definitivamente">
              <IconoPapelera tamano={18} />
            </Boton>
          </>
        )}
      </span>
    </div>
  );
}

/**
 * Días que le quedan a un nodo antes de la purga.
 *
 * Se calcula en el cliente a partir de `deletedAt`, que es el mismo dato con
 * el que el servidor decide purgar. Si algún día cambia la retención allí,
 * hay que cambiarla aquí: son dos sitios, y esto es lo que evita que la
 * pantalla mienta.
 */
function diasQueQuedan(deletedAt: string | null): number | null {
  if (deletedAt === null) {
    return null;
  }

  const borrado = new Date(deletedAt).getTime();
  if (Number.isNaN(borrado)) {
    return null;
  }

  const transcurridos = (Date.now() - borrado) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.ceil(DIAS_DE_RETENCION - transcurridos));
}

function Franja({
  children,
  tono = 'normal',
}: {
  children: React.ReactNode;
  tono?: 'normal' | 'peligro';
}): React.JSX.Element {
  return (
    <div
      style={{
        margin: `0 ${espacio.xl} ${espacio.l}`,
        padding: espacio.m,
        display: 'flex',
        alignItems: 'center',
        gap: espacio.m,
        flexWrap: 'wrap',
        background: tono === 'peligro' ? 'oklch(0.62 0.135 28 / 0.07)' : color.superficie.tenue,
        border: `1px solid ${tono === 'peligro' ? 'oklch(0.62 0.135 28 / 0.4)' : color.borde.medio}`,
        borderRadius: radio.m,
        fontSize: texto.auxiliar,
        color: tono === 'peligro' ? color.peligro : color.tinta.media,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}
