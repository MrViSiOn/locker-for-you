import { useEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import { color, espacio, fuente, objetivoTactil, radio, texto } from './tokens.js';

/**
 * Componentes base, con los valores del canvas.
 *
 * Estilos en línea a propósito: son pocos componentes, el sistema es
 * pequeño y así cada valor se lee junto a lo que afecta, sin saltar a otro
 * fichero para saber qué hace una clase.
 */

type Tono = 'primario' | 'normal' | 'peligro' | 'fantasma';

interface PropsDeBoton {
  children: ReactNode;
  onClick?: (() => void) | undefined;
  tono?: Tono;
  deshabilitado?: boolean;
  ancho?: boolean;
  type?: 'button' | 'submit';
  title?: string | undefined;
}

const tonos: Record<Tono, CSSProperties> = {
  primario: { background: color.laton, color: '#17130c', borderColor: color.laton },
  normal: {
    background: color.superficie.chip,
    color: color.tinta.fuerte,
    borderColor: color.borde.fuerte,
  },
  peligro: { background: 'transparent', color: color.peligro, borderColor: color.peligro },
  fantasma: { background: 'transparent', color: color.tinta.media, borderColor: 'transparent' },
};

export function Boton({
  children,
  onClick,
  tono = 'normal',
  deshabilitado = false,
  ancho = false,
  type = 'button',
  title,
}: PropsDeBoton): React.JSX.Element {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={deshabilitado}
      title={title}
      style={{
        borderWidth: '1px',
        borderStyle: 'solid',
        ...tonos[tono],
        // 44px es el suelo de cualquier cosa pulsable: por debajo se falla el
        // objetivo, y aquí un clic errado puede ser un borrado.
        minHeight: objetivoTactil,
        width: ancho ? '100%' : undefined,
        padding: `0 ${espacio.l}`,
        borderRadius: radio.m,
        fontFamily: fuente.sans,
        fontSize: texto.cuerpo,
        fontWeight: 500,
        cursor: deshabilitado ? 'not-allowed' : 'pointer',
        opacity: deshabilitado ? 0.4 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: espacio.s,
        transition: 'opacity 120ms ease',
      }}
    >
      {children}
    </button>
  );
}

interface PropsDeCampo {
  etiqueta: string;
  valor: string;
  alCambiar: (valor: string) => void;
  tipo?: 'text' | 'password' | 'email';
  ayuda?: string | undefined;
  error?: string | undefined;
  autoFocus?: boolean;
  mono?: boolean;
  placeholder?: string | undefined;
  /*
    Lo que sigue existe para los gestores de contrasenas. Un input sin `name`
    ni `id` ni `autocomplete` es invisible para ellos: no saben si es el
    correo, la contrasena o el codigo de un solo uso, asi que no ofrecen
    rellenarlo. Son cuatro atributos que no cambian nada de la aplicacion y
    le ahorran al usuario teclear a mano lo que ya tiene guardado.
  */
  id?: string | undefined;
  nombre?: string | undefined;
  autoCompletar?: string | undefined;
  modoDeTeclado?: 'numeric' | 'text' | undefined;
  longitudMaxima?: number | undefined;
}

export function Campo({
  etiqueta,
  valor,
  alCambiar,
  tipo = 'text',
  ayuda,
  error,
  autoFocus = false,
  mono = false,
  placeholder,
  id,
  nombre,
  autoCompletar,
  modoDeTeclado,
  longitudMaxima,
}: PropsDeCampo): React.JSX.Element {
  const campo = useRef<HTMLInputElement>(null);

  // Lo último que se sabe, para compararlo con lo que hay de verdad en el
  // input. En refs y no en el efecto para no reinstalar los oyentes en cada
  // tecla.
  const ultimoValor = useRef(valor);
  const avisar = useRef(alCambiar);

  useEffect(() => {
    ultimoValor.current = valor;
    avisar.current = alCambiar;
  });

  /*
    LEER EL VALOR DEL DOM, Y NO SOLO POR `onChange`.

    Cuando un gestor de contraseñas rellena un campo no escribe: asigna el
    valor y avisa. React, que lleva su propia cuenta de lo que vale cada
    input, puede dar ese cambio por no ocurrido -- y entonces se ve el
    código en pantalla, pero para la aplicación el campo sigue vacío: el
    botón deshabilitado y ninguna comprobación en marcha.

    El oyente nativo mira el input de verdad y no la cuenta de React, así
    que el autorrelleno cuenta igual que teclear. La primera pasada, al
    montar, cubre el caso de que el gestor haya rellenado antes de que la
    página estuviera lista.
  */
  useEffect(() => {
    const nodo = campo.current;
    if (nodo === null) {
      return;
    }

    function sincronizar(): void {
      if (nodo !== null && nodo.value !== ultimoValor.current) {
        ultimoValor.current = nodo.value;
        avisar.current(nodo.value);
      }
    }

    sincronizar();
    nodo.addEventListener('input', sincronizar);
    nodo.addEventListener('change', sincronizar);

    return () => {
      nodo.removeEventListener('input', sincronizar);
      nodo.removeEventListener('change', sincronizar);
    };
  }, []);

  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: espacio.s }}>
      <span
        style={{
          fontFamily: fuente.sans,
          fontSize: texto.menudo,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: color.tinta.tenue,
        }}
      >
        {etiqueta}
      </span>

      <input
        ref={campo}
        type={tipo}
        value={valor}
        placeholder={placeholder}
        onChange={(evento) => {
          alCambiar(evento.target.value);
        }}
        autoFocus={autoFocus}
        id={id}
        name={nombre}
        autoComplete={autoCompletar}
        inputMode={modoDeTeclado}
        maxLength={longitudMaxima}
        style={{
          minHeight: objetivoTactil,
          padding: `0 ${espacio.m}`,
          background: color.superficie.tenue,
          border: `1px solid ${error === undefined ? color.borde.fuerte : color.peligro}`,
          borderRadius: radio.m,
          color: color.tinta.fuerte,
          // La contraseña va en monoespaciada: se teclea a ciegas y con
          // ancho fijo se cuentan los caracteres de un vistazo.
          fontFamily: mono || tipo === 'password' ? fuente.mono : fuente.sans,
          fontSize: texto.destacado,
          outline: 'none',
        }}
      />

      {error !== undefined && (
        <span style={{ fontFamily: fuente.sans, fontSize: texto.auxiliar, color: color.peligro }}>
          {error}
        </span>
      )}

      {error === undefined && ayuda !== undefined && (
        <span
          style={{ fontFamily: fuente.sans, fontSize: texto.auxiliar, color: color.tinta.tenue }}
        >
          {ayuda}
        </span>
      )}
    </label>
  );
}

