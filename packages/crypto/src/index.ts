export {
  utf8Encode,
  utf8Decode,
  bytesToBase64,
  base64ToBytes,
  concatBytes,
  constantTimeEqual,
  randomBytes,
} from './encoding.js';

export {
  deriveSecrets,
  generateSalt,
  toBuffer,
  KEY_BYTES,
  SALT_BYTES,
  type DerivedSecrets,
} from './kdf.js';

export {
  createVault,
  unlockVault,
  changePassword,
  createDek,
  unwrapDek,
  exportarMasterKeyParaRecuperacion,
  reenvolverConNuevaPassword,
  type VaultCredentials,
  type UnlockedVault,
} from './keys.js';

export { KDF_PARAMS_V1, type KdfParams } from '@locker/shared';

export {
  encryptBlob,
  decryptBlob,
  BlobFormatError,
  FORMAT_VERSION,
  DEFAULT_CHUNK_SIZE,
  PADDING_BLOCK,
} from './blob.js';

export {
  encryptName,
  decryptName,
  validateName,
  sortByName,
  isDuplicateName,
  InvalidNameError,
  MAX_NAME_LENGTH,
} from './names.js';

export {
  generarPassphraseDeRecuperacion,
  normalizarPassphrase,
  crearRecuperacion,
  recuperarClaveMaestra,
  textoDelFicheroDeRecuperacion,
  RecoveryError,
  type DatosDeRecuperacion,
} from './recovery.js';
