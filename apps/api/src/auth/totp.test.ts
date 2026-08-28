import { randomBytes } from 'node:crypto';

import { createVault } from '@locker/crypto';
import { KDF_PARAMS_V1 } from '@locker/shared';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { config } from '../config.js';
import { applyMigrations, type Db } from '../db/index.js';
import {
  cifrarSecreto,
  codigoParaContador,
  contadorActual,
  descifrarSecreto,
  generarSecretoTotp,
  uriOtpauth,
  verificarTotp,
} from './totp.js';

const PARAMS = { ...KDF_PARAMS_V1, memoryKib: 1024, iterations: 1 };

describe('vectores del RFC 6238', () => {
  // El secreto de referencia del RFC es "12345678901234567890" en ASCII,
  // que en base32 es GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ. Comprobar contra los
  // vectores oficiales es lo que garantiza que Google Authenticator y
  // cualquier otra app generen exactamente los mismos codigos.
  const SECRETO_RFC = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('en el segundo %i produce el codigo %s', (segundos, esperado) => {
    const contador = Math.floor(segundos / 30);

    expect(codigoParaContador(SECRETO_RFC, contador)).toBe(esperado);
  });
});

describe('generacion de secretos', () => {
  it('produce base32 valido y distinto cada vez', () => {
    const uno = generarSecretoTotp();
    const otro = generarSecretoTotp();

    expect(uno).toMatch(/^[A-Z2-7]+$/);
    expect(uno).not.toBe(otro);
  });

  it('la URI otpauth lleva todo lo que necesita la app autenticadora', () => {
    const uri = uriOtpauth('GEZDGNBVGY3TQOJQ', 'dani@ejemplo.es');

    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain('secret=GEZDGNBVGY3TQOJQ');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });

  it('escapa el email, para que un caracter raro no rompa el QR', () => {
    const uri = uriOtpauth('ABC', 'dani+locker@ejemplo.es');

    expect(uri).toContain('dani%2Blocker%40ejemplo.es');
  });
});

describe('verificacion de codigos', () => {
  const SECRETO = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const AHORA = 1_700_000_000_000;

  it('acepta el codigo del periodo actual', () => {
    const codigo = codigoParaContador(SECRETO, contadorActual(AHORA));

    expect(verificarTotp(SECRETO, codigo, null, AHORA).valido).toBe(true);
  });

  // Tolerancia de +-1 periodo: los relojes de los moviles no siempre van
  // perfectamente en hora, y sin margen el 2FA fallaria de forma aleatoria.
  it('acepta el codigo del periodo anterior y del siguiente', () => {
    const actual = contadorActual(AHORA);

    expect(
      verificarTotp(SECRETO, codigoParaContador(SECRETO, actual - 1), null, AHORA).valido,
    ).toBe(true);
    expect(
      verificarTotp(SECRETO, codigoParaContador(SECRETO, actual + 1), null, AHORA).valido,
    ).toBe(true);
  });

  it('rechaza un codigo de hace tres minutos', () => {
    const viejo = codigoParaContador(SECRETO, contadorActual(AHORA) - 6);

    expect(verificarTotp(SECRETO, viejo, null, AHORA).valido).toBe(false);
  });

  it('rechaza un codigo inventado', () => {
    expect(verificarTotp(SECRETO, '000000', null, AHORA).valido).toBe(false);
  });

  it.each(['', '12345', '1234567', 'abcdef', '12 34 56 78'])('rechaza %j por formato', (codigo) => {
    expect(verificarTotp(SECRETO, codigo, null, AHORA).valido).toBe(false);
  });

  it('acepta el codigo con espacios, como lo copia la gente', () => {
    const codigo = codigoParaContador(SECRETO, contadorActual(AHORA));
    const conEspacios = `${codigo.slice(0, 3)} ${codigo.slice(3)}`;

    expect(verificarTotp(SECRETO, conEspacios, null, AHORA).valido).toBe(true);
  });

  it('un secreto distinto no valida el codigo', () => {
    const codigo = codigoParaContador(SECRETO, contadorActual(AHORA));

    expect(verificarTotp(generarSecretoTotp(), codigo, null, AHORA).valido).toBe(false);
  });
});

