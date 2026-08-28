import {
  createVault,
  crearRecuperacion,
  exportarMasterKeyParaRecuperacion,
  KDF_PARAMS_V1,
  textoDelFicheroDeRecuperacion,
  unlockVault,
  type VaultCredentials,
} from '@locker/crypto';
import { useRef, useState } from 'react';

import { auth, recuperacion, totp } from '../api/cliente.js';
import { Casilla } from '../ui/Casilla.js';
import { CodigoQR } from '../ui/CodigoQR.js';
import { Aviso, Boton, Campo, Titular } from '../ui/componentes.js';
import { IconoAviso, IconoCandado, IconoDescargar, IconoSinVista } from '../ui/Iconos.js';
import { useTamanoDePantalla } from '../ui/pantalla.js';
import { color, espacio, fuente, radio, texto } from '../ui/tokens.js';
import { abrirBoveda } from '../vault/boveda.js';

/**
 * Alta de la cuenta.
 *
 * Ocurre UNA VEZ en la vida de la bóveda y decide si el usuario podrá volver
 * a entrar dentro de dos años. Todo lo que parece fricción aquí está puesto
 * a propósito.
 *
 * Tres pasos: cuenta, segundo factor y Emergency Kit. El kit va el último
 * porque necesita la clave maestra, que no existe hasta que hay cuenta.
 */

type Paso = 'cuenta' | 'doble-factor' | 'kit';

/** Mínimo de la contraseña maestra. Ver el porqué en `fuerza()`. */
const MINIMO_DE_CARACTERES = 12;

