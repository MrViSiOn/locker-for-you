import {
  base64ToBytes,
  bytesToBase64,
  changePassword,
  crearRecuperacion,
  deriveSecrets,
  exportarMasterKeyParaRecuperacion,
  textoDelFicheroDeRecuperacion,
} from '@locker/crypto';
import { useEffect, useState } from 'react';

import { cuenta as apiCuenta, recuperacion, totp } from '../api/cliente.js';
import { Aviso, Boton, Campo } from '../ui/componentes.js';
import { IconoAviso, IconoCandado, IconoDescargar, IconoLlave } from '../ui/Iconos.js';
import { CodigoQR } from '../ui/CodigoQR.js';
import { CabeceraDePantalla } from '../ui/Marco.js';
import { margenLateral, useTamanoDePantalla } from '../ui/pantalla.js';
import { color, espacio, formatearFecha, fuente, radio, texto } from '../ui/tokens.js';
import { actualizarCredenciales, cerrarBoveda, credencialesDeLaBoveda } from '../vault/boveda.js';

/**
 * Ajustes: todo lo que puede cambiar quién abre esta bóveda.
 *
 * No hay preferencias de aspecto ni opciones de comodidad. Cada cosa de
 * esta pantalla mueve una llave, y por eso todas explican qué pasa con los
 * ficheros cuando se tocan.
 */

interface DatosDeCuenta {
  email: string;
  creadaEl: string;
  totpActivoDesde: string | null;
  tieneRecuperacion: boolean;
}

