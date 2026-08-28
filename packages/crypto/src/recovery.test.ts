import { KDF_PARAMS_V1 } from '@locker/shared';
import { describe, expect, it } from 'vitest';

import { decryptBlob, encryptBlob } from './blob.js';
import { randomBytes, utf8Encode } from './encoding.js';
import {
  createDek,
  createVault,
  exportarMasterKeyParaRecuperacion,
  reenvolverConNuevaPassword,
  unlockVault,
  unwrapDek,
} from './keys.js';
import {
  crearRecuperacion,
  generarPassphraseDeRecuperacion,
  normalizarPassphrase,
  recuperarClaveMaestra,
  RecoveryError,
  textoDelFicheroDeRecuperacion,
} from './recovery.js';

const PARAMS = { ...KDF_PARAMS_V1, memoryKib: 1024, iterations: 1 };

describe('passphrase de recuperacion', () => {
  it('tiene el formato en grupos que se puede copiar a mano', () => {
    const passphrase = generarPassphraseDeRecuperacion();

    expect(passphrase).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{1,4})+$/);
  });

  // Quien transcriba esto de un papel con la boveda bloqueada agradecera no
  // tener que adivinar si ese simbolo es un uno o una ele.
  it('no usa caracteres que se confunden al leer', () => {
    const muestra = Array.from({ length: 50 }, () => generarPassphraseDeRecuperacion()).join('');

    for (const confuso of ['I', 'L', 'O', 'U', '0', '1']) {
      expect(muestra).not.toContain(confuso);
    }
  });

  it('nunca se repite', () => {
    const generadas = new Set(Array.from({ length: 100 }, () => generarPassphraseDeRecuperacion()));

    expect(generadas.size).toBe(100);
  });

  it('normaliza guiones, espacios y minusculas', () => {
    expect(normalizarPassphrase('abcd-efgh ijkl')).toBe('ABCDEFGHIJKL');
  });
});

describe('creacion del Emergency Kit', () => {
  it('produce passphrase, clave envuelta y salt', async () => {
    const mk = randomBytes(32);

    const datos = await crearRecuperacion(mk, PARAMS);

    expect(datos.passphrase).toBeTruthy();
    expect(datos.recoveryWrappedKey).toBeTruthy();
    expect(datos.recoverySalt).toBeTruthy();
  });

  it('dos kits de la misma clave maestra son distintos', async () => {
    const mk = randomBytes(32);

    const uno = await crearRecuperacion(mk, PARAMS);
    const otro = await crearRecuperacion(mk, PARAMS);

    expect(uno.passphrase).not.toBe(otro.passphrase);
    expect(uno.recoveryWrappedKey).not.toBe(otro.recoveryWrappedKey);
  });
});

describe('recuperacion de la clave maestra', () => {
  it('devuelve exactamente la misma clave maestra', async () => {
    const mk = randomBytes(32);
    const datos = await crearRecuperacion(mk, PARAMS);

    const recuperada = await recuperarClaveMaestra(
      datos.passphrase,
      datos.recoveryWrappedKey,
      datos.recoverySalt,
      PARAMS,
    );

    expect(recuperada).toEqual(mk);
  });

  it('acepta la passphrase tal y como la teclearia el usuario', async () => {
    const mk = randomBytes(32);
    const datos = await crearRecuperacion(mk, PARAMS);

    // Sin guiones, en minusculas y con espacios de mas.
    const tecleada = datos.passphrase.replace(/-/g, ' ').toLowerCase();

    const recuperada = await recuperarClaveMaestra(
      tecleada,
      datos.recoveryWrappedKey,
      datos.recoverySalt,
      PARAMS,
    );

    expect(recuperada).toEqual(mk);
  });

  // AES-KW comprueba integridad: una passphrase equivocada FALLA en vez de
  // devolver 32 bytes de basura que luego producirian descifrados corruptos.
  it('falla con una passphrase incorrecta', async () => {
    const datos = await crearRecuperacion(randomBytes(32), PARAMS);
    const otra = generarPassphraseDeRecuperacion();

    await expect(
      recuperarClaveMaestra(otra, datos.recoveryWrappedKey, datos.recoverySalt, PARAMS),
    ).rejects.toThrow(RecoveryError);
  });

  it('falla si el salt no es el suyo', async () => {
    const datos = await crearRecuperacion(randomBytes(32), PARAMS);
    const otros = await crearRecuperacion(randomBytes(32), PARAMS);

    await expect(
      recuperarClaveMaestra(datos.passphrase, datos.recoveryWrappedKey, otros.recoverySalt, PARAMS),
    ).rejects.toThrow(RecoveryError);
  });
});