export function Alta({ alEntrar }: { alEntrar: () => void }): React.JSX.Element {
  const [paso, setPaso] = useState<Paso>('cuenta');
  const tamano = useTamanoDePantalla();

  /**
   * Credenciales y contraseña durante el alta.
   *
   * Van en una ref y no en el estado porque no se pintan: solo hacen falta
   * para derivar la clave maestra en el último paso. Se borran en cuanto el
   * kit está guardado.
   */
  const enCurso = useRef<{
    email: string;
    password: string;
    credenciales: VaultCredentials;
  } | null>(null);

  return (
    <div
      style={{
        minHeight: '100vh',
        background: color.fondo,
        color: color.tinta.fuerte,
        fontFamily: fuente.sans,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Pasos actual={paso} />

      <div
        style={{
          flexGrow: 1,
          display: 'flex',
          justifyContent: 'center',
          padding:
            tamano === 'ancho' ? `${espacio.xxl} ${espacio.xl}` : `${espacio.l} ${espacio.m}`,
        }}
      >
        {paso === 'cuenta' && (
          <PasoDeCuenta
            alCrear={(datos) => {
              enCurso.current = datos;
              setPaso('doble-factor');
            }}
          />
        )}

        {paso === 'doble-factor' && (
          <PasoDeSegundoFactor
            alTerminar={() => {
              setPaso('kit');
            }}
          />
        )}

        {paso === 'kit' && enCurso.current !== null && (
          <PasoDelKit
            email={enCurso.current.email}
            password={enCurso.current.password}
            credenciales={enCurso.current.credenciales}
            alTerminar={() => {
              enCurso.current = null;
              alEntrar();
            }}
          />
        )}
      </div>
    </div>
  );
}

function Pasos({ actual }: { actual: Paso }): React.JSX.Element {
  const tamano = useTamanoDePantalla();

  // En estrecho se quedan solo los numeros: el paso donde estas se ve por el
  // color, y los rotulos completos no caben sin partirse en dos lineas.
  const pasos: { clave: Paso; rotulo: string }[] =
    tamano === 'minimo'
      ? [
          { clave: 'cuenta', rotulo: '01' },
          { clave: 'doble-factor', rotulo: '02' },
          { clave: 'kit', rotulo: '03' },
        ]
      : [
          { clave: 'cuenta', rotulo: '01 Cuenta' },
          { clave: 'doble-factor', rotulo: '02 Doble factor' },
          { clave: 'kit', rotulo: '03 Emergency Kit' },
        ];

  const indiceActual = pasos.findIndex((p) => p.clave === actual);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: espacio.m,
        padding: `${espacio.l} ${espacio.xl}`,
        borderBottom: `1px solid ${color.borde.sutil}`,
        flexWrap: 'wrap',
      }}
    >
      <span style={{ color: color.laton, display: 'flex' }}>
        <IconoCandado tamano={19} />
      </span>
      <span style={{ fontFamily: fuente.serifa, fontSize: texto.subtitulo }}>Locker</span>

      <span style={{ flexGrow: 1 }} />

      {pasos.map((p, indice) => (
        <span key={p.clave} style={{ display: 'flex', alignItems: 'center', gap: espacio.m }}>
          {indice > 0 && (
            <span style={{ width: '18px', height: '1px', background: color.borde.fuerte }} />
          )}
          <span
            style={{
              fontFamily: fuente.mono,
              fontSize: texto.menudo,
              letterSpacing: '0.08em',
              color:
                indice === indiceActual
                  ? color.laton
                  : indice < indiceActual
                    ? color.tinta.media
                    : color.tinta.tenue,
            }}
          >
            {p.rotulo}
          </span>
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Paso 1: la cuenta
// ---------------------------------------------------------------------------

function PasoDeCuenta({
  alCrear,
}: {
  alCrear: (datos: { email: string; password: string; credenciales: VaultCredentials }) => void;
}): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [repeticion, setRepeticion] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState(false);

  const calidad = fuerza(password);
  const coincide = repeticion === '' || password === repeticion;
  const puedeSeguir =
    email.includes('@') && password.length >= MINIMO_DE_CARACTERES && password === repeticion;

  async function crear(): Promise<void> {
    setError(null);
    setTrabajando(true);

    try {
      // Argon2id con 64 MiB tarda ~100 ms y ocurre AQUÍ, en el navegador. La
      // contraseña no sale de esta página en ningún momento: al servidor solo
      // le llega una clave derivada por otra rama, que no sirve para descifrar.
      const { credentials } = await createVault(password);

      await auth.registrar({
        email: email.trim().toLowerCase(),
        kdfSalt: credentials.kdfSalt,
        kdfParamsVersion: credentials.kdfParams.version,
        authKey: credentials.authKey,
        wrappedMasterKey: credentials.wrappedMasterKey,
      });

      // Iniciar sesión de inmediato: los dos pasos siguientes (segundo factor
      // y kit) hablan con endpoints que exigen sesión.
      await auth.login(email.trim().toLowerCase(), credentials.authKey);

      const { vault } = await unlockVault(password, credentials);
      abrirBoveda(vault, credentials);

      alCrear({ email: email.trim().toLowerCase(), password, credenciales: credentials });
    } catch (fallo) {
      setError(fallo instanceof Error ? fallo.message : 'No se pudo crear la cuenta.');
      setTrabajando(false);
    }
  }

  return (
    <div
      style={{
        width: 'min(460px, 100%)',
        display: 'flex',
        flexDirection: 'column',
        gap: espacio.xl,
      }}
    >
      <Titular>Crea tu bóveda</Titular>

      <p style={{ margin: 0, fontSize: texto.cuerpo, color: color.tinta.media, lineHeight: 1.55 }}>
        Esta contraseña no abre una cuenta: <strong>es la llave</strong>. Se convierte aquí, en tu
        navegador, en la clave que cifra tus ficheros. No viaja, no se guarda y nadie más la tiene.
      </p>

      {/*
        Los `autocomplete` del alta sirven para lo contrario que los del
        login: no para rellenar, sino para que el gestor de contraseñas
        reconozca esto como un registro y ofrezca GUARDAR la credencial nueva.
      */}
      <Campo
        etiqueta="Correo"
        tipo="email"
        valor={email}
        alCambiar={setEmail}
        autoFocus
        id="email"
        nombre="email"
        autoCompletar="username"
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: espacio.s }}>
        <Campo
          etiqueta="Contraseña maestra"
          tipo="password"
          valor={password}
          alCambiar={setPassword}
          ayuda={`Mínimo ${String(MINIMO_DE_CARACTERES)} caracteres. La longitud importa mucho más que los símbolos raros.`}
          id="password"
          nombre="password"
          autoCompletar="new-password"
        />
        {password !== '' && <Medidor calidad={calidad} />}
      </div>

      <Campo
        etiqueta="Repite la contraseña"
        tipo="password"
        valor={repeticion}
        alCambiar={setRepeticion}
        error={coincide ? undefined : 'No coinciden.'}
        id="password-repetida"
        nombre="password-repetida"
        autoCompletar="new-password"
      />

      <Aviso tono="peligro">
        <span style={{ flexShrink: 0, display: 'flex', marginTop: '1px' }}>
          <IconoAviso tamano={18} />
        </span>
        <span>
          <strong>No hay forma de restablecerla.</strong> Un servidor que pudiera devolverte el
          acceso sería un servidor capaz de leer tus ficheros. En el último paso se genera una clave
          de recuperación para el día que se te olvide.
        </span>
      </Aviso>

      {error !== null && (
        <Aviso tono="peligro">
          <span>{error}</span>
        </Aviso>
      )}

      <Boton
        tono="primario"
        ancho
        deshabilitado={!puedeSeguir || trabajando}
        onClick={() => void crear()}
      >
        {trabajando ? 'Creando la bóveda…' : 'Crear la bóveda'}
      </Boton>
    </div>
  );
}

/**
 * Estimación de la fuerza, deliberadamente simple.
 *
 * No se usa una librería de estimación: pesan cientos de kilobytes de
 * diccionarios y aquí cada dependencia del cliente es superficie de ataque
 * sobre la clave maestra. Lo que se le dice al usuario es lo único que de
 * verdad decide: alarga la contraseña.
 */
function fuerza(password: string): { nivel: 0 | 1 | 2 | 3; rotulo: string } {
  if (password.length === 0) {
    return { nivel: 0, rotulo: '' };
  }
  if (password.length < MINIMO_DE_CARACTERES) {
    return { nivel: 0, rotulo: `Corta: faltan ${String(MINIMO_DE_CARACTERES - password.length)}` };
  }

  const variedad = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) =>
    r.test(password),
  ).length;

  if (password.length >= 20 || (password.length >= 16 && variedad >= 3)) {
    return { nivel: 3, rotulo: 'Buena' };
  }
  if (password.length >= 16 || variedad >= 3) {
    return { nivel: 2, rotulo: 'Aceptable' };
  }
  return { nivel: 1, rotulo: 'Justa: alárgala un poco más' };
}