/**
 * La píldora que recuerda dónde vive la clave maestra.
 *
 * Está siempre visible a propósito: así, cuando al recargar la página haya
 * que volver a escribir la contraseña, no sea una sorpresa sino algo que ya
 * se sabía.
 */
export function PildoraDeClave(): React.JSX.Element {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: espacio.s,
        padding: `6px ${espacio.m}`,
        background: 'oklch(0.72 0.115 185 / 0.09)',
        border: '1px solid oklch(0.72 0.115 185 / 0.35)',
        borderRadius: '999px',
        fontFamily: fuente.sans,
        fontSize: texto.menudo,
        color: color.verdin,
      }}
    >
      <span
        style={{
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          background: color.verdin,
          flexShrink: 0,
        }}
      />
      Clave maestra en memoria · se borra al recargar
    </div>
  );
}

/**
 * Esqueleto de carga del listado.
 *
 * Los nombres llegan cifrados y se descifran en el navegador, así que hay un
 * instante entre "datos recibidos" y "nombres legibles". Durante ese rato se
 * muestran barras del ancho aproximado de un nombre: nunca el base64 en
 * bruto, que parecería que la bóveda está rota.
 */
export function EsqueletoDeFilas({ filas = 4 }: { filas?: number }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {Array.from({ length: filas }, (_, indice) => (
        <div
          key={indice}
          style={{
            height: '52px',
            display: 'flex',
            alignItems: 'center',
            gap: espacio.l,
            padding: `0 ${espacio.l}`,
            borderBottom: `1px solid ${color.borde.sutil}`,
          }}
        >
          <div
            style={{
              width: '20px',
              height: '20px',
              borderRadius: radio.s,
              background: color.superficie.chip,
            }}
          />
          <div
            style={{
              // Ancho variable: un bloque uniforme parece una tabla vacía,
              // no una que está cargando.
              width: `${String(140 + ((indice * 47) % 120))}px`,
              height: '11px',
              borderRadius: radio.s,
              background: color.superficie.chip,
            }}
          />
        </div>
      ))}
    </div>
  );
}

export function Aviso({
  children,
  tono = 'normal',
}: {
  children: ReactNode;
  tono?: 'normal' | 'peligro';
}): React.JSX.Element {
  const acento = tono === 'peligro' ? color.peligro : color.laton;

  return (
    <div
      style={{
        display: 'flex',
        gap: espacio.m,
        padding: espacio.l,
        background: tono === 'peligro' ? 'oklch(0.62 0.135 28 / 0.07)' : color.superficie.tenue,
        border: `1px solid ${tono === 'peligro' ? 'oklch(0.62 0.135 28 / 0.4)' : color.borde.medio}`,
        borderRadius: radio.m,
        fontFamily: fuente.sans,
        fontSize: texto.auxiliar,
        lineHeight: 1.55,
        color: tono === 'peligro' ? acento : color.tinta.media,
      }}
    >
      {children}
    </div>
  );
}

/** Titular en serifa: la app hablando. Aparece poco, y por eso pesa. */
export function Titular({
  children,
  tamano = texto.titulo,
}: {
  children: ReactNode;
  tamano?: string;
}): React.JSX.Element {
  return (
    <h1
      style={{
        margin: 0,
        fontFamily: fuente.serifa,
        fontSize: tamano,
        fontWeight: 400,
        lineHeight: 1.15,
        color: color.tinta.fuerte,
      }}
    >
      {children}
    </h1>
  );
}