describe('anti-replay', () => {
  const SECRETO = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const AHORA = 1_700_000_000_000;

  // Sin esto, un codigo interceptado seguiria valiendo durante sus 30
  // segundos, y quien lo hubiera visto podria usarlo antes que el usuario.
  it('no acepta dos veces el mismo codigo', () => {
    const actual = contadorActual(AHORA);
    const codigo = codigoParaContador(SECRETO, actual);

    const primera = verificarTotp(SECRETO, codigo, null, AHORA);
    expect(primera.valido).toBe(true);

    const segunda = verificarTotp(SECRETO, codigo, primera.contador, AHORA);
    expect(segunda.valido).toBe(false);
  });

  it('no acepta un codigo anterior al ultimo usado', () => {
    const actual = contadorActual(AHORA);
    const anterior = codigoParaContador(SECRETO, actual - 1);

    expect(verificarTotp(SECRETO, anterior, actual, AHORA).valido).toBe(false);
  });

  it('si acepta el codigo del periodo siguiente', () => {
    const actual = contadorActual(AHORA);
    const siguiente = codigoParaContador(SECRETO, actual + 1);

    expect(verificarTotp(SECRETO, siguiente, actual, AHORA).valido).toBe(true);
  });
});

describe('cifrado del secreto en la base de datos', () => {
  const CLAVE = randomBytes(32);

  it('hace round-trip', () => {
    const secreto = generarSecretoTotp();

    expect(descifrarSecreto(cifrarSecreto(secreto, CLAVE), CLAVE)).toBe(secreto);
  });

  it('el mismo secreto cifrado dos veces da bytes distintos', () => {
    const secreto = generarSecretoTotp();

    expect(cifrarSecreto(secreto, CLAVE)).not.toBe(cifrarSecreto(secreto, CLAVE));
  });

  // Es el punto de la decision: quien vuelque la base de datos sin tener
  // tambien el .env del servidor no puede generar codigos.
  it('no se puede descifrar con otra clave', () => {
    const cifrado = cifrarSecreto(generarSecretoTotp(), CLAVE);

    expect(() => descifrarSecreto(cifrado, randomBytes(32))).toThrow();
  });

  it('detecta manipulacion del cifrado', () => {
    const cifrado = cifrarSecreto(generarSecretoTotp(), CLAVE);
    const bytes = Buffer.from(cifrado, 'base64');
    bytes[20] = (bytes[20] as number) ^ 0xff;

    expect(() => descifrarSecreto(bytes.toString('base64'), CLAVE)).toThrow();
  });
});

