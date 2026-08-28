import { useEffect, useRef, useState } from 'react';

import { totp } from '../api/cliente.js';
import { codigoParaEnviar, DIGITOS_DEL_CODIGO } from '../ui/codigo.js';
import { Aviso, Boton, Campo, Titular } from '../ui/componentes.js';
import { IconoLlave } from '../ui/Iconos.js';
import { color, espacio, fuente, texto } from '../ui/tokens.js';
import { cerrarBoveda } from '../vault/boveda.js';

/**
 * Verificación del segundo factor al entrar.
 *
 * El momento es peculiar y conviene entenderlo: la bóveda YA está abierta en
 * memoria — la contraseña era correcta y la clave maestra está desenvuelta —
 * pero la sesión del servidor no se completa hasta validar el código. Sin
 * eso, la API rechaza cualquier petición de ficheros.
 *
 * Esa separación es justo lo que hace que el segundo factor sirva de algo:
 * si se comprobara aquí, en el navegador, a quien tuviera la contraseña le
 * bastaría con saltarse este componente. Quien decide es el servidor.
 */
export function SegundoFactor({ alEntrar }: { alEntrar: () => void }): React.JSX.Element {
  const [codigo, setCodigo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState(false);

  /**
   * El último código que se ha llegado a mandar.
   *
   * NO ES OPCIONAL, y no solo por prudencia: en desarrollo React ejecuta los
   * efectos dos veces, así que sin esto el mismo código saldría por
   * duplicado y el segundo envío contaría como fallo contra el límite de
   * reintentos del servidor. Se borra al fallar, para que volver a escribir
   * el mismo código lo intente de nuevo.
   */
  const enviado = useRef<string | null>(null);

  /** El código listo para mandar, o `null` mientras esté a medias. */
  const listo = codigoParaEnviar(codigo);

  async function verificar(codigoAMandar: string): Promise<void> {
    setError(null);
    setTrabajando(true);

    try {
      await totp.verificar(codigoAMandar);
      alEntrar();
    } catch (fallo) {
      setError(fallo instanceof Error ? fallo.message : 'El código no es correcto.');
      setCodigo('');
      enviado.current = null;
      setTrabajando(false);
    }
  }

  /*
    Se comprueba solo en cuanto hay seis dígitos, sin tocar el botón.

    A esas alturas el botón no ofrece ninguna decisión: el código está
    entero o no lo está, y no hay nada más que rellenar en esta pantalla.
    Ahorra un gesto justo donde más molesta -- con el móvil en una mano
    copiando el código de la otra aplicación -- y encaja con el
    autorrelleno, que deja los seis dígitos de golpe.

    El botón se queda de todos modos: es lo que hace visible que la
    comprobación está en marcha, y el respaldo si el autorrelleno deja el
    campo de una forma que este efecto no vea.
  */
  useEffect(() => {
    if (listo === null || trabajando || enviado.current === listo) {
      return;
    }

    enviado.current = listo;
    void verificar(listo);
    // `verificar` se deja fuera a propósito: se redefine en cada repintado y
    // ponerla aquí volvería a lanzar la comprobación sin que cambie nada.
  }, [listo, trabajando]);

  return (
    <div
      style={{
        minHeight: '100vh',
        background: color.fondo,
        color: color.tinta.fuerte,
        fontFamily: fuente.sans,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: espacio.xl,
      }}
    >
      <form
        onSubmit={(evento) => {
          evento.preventDefault();
          if (listo !== null && !trabajando) {
            enviado.current = listo;
            void verificar(listo);
          }
        }}
        style={{
          width: 'min(420px, 100%)',
          display: 'flex',
          flexDirection: 'column',
          gap: espacio.l,
        }}
      >
        <Titular>Tu segundo factor</Titular>

        <Aviso>
          <span style={{ color: color.verdin, flexShrink: 0, display: 'flex' }}>
            <IconoLlave tamano={18} />
          </span>
          <span>
            La bóveda ya está abierta en memoria, pero el servidor no atiende nada hasta que
            verifiques el código. Lo comprueba él, no esta página.
          </span>
        </Aviso>

        {/*
          `totp` y `one-time-code` son lo que miran los gestores de
          contraseñas para reconocer este campo: con eso, Bitwarden ofrece el
          código del propio ítem del Locker en vez de obligar a copiarlo del
          móvil. Los nombres son parte del contrato con esas extensiones, no
          detalles internos: cambiarlos rompe el autorrelleno en silencio.
        */}
        <Campo
          etiqueta="Código de 6 dígitos"
          valor={codigo}
          alCambiar={setCodigo}
          mono
          autoFocus
          placeholder="000000"
          id="totp"
          nombre="totp"
          autoCompletar="one-time-code"
          modoDeTeclado="numeric"
          longitudMaxima={DIGITOS_DEL_CODIGO}
        />

        {error !== null && (
          <Aviso tono="peligro">
            <span>{error}</span>
          </Aviso>
        )}

        <Boton type="submit" tono="primario" ancho deshabilitado={listo === null || trabajando}>
          {trabajando ? 'Comprobando…' : 'Entrar'}
        </Boton>

        <button
          type="button"
          onClick={() => {
            cerrarBoveda();
          }}
          style={{
            background: 'none',
            border: 'none',
            color: color.tinta.tenue,
            fontFamily: fuente.sans,
            fontSize: texto.auxiliar,
            cursor: 'pointer',
            textDecoration: 'underline',
          }}
        >
          Cerrar la bóveda
        </button>
      </form>
    </div>
  );
}
