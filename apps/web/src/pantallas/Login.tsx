import { base64ToBytes, bytesToBase64, deriveSecrets, unlockVault } from '@locker/crypto';
import { useState } from 'react';

import { ApiError, auth } from '../api/cliente.js';
import { Aviso, Boton, Campo, Titular } from '../ui/componentes.js';
import { IconoCandado, IconoLlave } from '../ui/Iconos.js';
import { esEstrecho, useTamanoDePantalla } from '../ui/pantalla.js';
import { color, espacio, fuente, radio, texto, texturaRuido } from '../ui/tokens.js';
import { abrirBoveda } from '../vault/boveda.js';

/**
 * Entrada a la bóveda.
 *
 * Aquí ocurre el momento clave del modelo: la contraseña se convierte en dos
 * claves distintas EN ESTE NAVEGADOR. Una se manda al servidor para
 * demostrar quién eres; la otra abre la bóveda y no sale de aquí.
 */

interface Props {
  /** Cierto cuando la sesión del servidor sigue viva pero la clave se perdió. */
  sesionViva: boolean;
  alEntrar: (requiereTotp: boolean) => void;
}

export function Login({ sesionViva, alEntrar }: Props): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [contrasena, setContrasena] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState(false);
  const estrecho = esEstrecho(useTamanoDePantalla());

  async function entrar(): Promise<void> {
    setError(null);
    setTrabajando(true);

    try {
      // 1. El servidor dice con qué salt derivar. A un email que no existe le
      //    da uno falso pero determinista, así que este paso no revela quién
      //    tiene cuenta.
      const desafio = await auth.challenge(email);
      const salt = base64ToBytes(desafio.kdfSalt);

      // 2. La contraseña se convierte en dos claves distintas AQUÍ. Solo la
      //    de autenticación viaja; la que abre la bóveda se queda.
      const { authKey } = await deriveSecrets(contrasena, salt, desafio.kdfParams);

      // 3. Si la authKey es correcta, el servidor entrega la clave maestra
      //    ENVUELTA. Sigue siendo inútil para él: no tiene con qué abrirla.
      const sesion = await auth.login(email, bytesToBase64(authKey));

      // 4. Y aquí se abre, con la mitad que nunca salió del navegador.
      //
      //    Esto vuelve a pasar por Argon2id (~100 ms más). Se podría evitar
      //    reutilizando lo derivado en el paso 2, pero obligaría a sacar la
      //    KEK de su cápsula para pasarla de mano en mano; en un login que
      //    ocurre una vez cada muchas horas, la claridad vale más que el
      //    décimo de segundo.
      const credenciales = {
        kdfSalt: desafio.kdfSalt,
        kdfParams: desafio.kdfParams,
        authKey: bytesToBase64(authKey),
        wrappedMasterKey: sesion.wrappedMasterKey,
      };

      const { vault } = await unlockVault(contrasena, credenciales);

      // El material de derivacion se guarda con la clave: cambiar la
      // contrasena o regenerar el kit lo necesitan, y volver a pedirlo
      // obligaria a iniciar sesion otra vez a mitad de los ajustes.
      abrirBoveda(vault, credenciales);
      alEntrar(sesion.requiereTotp);
    } catch (fallo) {
      setError(
        fallo instanceof ApiError ? fallo.message : 'No se ha podido entrar. Inténtalo de nuevo.',
      );
    } finally {
      setTrabajando(false);
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        background: color.fondo,
        color: color.tinta.fuerte,
      }}
    >
      {/*
        El panel de presentacion se va en estrecho. Dice cosas verdaderas y
        bonitas sobre el producto, pero quien entra en su boveda desde el
        movil ya sabe lo que es: lo que necesita es el formulario, no el
        argumentario.
      */}
      {!estrecho && <Presentacion />}

      <div
        style={{
          flexGrow: 1,
          minWidth: 0,
          boxSizing: 'border-box',
          borderLeft: estrecho ? 'none' : `1px solid ${color.borde.medio}`,
          padding: estrecho ? `${espacio.xl} ${espacio.l}` : '64px 76px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: espacio.xl,
          background: color.fondo,
        }}
      >
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: espacio.m, maxWidth: '420px' }}
        >
          <Titular>Abre tu bóveda</Titular>
          <p
            style={{
              margin: 0,
              fontFamily: fuente.sans,
              fontSize: texto.cuerpo,
              lineHeight: 1.6,
              color: color.tinta.media,
            }}
          >
            Tu contraseña maestra se convierte en la llave aquí, en tu navegador. No viaja, no se
            guarda y nadie más la tiene: sin ella, ni siquiera el servidor puede leer tus ficheros.
          </p>
        </div>

        {sesionViva && (
          <div style={{ maxWidth: '420px' }}>
            <Aviso>
              <span style={{ color: color.verdin, flexShrink: 0 }}>
                <IconoLlave tamano={18} />
              </span>
              <span>
                Tu sesión sigue abierta, pero la llave se borró al recargar la página. Vive solo en
                la memoria del navegador — si se guardara en el disco, cualquier código malicioso
                inyectado en la página podría robarla.
              </span>
            </Aviso>
          </div>
        )}

        <form
          onSubmit={(evento) => {
            evento.preventDefault();
            void entrar();
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: espacio.l, maxWidth: '420px' }}
        >
          {/*
            `username` y `current-password` son la pareja que los gestores de
            contraseñas buscan para ofrecer el ítem guardado. Sin ellos este
            formulario es, para Bitwarden, dos cajas de texto cualesquiera.
          */}
          <Campo
            etiqueta="Correo"
            valor={email}
            alCambiar={setEmail}
            tipo="email"
            autoFocus={!sesionViva}
            id="email"
            nombre="email"
            autoCompletar="username"
          />

          <Campo
            etiqueta="Contraseña maestra"
            valor={contrasena}
            alCambiar={setContrasena}
            tipo="password"
            autoFocus={sesionViva}
            error={error ?? undefined}
            id="password"
            nombre="password"
            autoCompletar="current-password"
          />

          <Boton
            type="submit"
            tono="primario"
            ancho
            deshabilitado={trabajando || email === '' || contrasena === ''}
          >
            {trabajando ? 'Derivando la llave…' : 'Abrir bóveda'}
          </Boton>
        </form>

        <a
          href="#recuperar"
          style={{
            fontFamily: fuente.sans,
            fontSize: texto.auxiliar,
            color: color.tinta.tenue,
            textDecoration: 'none',
            maxWidth: '420px',
          }}
        >
          He olvidado la contraseña — usar la clave de recuperación
        </a>
      </div>
    </div>
  );
}