export function Ajustes(): React.JSX.Element {
  const tamano = useTamanoDePantalla();
  const [datos, setDatos] = useState<DatosDeCuenta | null>(null);
  const [registro, setRegistro] = useState<EntradaDeAuditoria[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void apiCuenta
      .ver()
      .then(setDatos)
      .catch((fallo: unknown) => {
        setError(fallo instanceof Error ? fallo.message : 'No se pudo leer la cuenta.');
      });

    void apiCuenta
      .auditoria(12)
      .then((r) => {
        setRegistro(r.entradas);
      })
      .catch(() => {
        setRegistro([]);
      });
  }, []);

  return (
    <>
      <CabeceraDePantalla
        titulo="Ajustes"
        descripcion="Todo lo que puede cambiar quién abre esta bóveda."
      />

      {/*
        El margen lateral es el mismo que usa el explorador, y no un valor
        fijo: con 26 px a cada lado, en un movil de 375 px el texto de los
        avisos se quedaba en una columna mas estrecha que su cabecera.
      */}
      <div
        style={{
          flexGrow: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: `0 ${margenLateral(tamano)}`,
        }}
      >
        <div
          style={{
            maxWidth: '760px',
            display: 'flex',
            flexDirection: 'column',
            gap: espacio.l,
            paddingBottom: espacio.xxl,
          }}
        >
          {error !== null && (
            <Aviso tono="peligro">
              <span>{error}</span>
            </Aviso>
          )}

          {datos !== null && (
            <span
              style={{
                fontFamily: fuente.mono,
                fontSize: texto.auxiliar,
                color: color.tinta.tenue,
              }}
            >
              {datos.email} · cuenta desde {formatearFecha(datos.creadaEl)}
            </span>
          )}

          <CambioDeContrasena />

          <SegundoFactor activoDesde={datos?.totpActivoDesde ?? null} />

          <EmergencyKit
            tieneRecuperacion={datos?.tieneRecuperacion ?? false}
            email={datos?.email ?? ''}
          />

          <RegistroDeAuditoria entradas={registro} />
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function Bloque({
  titulo,
  nota,
  icono,
  children,
}: {
  titulo: string;
  nota?: string;
  icono: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      style={{
        border: `1px solid ${color.borde.fuerte}`,
        borderRadius: radio.l,
        background: color.superficie.tenue,
        padding: espacio.l,
        display: 'flex',
        flexDirection: 'column',
        gap: espacio.m,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: espacio.m }}>
        <span style={{ color: color.laton, display: 'flex' }}>{icono}</span>
        <span style={{ fontSize: texto.destacado, fontWeight: 500 }}>{titulo}</span>
        {nota !== undefined && (
          <span
            style={{ fontFamily: fuente.mono, fontSize: texto.menudo, color: color.tinta.tenue }}
          >
            {nota}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function Explicacion({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p
      style={{
        margin: 0,
        fontSize: texto.auxiliar,
        color: color.tinta.media,
        lineHeight: 1.55,
      }}
    >
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Contraseña maestra
// ---------------------------------------------------------------------------

function CambioDeContrasena(): React.JSX.Element {
  const [abierto, setAbierto] = useState(false);
  const [actual, setActual] = useState('');
  const [nueva, setNueva] = useState('');
  const [repeticion, setRepeticion] = useState('');
  const [estado, setEstado] = useState<'quieto' | 'trabajando' | 'hecho'>('quieto');
  const [error, setError] = useState<string | null>(null);

  async function cambiar(): Promise<void> {
    setError(null);
    setEstado('trabajando');

    try {
      // El material de derivacion ya lo tiene la boveda desde que se abrio:
      // no hace falta volver a iniciar sesion a mitad de los ajustes.
      const credenciales = credencialesDeLaBoveda();
      if (credenciales === null) {
        throw new Error('Vuelve a abrir la bóveda para cambiar la contraseña.');
      }

      // Aqui esta el motivo de que la clave maestra sea aleatoria: esto
      // reenvuelve 40 bytes. Los ficheros no se tocan. Si la contrasena
      // actual no es la buena, changePassword lanza y no se cambia nada.
      const nuevas = await changePassword(actual, nueva, credenciales);

      await apiCuenta.cambiarPassword({
        authKeyActual: credenciales.authKey,
        kdfSalt: nuevas.kdfSalt,
        kdfParamsVersion: nuevas.kdfParams.version,
        authKey: nuevas.authKey,
        wrappedMasterKey: nuevas.wrappedMasterKey,
      });

      actualizarCredenciales(nuevas);
      setEstado('hecho');
    } catch (fallo) {
      setError(fallo instanceof Error ? fallo.message : 'No se pudo cambiar la contraseña.');
      setEstado('quieto');
    }
  }

  if (estado === 'hecho') {
    return (
      <Bloque titulo="Contraseña maestra" nota="cambiada" icono={<IconoCandado tamano={20} />}>
        <Aviso>
          <span style={{ flexShrink: 0, display: 'flex' }}>
            <IconoLlave tamano={18} />
          </span>
          <span>
            Cambiada. Se han cerrado <strong>todas</strong> las sesiones, incluida esta: entra otra
            vez con la contraseña nueva para comprobar que funciona.
          </span>
        </Aviso>
        <Boton
          tono="primario"
          onClick={() => {
            cerrarBoveda();
          }}
        >
          Ir al inicio de sesión
        </Boton>
      </Bloque>
    );
  }

  return (
    <Bloque titulo="Contraseña maestra" icono={<IconoCandado tamano={20} />}>
      <Explicacion>
        Al cambiarla se vuelve a envolver la clave maestra con la contraseña nueva.{' '}
        <strong>Los ficheros no se vuelven a subir ni a cifrar</strong>: siguen siendo los mismos
        bytes. Tarda unos segundos y hay que tener la bóveda abierta.
      </Explicacion>

      {!abierto ? (
        <div style={{ display: 'flex', gap: espacio.m, alignItems: 'center', flexWrap: 'wrap' }}>
          <Boton
            onClick={() => {
              setAbierto(true);
            }}
          >
            Cambiar contraseña
          </Boton>
          <span style={{ fontSize: texto.menudo, color: color.tinta.tenue }}>
            No invalida el Emergency Kit.
          </span>
        </div>
      ) : (
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: espacio.m, maxWidth: '400px' }}
        >
          <Campo
            etiqueta="Contraseña actual"
            tipo="password"
            valor={actual}
            alCambiar={setActual}
          />
          <Campo etiqueta="Contraseña nueva" tipo="password" valor={nueva} alCambiar={setNueva} />
          <Campo
            etiqueta="Repite la nueva"
            tipo="password"
            valor={repeticion}
            alCambiar={setRepeticion}
            error={repeticion !== '' && repeticion !== nueva ? 'No coinciden.' : undefined}
          />

          {error !== null && (
            <Aviso tono="peligro">
              <span>{error}</span>
            </Aviso>
          )}

          <div style={{ display: 'flex', gap: espacio.m }}>
            <Boton
              tono="primario"
              deshabilitado={
                estado === 'trabajando' ||
                nueva.length < 12 ||
                nueva !== repeticion ||
                actual === ''
              }
              onClick={() => void cambiar()}
            >
              {estado === 'trabajando' ? 'Cambiando…' : 'Cambiar contraseña'}
            </Boton>
            <Boton
              onClick={() => {
                setAbierto(false);
                setActual('');
                setNueva('');
                setRepeticion('');
              }}
            >
              Cancelar
            </Boton>
          </div>
        </div>
      )}
    </Bloque>
  );
}

// ---------------------------------------------------------------------------
// Segundo factor
// ---------------------------------------------------------------------------

function SegundoFactor({ activoDesde }: { activoDesde: string | null }): React.JSX.Element {
  const [paso, setPaso] = useState<'quieto' | 'contrasena' | 'escanear' | 'hecho'>('quieto');
  const [password, setPassword] = useState('');
  const [codigo, setCodigo] = useState('');
  const [nuevo, setNuevo] = useState<{ secreto: string; uri: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState(false);

  async function empezar(): Promise<void> {
    setError(null);
    setTrabajando(true);

    try {
      const credenciales = credencialesDeLaBoveda();
      if (credenciales === null) {
        throw new Error('Vuelve a abrir la bóveda para cambiar de aplicación.');
      }

      // Se manda la authKey, que es lo que el servidor sabe comprobar. La
      // contraseña escrita solo sirve para derivarla y no sale de aquí.
      const { authKey } = await deriveSecrets(
        password,
        base64ToBytes(credenciales.kdfSalt),
        credenciales.kdfParams,
      );

      setNuevo(await totp.cambiar(bytesToBase64(authKey)));
      setPaso('escanear');
    } catch (fallo) {
      setError(fallo instanceof Error ? fallo.message : 'No se pudo empezar el cambio.');
    } finally {
      setPassword('');
      setTrabajando(false);
    }
  }

  async function confirmar(): Promise<void> {
    setError(null);
    setTrabajando(true);

    try {
      await totp.confirmarCambio(codigo.trim());
      setPaso('hecho');
      setNuevo(null);
    } catch (fallo) {
      setError(fallo instanceof Error ? fallo.message : 'El código no es correcto.');
    } finally {
      setCodigo('');
      setTrabajando(false);
    }
  }

  return (
    <Bloque
      titulo="Doble factor"
      nota={
        activoDesde === null
          ? 'sin configurar'
          : `TOTP · activo desde ${formatearFecha(activoDesde)}`
      }
      icono={<IconoLlave tamano={20} />}
    >
      <Explicacion>
        {activoDesde === null ? (
          <>
            Esta bóveda no tiene segundo factor. Quien te robe la contraseña entra sin más
            obstáculos.
          </>
        ) : (
          <>
            Compatible con cualquier aplicación TOTP. Protege la <em>sesión</em>, no el cifrado: no
            hay forma de leer un fichero sin la contraseña maestra, con código o sin él.
          </>
        )}
      </Explicacion>

      {paso === 'hecho' && (
        <Aviso>
          <span style={{ flexShrink: 0, display: 'flex' }}>
            <IconoLlave tamano={18} />
          </span>
          <span>
            Cambiado. A partir de ahora entra con la aplicación nueva; la anterior ya no vale y
            puedes borrar la cuenta de ella.
          </span>
        </Aviso>
      )}

      {paso === 'quieto' && activoDesde !== null && (
        <div style={{ display: 'flex', gap: espacio.m, alignItems: 'center', flexWrap: 'wrap' }}>
          <Boton
            onClick={() => {
              setPaso('contrasena');
            }}
          >
            Cambiar de aplicación
          </Boton>
          <span style={{ fontSize: texto.menudo, color: color.tinta.tenue }}>
            Si cambias de móvil o desinstalas la app.
          </span>
        </div>
      )}

      {paso === 'contrasena' && (
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: espacio.m, maxWidth: '400px' }}
        >
          <Campo
            etiqueta="Contraseña maestra"
            tipo="password"
            valor={password}
            alCambiar={setPassword}
            ayuda="Se pide la contraseña y no un código del autenticador actual: si has perdido el móvil, un código no lo tendrías."
          />

          {error !== null && (
            <Aviso tono="peligro">
              <span>{error}</span>
            </Aviso>
          )}

          <div style={{ display: 'flex', gap: espacio.m }}>
            <Boton
              tono="primario"
              deshabilitado={password === '' || trabajando}
              onClick={() => void empezar()}
            >
              {trabajando ? 'Comprobando…' : 'Continuar'}
            </Boton>
            <Boton
              onClick={() => {
                setPaso('quieto');
                setPassword('');
                setError(null);
              }}
            >
              Cancelar
            </Boton>
          </div>
        </div>
      )}

      {paso === 'escanear' && nuevo !== null && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: espacio.l }}>
          <Aviso>
            <span style={{ flexShrink: 0, display: 'flex' }}>
              <IconoAviso tamano={18} />
            </span>
            <span>
              <strong>Tu aplicación actual sigue funcionando</strong> hasta que confirmes un código
              de la nueva. Si algo sale mal aquí no pierdes el acceso: basta con cancelar.
            </span>
          </Aviso>

          <div style={{ display: 'flex', gap: espacio.xl, flexWrap: 'wrap' }}>
            <CodigoQR texto={nuevo.uri} tamano={176} />

            <div
              style={{
                flexGrow: 1,
                minWidth: '220px',
                display: 'flex',
                flexDirection: 'column',
                gap: espacio.m,
              }}
            >
              <span style={{ fontSize: texto.menudo, color: color.tinta.tenue }}>
                ¿Sin cámara? Escribe este secreto a mano:
              </span>
              <code
                style={{
                  fontFamily: fuente.mono,
                  fontSize: texto.auxiliar,
                  color: color.tinta.fuerte,
                  background: color.superficie.tenue,
                  border: `1px solid ${color.borde.fuerte}`,
                  borderRadius: radio.m,
                  padding: espacio.m,
                  wordBreak: 'break-all',
                  lineHeight: 1.6,
                }}
              >
                {nuevo.secreto}
              </code>
            </div>
          </div>

          <div
            style={{ maxWidth: '400px', display: 'flex', flexDirection: 'column', gap: espacio.m }}
          >
            <Campo
              etiqueta="Código de la aplicación nueva"
              valor={codigo}
              alCambiar={setCodigo}
              mono
              placeholder="000000"
            />

            {error !== null && (
              <Aviso tono="peligro">
                <span>{error}</span>
              </Aviso>
            )}

            <div style={{ display: 'flex', gap: espacio.m }}>
              <Boton
                tono="primario"
                deshabilitado={codigo.trim().length < 6 || trabajando}
                onClick={() => void confirmar()}
              >
                {trabajando ? 'Comprobando…' : 'Confirmar el cambio'}
              </Boton>
              <Boton
                onClick={() => {
                  setPaso('quieto');
                  setNuevo(null);
                  setCodigo('');
                  setError(null);
                }}
              >
                Cancelar
              </Boton>
            </div>
          </div>
        </div>
      )}
    </Bloque>
  );
}

// ---------------------------------------------------------------------------
// Emergency Kit
// ---------------------------------------------------------------------------

function EmergencyKit({
  tieneRecuperacion,
  email,
}: {
  tieneRecuperacion: boolean;
  email: string;
}): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [nuevo, setNuevo] = useState<string | null>(null);
  const [abierto, setAbierto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState(false);

  async function regenerar(): Promise<void> {
    setError(null);
    setTrabajando(true);

    let mk: Uint8Array | null = null;
    try {
      const credenciales = credencialesDeLaBoveda();
      if (credenciales === null) {
        throw new Error('Vuelve a abrir la bóveda para regenerar el kit.');
      }

      // Se pide la contrasena otra vez, y no es burocracia: la clave maestra
      // vive en memoria como CryptoKey NO EXTRAIBLE, asi que sus bytes no se
      // pueden sacar de ahi. La unica forma de obtenerlos es desenvolverlos
      // de nuevo, y para eso hace falta la contrasena.
      mk = await exportarMasterKeyParaRecuperacion(password, credenciales);

      const datos = await crearRecuperacion(mk);
      await recuperacion.guardar(datos.recoveryWrappedKey, datos.recoverySalt);

      setNuevo(datos.passphrase);
      setAbierto(false);
    } catch (fallo) {
      setError(
        fallo instanceof Error
          ? fallo.message
          : 'No se pudo regenerar el kit. ¿Es esa la contraseña?',
      );
    } finally {
      mk?.fill(0);
      setPassword('');
      setTrabajando(false);
    }
  }

  function descargar(): void {
    if (nuevo === null) {
      return;
    }
    const texto = textoDelFicheroDeRecuperacion(nuevo, email, new Date().toISOString());
    const url = URL.createObjectURL(new Blob([texto], { type: 'text/plain;charset=utf-8' }));
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = 'locker-emergency-kit.txt';
    enlace.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Bloque
      titulo="Emergency Kit"
      nota={tieneRecuperacion ? 'generado' : 'no hay ninguno'}
      icono={<IconoDescargar tamano={20} />}
    >
      {nuevo === null ? (
        <>
          <Explicacion>
            Generar uno nuevo <strong>invalida el anterior en el acto</strong>. Si ese papel está en
            una caja fuerte o en casa de alguien, deja de servir: recógelo y destrúyelo. La
            passphrase nueva también se muestra una sola vez.
          </Explicacion>

          {!abierto ? (
            <Boton
              onClick={() => {
                setAbierto(true);
              }}
            >
              Regenerar Emergency Kit
            </Boton>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: espacio.m,
                maxWidth: '400px',
              }}
            >
              <Campo
                etiqueta="Contraseña maestra"
                tipo="password"
                valor={password}
                alCambiar={setPassword}
                ayuda="Hace falta para desenvolver la clave maestra: sin ella no hay nada que envolver de nuevo."
              />

              {error !== null && (
                <Aviso tono="peligro">
                  <span>{error}</span>
                </Aviso>
              )}

              <div style={{ display: 'flex', gap: espacio.m }}>
                <Boton
                  tono="primario"
                  deshabilitado={password === '' || trabajando}
                  onClick={() => void regenerar()}
                >
                  {trabajando ? 'Generando…' : 'Generar el nuevo'}
                </Boton>
                <Boton
                  onClick={() => {
                    setAbierto(false);
                    setPassword('');
                  }}
                >
                  Cancelar
                </Boton>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <Aviso tono="peligro">
            <span style={{ flexShrink: 0, display: 'flex' }}>
              <IconoAviso tamano={18} />
            </span>
            <span>
              El kit anterior <strong>ya no sirve</strong>. Guarda este y destruye el viejo. No
              volverá a mostrarse.
            </span>
          </Aviso>

          <div
            style={{
              background: color.papel,
              color: color.papelTinta,
              borderRadius: radio.m,
              padding: espacio.l,
              display: 'grid',
              gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
              gap: espacio.s,
            }}
          >
            {nuevo.split('-').map((grupo, indice) => (
              <span
                key={grupo + String(indice)}
                style={{ display: 'flex', gap: espacio.s, alignItems: 'baseline' }}
              >
                <span style={{ fontFamily: fuente.mono, fontSize: texto.menudo, opacity: 0.45 }}>
                  {String(indice + 1).padStart(2, '0')}
                </span>
                <span style={{ fontFamily: fuente.mono, fontSize: texto.cuerpo }}>{grupo}</span>
              </span>
            ))}
          </div>

          <Boton tono="primario" onClick={descargar}>
            <IconoDescargar tamano={18} />
            Descargar el kit
          </Boton>
        </>
      )}
    </Bloque>
  );
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

export interface EntradaDeAuditoria {
  accion: string;
  nodeId: string | null;
  ip: string | null;
  detalle: string | null;
  fecha: string;
}

/**
 * Nombres legibles de las acciones.
 *
 * El registro guarda una etiqueta corta; traducirla aquí y no en la base de
 * datos permite cambiar el texto sin reescribir el historial.
 */
const NOMBRES: Record<string, string> = {
  login: 'Bóveda abierta',
  subida: 'Fichero subido',
  descarga: 'Fichero descargado',
  papelera: 'Movido a la papelera',
  restaurar: 'Restaurado de la papelera',
  totp_activado: 'Segundo factor activado',
  totp_verificado: 'Segundo factor verificado',
  recuperacion_generada: 'Emergency Kit generado',
  recuperacion_usada: 'Bóveda recuperada con el Emergency Kit',
  password_cambiada: 'Contraseña maestra cambiada',
  password_fallida: 'Intento fallido de cambio de contraseña',
  borrado_definitivo: 'Borrado definitivo',
  vaciar_papelera: 'Papelera vaciada',
};

function RegistroDeAuditoria({
  entradas,
}: {
  entradas: EntradaDeAuditoria[] | null;
}): React.JSX.Element {
  return (
    <Bloque titulo="Registro de actividad" icono={<IconoAviso tamano={20} />}>
      {entradas === null && (
        <span style={{ fontSize: texto.auxiliar, color: color.tinta.tenue }}>Cargando…</span>
      )}

      {entradas?.length === 0 && (
        <span style={{ fontSize: texto.auxiliar, color: color.tinta.tenue }}>
          Todavía no hay actividad registrada.
        </span>
      )}

      {entradas !== null && entradas.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {entradas.map((entrada, indice) => (
            <div
              key={entrada.fecha + String(indice)}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: espacio.m,
                padding: `${espacio.s} 0`,
                borderBottom:
                  indice === entradas.length - 1 ? 'none' : `1px solid ${color.borde.sutil}`,
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontSize: texto.auxiliar, color: color.tinta.fuerte }}>
                {NOMBRES[entrada.accion] ?? entrada.accion}
              </span>
              <span style={{ flexGrow: 1 }} />
              <span
                style={{
                  fontFamily: fuente.mono,
                  fontSize: texto.menudo,
                  color: color.tinta.tenue,
                }}
              >
                {new Date(entrada.fecha).toLocaleString('es-ES', {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                {entrada.ip !== null && ` · ${entrada.ip}`}
              </span>
            </div>
          ))}
        </div>
      )}

      <Explicacion>
        El registro anota cuándo y desde dónde.{' '}
        <strong>Nunca qué había dentro de un fichero</strong>: eso el servidor no lo sabe.
      </Explicacion>
    </Bloque>
  );
}