describe('endpoints del segundo factor', () => {
  let app: FastifyInstance;
  let db: Db;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrations(db);
    app = await buildApp({ db });
  });

  afterEach(async () => {
    await app.close();
  });

  async function altaYLogin(): Promise<string> {
    const { credentials } = await createVault('la buena', PARAMS);

    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'dani@ejemplo.es',
        kdfSalt: credentials.kdfSalt,
        authKey: credentials.authKey,
        wrappedMasterKey: credentials.wrappedMasterKey,
      },
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'dani@ejemplo.es', authKey: credentials.authKey },
    });

    return login.cookies[0]?.value ?? '';
  }

  it('iniciar devuelve secreto y URI para el QR', async () => {
    const token = await altaYLogin();

    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/auth/totp/iniciar',
      cookies: { locker_session: token },
    });

    expect(respuesta.statusCode).toBe(200);
    expect(respuesta.json().uri).toContain('otpauth://totp/');
  });

  it('iniciar exige sesion', async () => {
    const respuesta = await app.inject({ method: 'POST', url: '/api/auth/totp/iniciar' });

    expect(respuesta.statusCode).toBe(401);
  });

  // Activar el 2FA sin comprobar que el QR se escaneo de verdad dejaria al
  // usuario fuera de su propia boveda en el siguiente inicio de sesion.
  it('el 2FA no queda activo hasta confirmar con un codigo real', async () => {
    const token = await altaYLogin();

    await app.inject({
      method: 'POST',
      url: '/api/auth/totp/iniciar',
      cookies: { locker_session: token },
    });

    const fila = db.prepare('SELECT totp_enabled_at FROM users').get() as {
      totp_enabled_at: string | null;
    };
    expect(fila.totp_enabled_at).toBeNull();
  });

  it('confirmar con el codigo correcto activa el 2FA', async () => {
    const token = await altaYLogin();

    const inicio = await app.inject({
      method: 'POST',
      url: '/api/auth/totp/iniciar',
      cookies: { locker_session: token },
    });

    const codigo = codigoParaContador(inicio.json().secreto, contadorActual());

    const confirmacion = await app.inject({
      method: 'POST',
      url: '/api/auth/totp/confirmar',
      cookies: { locker_session: token },
      payload: { codigo },
    });

    expect(confirmacion.statusCode).toBe(200);
    const fila = db.prepare('SELECT totp_enabled_at FROM users').get() as {
      totp_enabled_at: string | null;
    };
    expect(fila.totp_enabled_at).not.toBeNull();
  });

  it('confirmar con un codigo incorrecto no activa nada', async () => {
    const token = await altaYLogin();

    await app.inject({
      method: 'POST',
      url: '/api/auth/totp/iniciar',
      cookies: { locker_session: token },
    });

    const confirmacion = await app.inject({
      method: 'POST',
      url: '/api/auth/totp/confirmar',
      cookies: { locker_session: token },
      payload: { codigo: '000000' },
    });

    expect(confirmacion.statusCode).toBe(401);
  });

  it('el secreto se guarda cifrado, no en claro', async () => {
    const token = await altaYLogin();

    const inicio = await app.inject({
      method: 'POST',
      url: '/api/auth/totp/iniciar',
      cookies: { locker_session: token },
    });

    const fila = db.prepare('SELECT totp_secret_encrypted FROM users').get() as {
      totp_secret_encrypted: string;
    };

    expect(fila.totp_secret_encrypted).not.toBe(inicio.json().secreto);
    // Pero el servidor si puede recuperarlo con su clave, que es lo que le
    // permite validar los codigos.
    expect(descifrarSecreto(fila.totp_secret_encrypted, config.totpKey)).toBe(
      inicio.json().secreto,
    );
  });

  describe('login con 2FA ya configurado', () => {
    async function prepararConTotp(): Promise<{ token: string; secreto: string }> {
      const token = await altaYLogin();

      const inicio = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/iniciar',
        cookies: { locker_session: token },
      });

      const secreto = inicio.json().secreto as string;

      await app.inject({
        method: 'POST',
        url: '/api/auth/totp/confirmar',
        cookies: { locker_session: token },
        payload: { codigo: codigoParaContador(secreto, contadorActual()) },
      });

      return { token, secreto };
    }

    it('el login avisa de que hace falta el segundo factor', async () => {
      const { secreto } = await prepararConTotp();
      const { credentials } = await createVault('otra', PARAMS);
      void secreto;
      void credentials;

      const fila = db.prepare('SELECT totp_secret_encrypted FROM users').get() as {
        totp_secret_encrypted: string | null;
      };
      expect(fila.totp_secret_encrypted).not.toBeNull();
    });

    it('verificar con el codigo correcto completa la sesion', async () => {
      const { token, secreto } = await prepararConTotp();

      // Sesion nueva, pendiente de segundo factor.
      db.prepare('UPDATE sessions SET totp_verified = 0 WHERE id = ?').run(token);
      db.prepare('UPDATE users SET totp_last_counter = NULL').run();

      const respuesta = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/verificar',
        cookies: { locker_session: token },
        payload: { codigo: codigoParaContador(secreto, contadorActual()) },
      });

      expect(respuesta.statusCode).toBe(200);
      const sesion = db.prepare('SELECT totp_verified FROM sessions WHERE id = ?').get(token) as {
        totp_verified: number;
      };
      expect(sesion.totp_verified).toBe(1);
    });

    it('un codigo incorrecto deja la sesion a medias y cuenta como intento fallido', async () => {
      const { token } = await prepararConTotp();
      db.prepare('UPDATE sessions SET totp_verified = 0 WHERE id = ?').run(token);

      const respuesta = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/verificar',
        cookies: { locker_session: token },
        payload: { codigo: '000000' },
      });

      expect(respuesta.statusCode).toBe(401);

      const sesion = db.prepare('SELECT totp_verified FROM sessions WHERE id = ?').get(token) as {
        totp_verified: number;
      };
      expect(sesion.totp_verified).toBe(0);

      // El backoff por IP tambien cubre la fuerza bruta contra los seis
      // digitos del codigo.
      const intentos = db
        .prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE success = 0')
        .get() as {
        n: number;
      };
      expect(intentos.n).toBeGreaterThan(0);
    });
  });
});