/** El panel izquierdo: identidad y la promesa del producto, sin adornos. */
function Presentacion(): React.JSX.Element {
  return (
    <div
      style={{
        width: '440px',
        flexShrink: 0,
        boxSizing: 'border-box',
        background: `${texturaRuido} repeat, ${color.lateral}`,
        padding: '64px 56px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: espacio.xs }}>
        <span
          style={{ fontFamily: fuente.serifa, fontSize: texto.titulo, color: color.tinta.fuerte }}
        >
          Locker
        </span>
        <span
          style={{
            fontFamily: fuente.mono,
            fontSize: texto.micro,
            letterSpacing: '0.12em',
            color: color.tinta.tenue,
          }}
        >
          BÓVEDA CIFRADA
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: espacio.l }}>
        <span style={{ color: color.laton }}>
          <IconoCandado tamano={26} />
        </span>
        <p
          style={{
            margin: 0,
            fontFamily: fuente.serifa,
            fontSize: '28px',
            lineHeight: 1.3,
            color: color.tinta.fuerte,
          }}
        >
          Lo que guardas aquí no lo puede leer nadie más.
        </p>
        <p
          style={{
            margin: 0,
            fontFamily: fuente.sans,
            fontSize: texto.auxiliar,
            lineHeight: 1.6,
            color: color.tinta.tenue,
          }}
        >
          Cada fichero se cifra en tu navegador antes de salir. En el disco del servidor solo hay
          bytes indistinguibles del ruido.
        </p>
      </div>

      <div
        style={{
          padding: espacio.m,
          background: 'oklch(0 0 0 / 0.3)',
          border: `1px solid ${color.borde.sutil}`,
          borderRadius: radio.m,
          fontFamily: fuente.mono,
          fontSize: texto.micro,
          lineHeight: 1.7,
          color: color.tinta.tenue,
          overflow: 'hidden',
        }}
      >
        <div style={{ color: color.verdin }}>$ xxd id_ed25519_banco</div>
        <div>4c434b52 01001000 00e4aaed 47abfb08</div>
        <div>b06a05d1 afa0acda 54691cd5 dc0b2125</div>
      </div>
    </div>
  );
}
