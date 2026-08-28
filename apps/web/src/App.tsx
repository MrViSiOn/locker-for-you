import { useCallback, useEffect, useState } from 'react';

import { auth } from './api/cliente.js';
import { Ajustes } from './pantallas/Ajustes.js';
import { Alta } from './pantallas/Alta.js';
import { Explorador } from './pantallas/Explorador.js';
import { Login } from './pantallas/Login.js';
import { Papelera } from './pantallas/Papelera.js';
import { SegundoFactor } from './pantallas/SegundoFactor.js';
import { RAIZ, type Migaja } from './ui/arbol.js';
import { Marco, type Seccion } from './ui/Marco.js';
import { color, fuente, texto } from './ui/tokens.js';
import { bovedaAbierta, suscribirse } from './vault/boveda.js';

/**
 * Raíz de la aplicación.
 *
 * El estado que manda no es "¿hay sesión?" sino "¿está la bóveda abierta?".
 * Son cosas distintas y esa distinción es la que da forma a toda la app: la
 * sesión vive en una cookie del servidor y sobrevive a recargar la página;
 * la clave maestra vive en memoria y NO sobrevive. Se puede tener una sin la
 * otra, y cuando eso pasa hay que pedir la contraseña otra vez.
 */

type Estado =
  | { paso: 'comprobando' }
  | { paso: 'sin-cuenta' }
  | { paso: 'login'; sesionViva: boolean }
  | { paso: 'totp' }
  | { paso: 'dentro' };

export function App(): React.JSX.Element {
  const [estado, setEstado] = useState<Estado>({ paso: 'comprobando' });

  useEffect(() => {
    async function arrancar(): Promise<void> {
      try {
        const { tieneCuenta } = await auth.estado();

        if (!tieneCuenta) {
          setEstado({ paso: 'sin-cuenta' });
          return;
        }

        // Si /me responde, la sesión del servidor sigue viva. Pero la bóveda
        // está cerrada igualmente: la clave se fue al recargar. Ese caso
        // merece un aviso propio en el login, para que no parezca un fallo.
        try {
          await auth.yo();
          setEstado({ paso: 'login', sesionViva: true });
        } catch {
          setEstado({ paso: 'login', sesionViva: false });
        }
      } catch {
        setEstado({ paso: 'login', sesionViva: false });
      }
    }

    void arrancar();
  }, []);

  // Si la bóveda se cierra por cualquier vía, se vuelve al login sin más.
  useEffect(
    () =>
      suscribirse((abierta) => {
        if (!abierta) {
          setEstado((anterior) =>
            anterior.paso === 'dentro' ? { paso: 'login', sesionViva: true } : anterior,
          );
        }
      }),
    [],
  );

  if (estado.paso === 'comprobando') {
    return <Cargando />;
  }

  if (estado.paso === 'sin-cuenta') {
    return (
      <Alta
        alEntrar={() => {
          setEstado({ paso: 'dentro' });
        }}
      />
    );
  }

  if (estado.paso === 'login') {
    return (
      <Login
        sesionViva={estado.sesionViva}
        alEntrar={(requiereTotp) => {
          setEstado(requiereTotp ? { paso: 'totp' } : { paso: 'dentro' });
        }}
      />
    );
  }

  if (estado.paso === 'totp') {
    return (
      <SegundoFactor
        alEntrar={() => {
          setEstado({ paso: 'dentro' });
        }}
      />
    );
  }

  function salir(): void {
    void auth.logout();
    setEstado({ paso: 'login', sesionViva: false });
  }

  return <Dentro alSalir={salir} />;
}

/**
 * La aplicación con la bóveda abierta.
 *
 * `version` sube cada vez que algo cambia el espacio ocupado. Es la señal
 * que hace que la barra lateral vuelva a pedirlo: sin ella, subir un
 * fichero dejaría el contador de espacio mintiendo hasta recargar.
 */
function Dentro({ alSalir }: { alSalir: () => void }): React.JSX.Element {
  const [seccion, setSeccion] = useState<Seccion>('ficheros');
  const [version, setVersion] = useState(0);
  // Dónde está el explorador. Sube hasta aquí porque también lo usa el árbol
  // de la barra lateral: uno navega y el otro se abre por donde toca.
  const [ruta, setRuta] = useState<Migaja[]>([RAIZ]);

  const alCambiarDatos = useCallback(() => {
    setVersion((v) => v + 1);
  }, []);

  return (
    <Marco
      seccion={seccion}
      alIr={setSeccion}
      alCerrarSesion={alSalir}
      version={version}
      ruta={ruta}
      alNavegar={setRuta}
    >
      {seccion === 'ficheros' && (
        <Explorador alCambiarDatos={alCambiarDatos} ruta={ruta} alCambiarRuta={setRuta} />
      )}
      {seccion === 'papelera' && <Papelera alCambiarDatos={alCambiarDatos} />}
      {seccion === 'ajustes' && <Ajustes />}
    </Marco>
  );
}

function Pantalla({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: color.fondo,
        color: color.tinta.media,
        fontFamily: fuente.sans,
        fontSize: texto.cuerpo,
        textAlign: 'center',
        padding: '32px',
      }}
    >
      {children}
    </div>
  );
}

function Cargando(): React.JSX.Element {
  return <Pantalla>Abriendo…</Pantalla>;
}

export { bovedaAbierta };
