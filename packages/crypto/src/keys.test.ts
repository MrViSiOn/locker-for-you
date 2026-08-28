import { KDF_PARAMS_V1 } from '@locker/shared';
import { describe, expect, it } from 'vitest';

import { randomBytes, utf8Encode } from './encoding.js';
import { changePassword, createDek, createVault, unlockVault, unwrapDek } from './keys.js';
import { toBuffer } from './kdf.js';

const PARAMS = { ...KDF_PARAMS_V1, memoryKib: 1024, iterations: 1 };

/** Cifra con una DEK, para comprobar que sigue sirviendo tras rotar. */
async function cifrar(dek: CryptoKey, texto: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  const out = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toBuffer(iv) },
    dek,
    toBuffer(texto),
  );
  return new Uint8Array(out);
}

async function descifrar(dek: CryptoKey, cifrado: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  const out = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBuffer(iv) },
    dek,
    toBuffer(cifrado),
  );
  return new Uint8Array(out);
}

describe('createVault', () => {
  it('produce credenciales completas y opacas', async () => {
    const { credentials } = await createVault('mi contrasena', PARAMS);

    expect(credentials.kdfSalt).toBeTruthy();
    expect(credentials.authKey).toBeTruthy();
    expect(credentials.wrappedMasterKey).toBeTruthy();
    expect(credentials.kdfParams.version).toBe(PARAMS.version);
  });

  it('dos bovedas con la MISMA contrasena tienen claves maestras distintas', async () => {
    const a = await createVault('identica', PARAMS);
    const b = await createVault('identica', PARAMS);

    // La MK es aleatoria, no derivada: dos cuentas con la misma contrasena
    // no comparten nada.
    expect(a.credentials.wrappedMasterKey).not.toBe(b.credentials.wrappedMasterKey);
    expect(a.credentials.kdfSalt).not.toBe(b.credentials.kdfSalt);
  });

  it('la clave maestra y la de nombres no son extraibles', async () => {
    const { vault } = await createVault('secreta', PARAMS);

    expect(vault.masterKey.extractable).toBe(false);
    expect(vault.nameKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', vault.masterKey)).rejects.toThrow();
  });
});

describe('unlockVault', () => {
  it('abre la boveda con la contrasena correcta', async () => {
    const { credentials } = await createVault('abre sesamo', PARAMS);
    const { authKey } = await unlockVault('abre sesamo', credentials);

    expect(authKey).toBe(credentials.authKey);
  });

  // AES-KW comprueba integridad: una clave equivocada FALLA en vez de
  // devolver basura. Si devolviera basura, los descifrados posteriores
  // pareceria que son ficheros danados.
  it('falla con la contrasena incorrecta en vez de devolver una clave inutil', async () => {
    const { credentials } = await createVault('la buena', PARAMS);

    await expect(unlockVault('la mala', credentials)).rejects.toThrow();
  });

  it('la clave maestra recuperada es la misma que la original', async () => {
    const { credentials, vault: original } = await createVault('constante', PARAMS);

    const { dek, wrappedDek } = await createDek(original);
    const iv = randomBytes(12);
    const cifrado = await cifrar(dek, utf8Encode('clave privada de prueba'), iv);

    const { vault: reabierta } = await unlockVault('constante', credentials);
    const dekRecuperada = await unwrapDek(reabierta, wrappedDek);

    expect(new TextDecoder().decode(await descifrar(dekRecuperada, cifrado, iv))).toBe(
      'clave privada de prueba',
    );
  });
});

describe('DEK por fichero', () => {
  it('cada fichero recibe una DEK distinta', async () => {
    const { vault } = await createVault('x', PARAMS);

    const envueltas = new Set<string>();
    for (let i = 0; i < 20; i++) {
      envueltas.add((await createDek(vault)).wrappedDek);
    }

    expect(envueltas.size).toBe(20);
  });

  it('una DEK de otra boveda no se puede desenvolver', async () => {
    const mia = await createVault('mia', PARAMS);
    const ajena = await createVault('ajena', PARAMS);

    const { wrappedDek } = await createDek(ajena.vault);

    await expect(unwrapDek(mia.vault, wrappedDek)).rejects.toThrow();
  });
});

describe('changePassword', () => {
  it('los ficheros siguen descifrandose tras cambiar la contrasena', async () => {
    const { credentials, vault } = await createVault('la vieja', PARAMS);

    // 50 ficheros, cada uno con su DEK y su contenido.
    const ficheros = await Promise.all(
      Array.from({ length: 50 }, async (_, i) => {
        const { dek, wrappedDek } = await createDek(vault);
        const iv = randomBytes(12);
        const contenido = utf8Encode(`contenido del fichero ${i}`);
        return { wrappedDek, iv, cifrado: await cifrar(dek, contenido, iv), esperado: contenido };
      }),
    );

    const nuevas = await changePassword('la vieja', 'la nueva', credentials, PARAMS);
    const { vault: reabierta } = await unlockVault('la nueva', nuevas);

    for (const fichero of ficheros) {
      const dek = await unwrapDek(reabierta, fichero.wrappedDek);
      const claro = await descifrar(dek, fichero.cifrado, fichero.iv);
      expect(claro).toEqual(fichero.esperado);
    }
  }, 60_000);

  it('las wrappedDek NO cambian: solo se reenvuelve la clave maestra', async () => {
    const { credentials, vault } = await createVault('antes', PARAMS);
    const { wrappedDek } = await createDek(vault);

    const nuevas = await changePassword('antes', 'despues', credentials, PARAMS);
    const { vault: reabierta } = await unlockVault('despues', nuevas);

    // La misma wrappedDek de siempre sigue funcionando.
    await expect(unwrapDek(reabierta, wrappedDek)).resolves.toBeDefined();
    expect(nuevas.wrappedMasterKey).not.toBe(credentials.wrappedMasterKey);
  });

  it('la contrasena vieja deja de abrir la boveda', async () => {
    const { credentials } = await createVault('caduca', PARAMS);
    const nuevas = await changePassword('caduca', 'vigente', credentials, PARAMS);

    await expect(unlockVault('caduca', nuevas)).rejects.toThrow();
    await expect(unlockVault('vigente', nuevas)).resolves.toBeDefined();
  });

  it('exige la contrasena actual: no se puede cambiar sin conocerla', async () => {
    const { credentials } = await createVault('real', PARAMS);

    await expect(changePassword('inventada', 'nueva', credentials, PARAMS)).rejects.toThrow();
  });

  it('usa un salt nuevo, para que no se pueda comparar con el anterior', async () => {
    const { credentials } = await createVault('uno', PARAMS);
    const nuevas = await changePassword('uno', 'dos', credentials, PARAMS);

    expect(nuevas.kdfSalt).not.toBe(credentials.kdfSalt);
  });
});