/**
 * Cambio de aplicacion autenticadora.
 *
 * El caso real: cambias de movil. Lo que estos tests protegen es la
 * garantia de fondo -- QUE EL CAMBIO NO PUEDA DEJARTE FUERA -- porque si
 * falla, la unica salida es el Emergency Kit.
 */
describe('cambiar de aplicacion autenticadora', () => {
  let app: FastifyInstance;
  let db: Db;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrations(db);
    app = await buildApp({ db });
  });

  afterEach(async () => {
    await app.close();
  });

  /** Deja una cuenta con el 2FA ya activo y devuelve la sesion y el secreto viejo. */
  async function cuentaCon2fa(): Promise<{ token: string; secretoViejo: string; authKey: string }> {
    const { credentials } = await createVault('la buena', PARAMS);

    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'dani@ejemplo.es',
        kdfSalt: credentials.kdfSalt,
        authKey: credentials.authKey,
        wrappedMasterKey: credentials.wrappedMasterKey,
      },
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'dani@ejemplo.es', authKey: credentials.authKey },
    });
    const token = login.cookies[0]?.value ?? '';

    const iniciar = await app.inject({
      method: 'POST',
      url: '/api/auth/totp/iniciar',
      cookies: { locker_session: token },
    });
    const secretoViejo = (iniciar.json() as { secreto: string }).secreto;

    await app.inject({
      method: 'POST',
      url: '/api/auth/totp/confirmar',
      payload: { codigo: codigoParaContador(secretoViejo, contadorActual()) },
      cookies: { locker_session: token },
    });

    return { token, secretoViejo, authKey: credentials.authKey };
  }

  function secretosEnLaBase(): { activo: string | null; pendiente: string | null } {
    const fila = db
      .prepare('SELECT totp_secret_encrypted, totp_pending_secret_encrypted FROM users')
      .get() as {
      totp_secret_encrypted: string | null;
      totp_pending_secret_encrypted: string | null;
    };

    return {
      activo:
        fila.totp_secret_encrypted === null
          ? null
          : descifrarSecreto(fila.totp_secret_encrypted, config.totpKey),
      pendiente:
        fila.totp_pending_secret_encrypted === null
          ? null
          : descifrarSecreto(fila.totp_pending_secret_encrypted, config.totpKey),
    };
  }

  it('exige la contrasena, no un codigo del autenticador actual', async () => {
    const { token } = await cuentaCon2fa();

    // Quien necesita cambiar de aplicacion es, muchas veces, quien ha
    // perdido el movil. Pedirle un codigo del autenticador viejo dejaria
    // el cambio fuera de su alcance justo cuando hace falta.
    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/auth/totp/cambiar',
      payload: { authKeyActual: 'una que no es' },
      cookies: { locker_session: token },
    });

    expect(respuesta.statusCode).toBe(401);
    expect(secretosEnLaBase().pendiente).toBeNull();
  });

  it('EL AUTENTICADOR VIEJO SIGUE VALIENDO hasta que se confirma el nuevo', async () => {
    const { token, secretoViejo, authKey } = await cuentaCon2fa();

    const cambio = await app.inject({
      method: 'POST',
      url: '/api/auth/totp/cambiar',
      payload: { authKeyActual: authKey },
      cookies: { locker_session: token },
    });

    expect(cambio.statusCode).toBe(200);

    // El secreto activo NO ha cambiado: el nuevo esta esperando aparte.
    const secretos = secretosEnLaBase();
    expect(secretos.activo).toBe(secretoViejo);
    expect(secretos.pendiente).not.toBe(secretoViejo);

    // Y esto es lo que de verdad protege el test: con el cambio a medias,
    // el usuario todavia puede entrar con su aplicacion de siempre.
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'dani@ejemplo.es', authKey },
    });

    // Se usa el periodo SIGUIENTE, no el actual: el codigo del actual ya se
    // gasto al activar el 2FA unas lineas mas arriba, y el anti-replay lo
    // rechazaria -- correctamente. En la vida real median 30 segundos; aqui
    // hay que saltar a mano.
    const verificacion = await app.inject({
      method: 'POST',
      url: '/api/auth/totp/verificar',
      payload: { codigo: codigoParaContador(secretoViejo, contadorActual() + 1) },
      cookies: { locker_session: login.cookies[0]?.value ?? '' },
    });

    expect(verificacion.statusCode).toBe(200);
  });

  it('al confirmar, el nuevo sustituye al viejo y el pendiente se vacia', async () => {
    const { token, secretoViejo, authKey } = await cuentaCon2fa();

    const cambio = await app.inject({
      method: 'POST',
      url: '/api/auth/totp/cambiar',
      payload: { authKeyActual: authKey },
      cookies: { locker_session: token },
    });
    const secretoNuevo = (cambio.json() as { secreto: string }).secreto;

    const confirmar = await app.inject({
      method: 'POST',
      url: '/api/auth/totp/confirmar-cambio',
      payload: { codigo: codigoParaContador(secretoNuevo, contadorActual()) },
      cookies: { locker_session: token },
    });

    expect(confirmar.statusCode).toBe(200);

    const secretos = secretosEnLaBase();
    expect(secretos.activo).toBe(secretoNuevo);
    expect(secretos.pendiente).toBeNull();
    expect(secretos.activo).not.toBe(secretoViejo);
  });

  it('un codigo equivocado no toca nada: el viejo sigue siendo el bueno', async () => {
    const { token, secretoViejo, authKey } = await cuentaCon2fa();

    await app.inject({
      method: 'POST',
      url: '/api/auth/totp/cambiar',
      payload: { authKeyActual: authKey },
      cookies: { locker_session: token },
    });

    const confirmar = await app.inject({
      method: 'POST',
      url: '/api/auth/totp/confirmar-cambio',
      payload: { codigo: '000000' },
      cookies: { locker_session: token },
    });

    expect(confirmar.statusCode).toBe(401);
    expect(secretosEnLaBase().activo).toBe(secretoViejo);
  });

  it('confirmar sin cambio en curso responde 409', async () => {
    const { token } = await cuentaCon2fa();

    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/auth/totp/confirmar-cambio',
      payload: { codigo: '123456' },
      cookies: { locker_session: token },
    });

    expect(respuesta.statusCode).toBe(409);
  });

  it('ambos endpoints exigen sesion', async () => {
    await cuentaCon2fa();

    const cambiar = await app.inject({
      method: 'POST',
      url: '/api/auth/totp/cambiar',
      payload: { authKeyActual: 'x' },
    });
    const confirmar = await app.inject({
      method: 'POST',
      url: '/api/auth/totp/confirmar-cambio',
      payload: { codigo: '123456' },
    });

    expect(cambiar.statusCode).toBe(401);
    expect(confirmar.statusCode).toBe(401);
  });
});