describe('el ciclo completo de recuperacion', () => {
  // La prueba que de verdad importa: olvidar la contrasena, entrar con el
  // Emergency Kit, poner una contrasena nueva y comprobar que los ficheros
  // de antes siguen siendo legibles byte a byte.
  it('recupera ficheros tras olvidar la contrasena', async () => {
    // 1. Cuenta nueva con un fichero dentro.
    const { credentials, vault } = await createVault('la contrasena que voy a olvidar', PARAMS);
    const { dek, wrappedDek } = await createDek(vault);
    const original = utf8Encode('-----BEGIN OPENSSH PRIVATE KEY-----\nclave importante\n');
    const blob = await encryptBlob(original, dek);

    // 2. Se genera el Emergency Kit (con la contrasena, que todavia se sabe).
    const mkBytes = await exportarMasterKeyParaRecuperacion(
      'la contrasena que voy a olvidar',
      credentials,
    );
    const kit = await crearRecuperacion(mkBytes, PARAMS);

    // 3. Pasa el tiempo y la contrasena se olvida.
    await expect(unlockVault('no me acuerdo', credentials)).rejects.toThrow();

    // 4. Se entra con la passphrase del papel.
    const mkRecuperada = await recuperarClaveMaestra(
      kit.passphrase,
      kit.recoveryWrappedKey,
      kit.recoverySalt,
      PARAMS,
    );

    // 5. Se fija una contrasena nueva.
    const nuevas = await reenvolverConNuevaPassword(mkRecuperada, 'la contrasena nueva', PARAMS);

    // 6. Y el fichero de antes sigue ahi, intacto.
    const { vault: recuperada } = await unlockVault('la contrasena nueva', nuevas);
    const dekRecuperada = await unwrapDek(recuperada, wrappedDek);

    expect(await decryptBlob(blob, dekRecuperada)).toEqual(original);
  }, 60_000);

  it('la contrasena vieja deja de funcionar tras recuperar', async () => {
    const { credentials } = await createVault('vieja', PARAMS);
    const mkBytes = await exportarMasterKeyParaRecuperacion('vieja', credentials);
    const kit = await crearRecuperacion(mkBytes, PARAMS);

    const mk = await recuperarClaveMaestra(
      kit.passphrase,
      kit.recoveryWrappedKey,
      kit.recoverySalt,
      PARAMS,
    );
    const nuevas = await reenvolverConNuevaPassword(mk, 'nueva', PARAMS);

    await expect(unlockVault('vieja', nuevas)).rejects.toThrow();
    await expect(unlockVault('nueva', nuevas)).resolves.toBeDefined();
  }, 30_000);

  // Regenerar el kit debe invalidar el anterior: si no, un papel viejo tirado
  // en un cajon seguiria abriendo la boveda para siempre.
  it('regenerar el kit invalida la passphrase anterior', async () => {
    const mk = randomBytes(32);
    const viejo = await crearRecuperacion(mk, PARAMS);
    const nuevo = await crearRecuperacion(mk, PARAMS);

    // Con los datos NUEVOS guardados en el servidor, la passphrase vieja ya
    // no desenvuelve nada.
    await expect(
      recuperarClaveMaestra(viejo.passphrase, nuevo.recoveryWrappedKey, nuevo.recoverySalt, PARAMS),
    ).rejects.toThrow(RecoveryError);

    await expect(
      recuperarClaveMaestra(nuevo.passphrase, nuevo.recoveryWrappedKey, nuevo.recoverySalt, PARAMS),
    ).resolves.toEqual(mk);
  }, 30_000);

  it('cambiar la contrasena no invalida el Emergency Kit', async () => {
    const { credentials } = await createVault('primera', PARAMS);
    const mkBytes = await exportarMasterKeyParaRecuperacion('primera', credentials);
    const kit = await crearRecuperacion(mkBytes, PARAMS);

    // La clave maestra no cambia al cambiar la contrasena, asi que el kit
    // sigue apuntando a la misma. Es correcto y es lo que se espera.
    const nuevas = await reenvolverConNuevaPassword(mkBytes, 'segunda', PARAMS);
    void nuevas;

    await expect(
      recuperarClaveMaestra(kit.passphrase, kit.recoveryWrappedKey, kit.recoverySalt, PARAMS),
    ).resolves.toEqual(mkBytes);
  }, 30_000);
});

describe('texto del fichero descargable', () => {
  it('avisa de lo que vale ese papel, sin rodeos', () => {
    const texto = textoDelFicheroDeRecuperacion('ABCD-EFGH', 'dani@ejemplo.es', '2026-08-27');

    expect(texto).toContain('ABCD-EFGH');
    expect(texto).toContain('dani@ejemplo.es');
    expect(texto).toContain('QUIEN TENGA ESTA CLAVE TIENE ACCESO A TODOS TUS FICHEROS');
    expect(texto).toContain('se pierden para siempre');
    expect(texto).toContain('solo se muestra una vez');
  });
});