function Medidor({ calidad }: { calidad: ReturnType<typeof fuerza> }): React.JSX.Element {
  const tonos = [color.peligro, color.peligro, color.laton, color.verdin];

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: espacio.m }}>
      <div style={{ display: 'flex', gap: '3px', flexGrow: 1 }}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              flexGrow: 1,
              height: '3px',
              borderRadius: '1px',
              background: i < calidad.nivel ? tonos[calidad.nivel] : color.superficie.chip,
            }}
          />
        ))}
      </div>
      <span style={{ fontSize: texto.menudo, color: color.tinta.tenue, whiteSpace: 'nowrap' }}>
        {calidad.rotulo}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Paso 2: segundo factor
// ---------------------------------------------------------------------------

function PasoDeSegundoFactor({ alTerminar }: { alTerminar: () => void }): React.JSX.Element {
  const [datos, setDatos] = useState<{ secreto: string; uri: string } | null>(null);
  const [codigo, setCodigo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState(false);
  const pedido = useRef(false);

  if (!pedido.current) {
    pedido.current = true;
    void totp
      .iniciar()
      .then(setDatos)
      .catch((fallo: unknown) => {
        setError(fallo instanceof Error ? fallo.message : 'No se pudo preparar el segundo factor.');
      });
  }

  async function confirmar(): Promise<void> {
    setError(null);
    setTrabajando(true);
    try {
      await totp.confirmar(codigo.trim());
      alTerminar();
    } catch (fallo) {
      setError(fallo instanceof Error ? fallo.message : 'El código no es correcto.');
      setTrabajando(false);
    }
  }

  return (
    <div
      style={{
        width: 'min(520px, 100%)',
        display: 'flex',
        flexDirection: 'column',
        gap: espacio.xl,
      }}
    >
      <Titular>Añade un segundo factor</Titular>

      <p style={{ margin: 0, fontSize: texto.cuerpo, color: color.tinta.media, lineHeight: 1.55 }}>
        Escanea este código con tu aplicación de autenticación. El segundo factor protege la{' '}
        <em>sesión</em>, no el cifrado: quien robara tu contraseña seguiría necesitando tu móvil
        para entrar.
      </p>

      {datos !== null && (
        <div
          style={{
            display: 'flex',
            gap: espacio.xl,
            alignItems: 'flex-start',
            flexWrap: 'wrap',
          }}
        >
          <CodigoQR texto={datos.uri} tamano={196} />

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
                fontSize: texto.cuerpo,
                color: color.tinta.fuerte,
                background: color.superficie.tenue,
                border: `1px solid ${color.borde.fuerte}`,
                borderRadius: radio.m,
                padding: espacio.m,
                wordBreak: 'break-all',
                lineHeight: 1.6,
              }}
            >
              {datos.secreto}
            </code>
          </div>
        </div>
      )}

      <Campo
        etiqueta="Código de 6 dígitos"
        valor={codigo}
        alCambiar={setCodigo}
        mono
        placeholder="000000"
        ayuda="Se confirma contra el servidor antes de darlo por activo: si el reloj de tu móvil no cuadra, es mejor descubrirlo ahora que en el próximo inicio de sesión."
        id="totp"
        nombre="totp"
        autoCompletar="one-time-code"
        modoDeTeclado="numeric"
        longitudMaxima={6}
      />

      {error !== null && (
        <Aviso tono="peligro">
          <span>{error}</span>
        </Aviso>
      )}

      <Boton
        tono="primario"
        ancho
        deshabilitado={codigo.trim().length < 6 || trabajando}
        onClick={() => void confirmar()}
      >
        {trabajando ? 'Comprobando…' : 'Activar el segundo factor'}
      </Boton>

      <button
        type="button"
        onClick={alTerminar}
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
        Ahora no — puedo activarlo luego desde Ajustes
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Paso 3: el Emergency Kit
// ---------------------------------------------------------------------------

function PasoDelKit({
  email,
  password,
  credenciales,
  alTerminar,
}: {
  email: string;
  password: string;
  credenciales: VaultCredentials;
  alTerminar: () => void;
}): React.JSX.Element {
  const [kit, setKit] = useState<{ passphrase: string; grupos: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);
  const [entendido, setEntendido] = useState(false);
  const [comprobacion, setComprobacion] = useState('');
  const pedido = useRef(false);

  /**
   * Cuál de los grupos se pide para comprobar.
   *
   * Se fija una sola vez y al azar. Pedir siempre el mismo enseñaría a
   * memorizar ese trozo en lugar de guardar el kit entero.
   */
  const grupoAComprobar = useRef<number | null>(null);

  if (!pedido.current) {
    pedido.current = true;
    void generarKit();
  }

  async function generarKit(): Promise<void> {
    let mk: Uint8Array | null = null;
    try {
      // La clave maestra en claro vive lo mínimo: se saca, se envuelve con la
      // clave de recuperación y se borra en el `finally`.
      mk = await exportarMasterKeyParaRecuperacion(password, credenciales);
      const datos = await crearRecuperacion(mk, KDF_PARAMS_V1);

      await recuperacion.guardar(datos.recoveryWrappedKey, datos.recoverySalt);

      const grupos = datos.passphrase.split('-');
      grupoAComprobar.current ??= Math.floor(Math.random() * grupos.length);

      setKit({ passphrase: datos.passphrase, grupos });
    } catch (fallo) {
      setError(
        fallo instanceof Error ? fallo.message : 'No se pudo generar la clave de recuperación.',
      );
    } finally {
      mk?.fill(0);
    }
  }

  const esperado =
    grupoAComprobar.current === null ? '' : (kit?.grupos[grupoAComprobar.current] ?? '');
  const comprobacionCorrecta =
    esperado !== '' && comprobacion.trim().toUpperCase() === esperado.toUpperCase();
  const puedeEntrar = guardado && entendido && comprobacionCorrecta;

  function descargar(): void {
    if (kit === null) {
      return;
    }

    const texto = textoDelFicheroDeRecuperacion(kit.passphrase, email, new Date().toISOString());
    const url = URL.createObjectURL(new Blob([texto], { type: 'text/plain;charset=utf-8' }));

    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = 'locker-emergency-kit.txt';
    enlace.click();

    URL.revokeObjectURL(url);
    setGuardado(true);
  }

  if (error !== null) {
    return (
      <div style={{ width: 'min(560px, 100%)' }}>
        <Aviso tono="peligro">
          <span>{error}</span>
        </Aviso>
      </div>
    );
  }

  if (kit === null) {
    return <span style={{ color: color.tinta.media }}>Generando tu clave de recuperación…</span>;
  }

  return (
    <div
      style={{
        width: 'min(920px, 100%)',
        display: 'flex',
        flexDirection: 'column',
        gap: espacio.xl,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: espacio.m }}>
        <Titular>
          Tu Emergency Kit. <span style={{ color: color.tinta.tenue }}>Una sola vez.</span>
        </Titular>
        <p
          style={{ margin: 0, fontSize: texto.cuerpo, color: color.tinta.media, lineHeight: 1.55 }}
        >
          Esta clave abre tu bóveda si olvidas la contraseña maestra. Vale exactamente lo mismo que
          ella. En cuanto pases de esta pantalla no volverá a aparecer: no la guardamos en ninguna
          parte.
        </p>
      </div>

      <div style={{ display: 'flex', gap: espacio.xl, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <Papel email={email} grupos={kit.grupos} />

        <div
          style={{
            flexGrow: 1,
            minWidth: '280px',
            display: 'flex',
            flexDirection: 'column',
            gap: espacio.l,
          }}
        >
          <Recordatorio
            icono={<IconoSinVista tamano={20} />}
            titulo="Se muestra una sola vez"
            tono={color.laton}
          >
            Al continuar desaparece de la pantalla y de la memoria. No hay ningún sitio en Ajustes
            donde volver a leerla.
          </Recordatorio>

          <Recordatorio
            icono={<IconoCandado tamano={20} />}
            titulo="El servidor no la conserva"
            tono={color.laton}
          >
            Se generó aquí, en tu navegador. Nunca ha viajado. No podemos enviártela por correo ni
            reponerla.
          </Recordatorio>

          <Recordatorio
            icono={<IconoAviso tamano={20} />}
            titulo="Sin kit y sin contraseña, no hay vuelta atrás"
            tono={color.peligro}
          >
            Los ficheros se quedan cifrados para siempre. No es una política que podamos saltarnos:
            es que la clave no existe en ningún otro sitio.
          </Recordatorio>
        </div>
      </div>

      <div style={{ display: 'flex', gap: espacio.m, flexWrap: 'wrap', alignItems: 'center' }}>
        <Boton tono="primario" onClick={descargar}>
          <IconoDescargar tamano={18} />
          Descargar el kit
        </Boton>
        <Boton
          onClick={() => {
            window.print();
            setGuardado(true);
          }}
        >
          Imprimir
        </Boton>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: espacio.m,
          paddingTop: espacio.l,
          borderTop: `1px solid ${color.borde.sutil}`,
        }}
      >
        <Casilla
          marcada={guardado}
          alCambiar={() => {
            setGuardado(!guardado);
          }}
          etiqueta="He guardado el Emergency Kit fuera de este ordenador."
          conTexto
        />
        <Casilla
          marcada={entendido}
          alCambiar={() => {
            setEntendido(!entendido);
          }}
          etiqueta="Entiendo que si pierdo el kit y la contraseña, pierdo los ficheros para siempre."
          conTexto
        />
      </div>

      {/*
        La comprobación de verdad. Dos casillas se marcan sin leer; copiar un
        grupo concreto solo se puede hacer teniendo el kit delante, que es
        justo lo que hay que demostrar antes de dejar pasar.
      */}
      <div style={{ maxWidth: '340px' }}>
        <Campo
          etiqueta={`Copia el grupo ${String((grupoAComprobar.current ?? 0) + 1).padStart(2, '0')} de tu kit`}
          valor={comprobacion}
          alCambiar={setComprobacion}
          mono
          placeholder="····"
          error={
            comprobacion.trim() !== '' && !comprobacionCorrecta
              ? 'No es ese grupo. Míralo en el kit que acabas de guardar.'
              : undefined
          }
          ayuda="Sin esto no se puede continuar: es la única forma de saber que el kit está donde dices."
        />
      </div>

      <Boton tono="primario" ancho deshabilitado={!puedeEntrar} onClick={alTerminar}>
        Entrar en la bóveda
      </Boton>
    </div>
  );
}

/**
 * El papel.
 *
 * La ÚNICA superficie clara de toda la app, y no es un capricho: esto está
 * pensado para acabar impreso. Un rectángulo oscuro a pantalla completa
 * gasta tinta y se lee peor en papel.
 */
function Papel({ email, grupos }: { email: string; grupos: string[] }): React.JSX.Element {
  return (
    <div
      style={{
        width: 'min(420px, 100%)',
        background: color.papel,
        color: color.papelTinta,
        borderRadius: radio.l,
        padding: espacio.xl,
        display: 'flex',
        flexDirection: 'column',
        gap: espacio.l,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: espacio.s }}>
        <IconoCandado tamano={18} />
        <span style={{ fontSize: texto.auxiliar, fontWeight: 600 }}>
          Locker DrApps · Emergency Kit
        </span>
        <span style={{ flexGrow: 1 }} />
        <span style={{ fontFamily: fuente.mono, fontSize: texto.menudo, opacity: 0.7 }}>
          {new Date().toLocaleDateString('es-ES', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          })}
        </span>
      </div>

      <div style={{ height: '1px', background: 'currentColor', opacity: 0.15 }} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: espacio.s }}>
        <DatoDelPapel etiqueta="Cuenta" valor={email} />
        <DatoDelPapel etiqueta="Alfabeto" valor="sin I L O U 0 1" />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: espacio.s,
        }}
      >
        {grupos.map((grupo, indice) => (
          <div
            key={grupo + String(indice)}
            style={{ display: 'flex', alignItems: 'baseline', gap: espacio.s }}
          >
            <span style={{ fontFamily: fuente.mono, fontSize: texto.menudo, opacity: 0.45 }}>
              {String(indice + 1).padStart(2, '0')}
            </span>
            <span
              style={{
                fontFamily: fuente.mono,
                fontSize: texto.destacado,
                letterSpacing: '0.06em',
              }}
            >
              {grupo}
            </span>
          </div>
        ))}
      </div>

      <div style={{ height: '1px', background: 'currentColor', opacity: 0.15 }} />

      <span style={{ fontSize: texto.menudo, lineHeight: 1.5, opacity: 0.75 }}>
        Escríbela a mano si quieres: el alfabeto no incluye I, L, O, U, 0 ni 1, así que no hay
        caracteres que se confundan. Guárdala donde guardarías una escritura, no donde guardas
        contraseñas.
      </span>
    </div>
  );
}

function DatoDelPapel({ etiqueta, valor }: { etiqueta: string; valor: string }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: espacio.s }}>
      <span style={{ fontSize: texto.menudo, opacity: 0.55, minWidth: '68px' }}>{etiqueta}</span>
      <span style={{ fontFamily: fuente.mono, fontSize: texto.auxiliar }}>{valor}</span>
    </div>
  );
}

function Recordatorio({
  icono,
  titulo,
  tono,
  children,
}: {
  icono: React.ReactNode;
  titulo: string;
  tono: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', gap: espacio.m, alignItems: 'flex-start' }}>
      <span style={{ color: tono, display: 'flex', flexShrink: 0, marginTop: '2px' }}>{icono}</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: espacio.xs }}>
        <span style={{ fontSize: texto.cuerpo, fontWeight: 500, color: color.tinta.fuerte }}>
          {titulo}
        </span>
        <span style={{ fontSize: texto.auxiliar, color: color.tinta.media, lineHeight: 1.5 }}>
          {children}
        </span>
      </div>
    </div>
  );
}
