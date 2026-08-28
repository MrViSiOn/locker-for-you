/**
 * Migraciones del esquema, en orden. Se aplican al arrancar dentro de una
 * transaccion y solo las que faltan.
 *
 * Van como cadenas en TypeScript y no como ficheros .sql sueltos a proposito:
 * asi viajan dentro del bundle compilado y no hay que acordarse de copiarlas
 * en el Dockerfile. Una migracion que no llega a la imagen es un arranque
 * roto en produccion y muy poca pista de por que.
 *
 * REGLA: una migracion publicada NO SE TOCA NUNCA. Si algo esta mal, se
 * corrige con una migracion nueva. Editar una ya aplicada deja bases de datos
 * distintas segun cuando se crearon.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'esquema inicial',
    sql: `
      -- ---------------------------------------------------------------------
      -- users
      --
      -- Todo lo que hay aqui es opaco para el servidor. Con esta tabla entera
      -- volcada, un atacante no puede descifrar ni un solo fichero: solo
      -- intentar adivinar la contrasena contra auth_key_hash, que es
      -- Argon2id y por tanto lentisimo de atacar.
      -- ---------------------------------------------------------------------
      CREATE TABLE users (
        id                   TEXT PRIMARY KEY,
        email                TEXT NOT NULL UNIQUE,

        -- Material de derivacion. El salt es publico por diseno: sin la
        -- contrasena no sirve de nada.
        kdf_salt             TEXT NOT NULL,
        kdf_params_version   INTEGER NOT NULL,

        -- Argon2id de la authKey que manda el cliente. Nunca la authKey en si:
        -- con ella se podria suplantar al usuario ante el servidor.
        auth_key_hash        TEXT NOT NULL,

        -- La clave maestra envuelta con la KEK derivada de la contrasena.
        -- Es lo unico que ata la boveda a la contrasena.
        wrapped_master_key   TEXT NOT NULL,

        -- Segunda copia de la MK, envuelta con la clave del fichero de
        -- recuperacion (DRAPPS-1044). NULL si el usuario no lo genero.
        recovery_wrapped_key TEXT,
        recovery_salt        TEXT,

        -- Secreto TOTP cifrado con la MK: si estuviera en claro, quien
        -- robara la base de datos podria generar los segundos factores.
        totp_secret_encrypted TEXT,
        totp_enabled_at      TEXT,

        storage_quota_bytes  INTEGER NOT NULL DEFAULT 1073741824,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      ) STRICT;

      -- ---------------------------------------------------------------------
      -- nodes: carpetas y ficheros en la misma tabla
      --
      -- Un arbol autorreferencial. parent_id NULL significa raiz. Se recorre
      -- con CTE recursivas, que SQLite soporta de sobra.
      -- ---------------------------------------------------------------------
      CREATE TABLE nodes (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        parent_id      TEXT REFERENCES nodes(id) ON DELETE CASCADE,

        kind           TEXT NOT NULL CHECK (kind IN ('folder', 'file')),

        -- Nombre cifrado con la nameKey. El servidor no sabe como se llama
        -- este nodo, asi que no puede ordenar ni buscar por el.
        name_encrypted TEXT NOT NULL,

        -- Solo en ficheros: el blob en disco y su DEK envuelta con la MK.
        blob_id        TEXT UNIQUE,
        wrapped_dek    TEXT,
        size_bytes     INTEGER,

        -- Papelera de 30 dias. NULL = visible.
        deleted_at     TEXT,

        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,

        -- Un nodo no puede ser su propio padre. Los ciclos mas largos no se
        -- pueden expresar aqui y se comprueban en la aplicacion antes de
        -- cada movimiento (DRAPPS-1045).
        CHECK (parent_id IS NULL OR parent_id <> id),

        -- Un fichero SIEMPRE tiene blob y DEK; una carpeta NUNCA. Sin esta
        -- comprobacion, un fichero sin wrapped_dek seria un fichero
        -- imposible de descifrar, y no habria forma de saber que paso.
        CHECK (
          (kind = 'file'   AND blob_id IS NOT NULL AND wrapped_dek IS NOT NULL AND size_bytes IS NOT NULL)
          OR
          (kind = 'folder' AND blob_id IS NULL     AND wrapped_dek IS NULL     AND size_bytes IS NULL)
        )
      ) STRICT;

      -- Listar una carpeta es la consulta mas frecuente de la app.
      CREATE INDEX idx_nodes_carpeta ON nodes(user_id, parent_id, deleted_at);
      -- La purga diaria de la papelera barre por esta.
      CREATE INDEX idx_nodes_papelera ON nodes(deleted_at) WHERE deleted_at IS NOT NULL;

      -- ---------------------------------------------------------------------
      -- sessions
      -- ---------------------------------------------------------------------
      CREATE TABLE sessions (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

        -- Una sesion recien creada esta pendiente del segundo factor y no
        -- vale para nada hasta que se completa (DRAPPS-1042).
        totp_verified INTEGER NOT NULL DEFAULT 0 CHECK (totp_verified IN (0, 1)),

        expires_at    TEXT NOT NULL,
        ip            TEXT,
        user_agent    TEXT,
        created_at    TEXT NOT NULL
      ) STRICT;

      CREATE INDEX idx_sessions_caducidad ON sessions(expires_at);

      -- ---------------------------------------------------------------------
      -- login_attempts: alimenta el backoff por IP (DRAPPS-1043)
      -- ---------------------------------------------------------------------
      CREATE TABLE login_attempts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ip         TEXT NOT NULL,
        email      TEXT,
        success    INTEGER NOT NULL CHECK (success IN (0, 1)),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX idx_intentos_ip ON login_attempts(ip, created_at);

      -- ---------------------------------------------------------------------
      -- audit_log
      --
      -- node_id sin clave foranea a proposito: el registro de un borrado debe
      -- sobrevivir al nodo borrado. Con ON DELETE CASCADE se perderia justo
      -- la entrada que interesa investigar.
      -- ---------------------------------------------------------------------
      CREATE TABLE audit_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    TEXT NOT NULL,
        action     TEXT NOT NULL,
        node_id    TEXT,
        ip         TEXT,
        detail     TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX idx_auditoria_usuario ON audit_log(user_id, created_at);
    `,
  },
  {
    version: 2,
    name: 'anti-replay de TOTP',
    // NOTA: el comentario de `totp_secret_encrypted` en la migracion 1 dice
    // que va cifrado con la clave maestra. Quedo obsoleto: se cifra con una
    // clave DEL SERVIDOR, y el porque esta explicado en auth/totp.ts. No se
    // corrige alli porque una migracion publicada no se toca; la aclaracion
    // vive aqui.
    sql: `
      -- Ultimo contador TOTP aceptado. Sin esto, un codigo interceptado
      -- seguiria valiendo durante sus 30 segundos, y quien lo hubiera visto
      -- (por encima del hombro, en un log, en un historial) podria usarlo
      -- antes que el usuario legitimo.
      ALTER TABLE users ADD COLUMN totp_last_counter INTEGER;
    `,
  },
  {
    version: 3,
    name: 'secreto TOTP pendiente, para cambiar de aplicacion sin quedarse fuera',
    sql: `
      -- Secreto de la aplicacion NUEVA mientras se cambia de autenticador.
      --
      -- Va en una columna aparte y no pisando totp_secret_encrypted por un
      -- motivo muy concreto: hasta que el usuario confirme un codigo de la
      -- aplicacion nueva, la VIEJA tiene que seguir funcionando. Si se
      -- sustituyera el secreto al generarlo, cualquier tropiezo a mitad
      -- --cerrar la pestana, escanear mal, un movil con la hora desajustada--
      -- lo dejaria fuera de su propia boveda, y la unica salida seria el
      -- Emergency Kit.
      --
      -- Al confirmar, el pendiente pasa a ser el bueno y esta columna se
      -- vacia. Un pendiente abandonado no da acceso a nada: sin confirmar,
      -- no se usa jamas para verificar.
      ALTER TABLE users ADD COLUMN totp_pending_secret_encrypted TEXT;
    `,
  },
];
