import type { AuthChallengeResponse, NodeDto } from '@locker/shared';

/**
 * Cliente de la API.
 *
 * Todo lo que sale de aqui va ya cifrado y todo lo que entra viene cifrado:
 * este modulo no descifra nada, solo habla HTTP. El cifrado vive en
 * `@locker/crypto` y se aplica una capa mas arriba.
 */

export class ApiError extends Error {
  constructor(
    readonly estado: number,
    readonly codigo: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * La petición no llegó a tener respuesta: red caída, servidor inalcanzable.
 *
 * Se distingue de `ApiError` porque un fallo de red merece reintento y una
 * respuesta del servidor no: si contestó 413, reintentar solo repite el
 * mismo rechazo.
 */
export class ErrorDeRed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErrorDeRed';
  }
}

/** La canceló el usuario. No es un fallo y no se reintenta. */
export class SubidaCancelada extends Error {
  constructor() {
    super('Subida cancelada.');
    this.name = 'SubidaCancelada';
  }
}

async function pedir<T>(url: string, opciones: RequestInit = {}): Promise<T> {
  const respuesta = await fetch(url, {
    ...opciones,
    // La cookie de sesion es httpOnly, asi que el navegador la adjunta sola;
    // esto solo le dice que lo haga tambien en peticiones de la misma app.
    credentials: 'same-origin',
    headers: {
      ...(opciones.body !== undefined && !(opciones.body instanceof Uint8Array)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...opciones.headers,
    },
  });

  if (!respuesta.ok) {
    const cuerpo = (await respuesta.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    throw new ApiError(
      respuesta.status,
      cuerpo.error ?? 'error_desconocido',
      cuerpo.message ?? 'Algo ha ido mal.',
    );
  }

  if (respuesta.status === 204) {
    return undefined as T;
  }

  return (await respuesta.json()) as T;
}

// ----------------------------------------------------------------------------
// Autenticacion
// ----------------------------------------------------------------------------

export const auth = {
  estado: () => pedir<{ tieneCuenta: boolean }>('/api/auth/estado'),

  /** Devuelve el salt con el que derivar las claves. */
  challenge: (email: string) =>
    pedir<AuthChallengeResponse>('/api/auth/challenge', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  registrar: (datos: {
    email: string;
    kdfSalt: string;
    kdfParamsVersion: number;
    authKey: string;
    wrappedMasterKey: string;
  }) => pedir<{ ok: true }>('/api/auth/register', { method: 'POST', body: JSON.stringify(datos) }),

  /**
   * Entrega la clave maestra ENVUELTA. Solo el navegador puede abrirla, con
   * la otra mitad de lo que derivo de la contrasena.
   */
  login: (email: string, authKey: string) =>
    pedir<{
      wrappedMasterKey: string;
      totpSecretEncrypted: string | null;
      requiereTotp: boolean;
    }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, authKey }) }),

  logout: () => pedir<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  yo: () => pedir<{ email: string | null; totpVerified: boolean }>('/api/auth/me'),
};

// ----------------------------------------------------------------------------
// Cuenta y ajustes
// ----------------------------------------------------------------------------

export const cuenta = {
  /** Fechas y banderas de configuracion. Nada que sirva para atacar la boveda. */
  ver: () =>
    pedir<{
      email: string;
      creadaEl: string;
      totpActivoDesde: string | null;
      tieneRecuperacion: boolean;
    }>('/api/auth/cuenta'),

  /**
   * Cambia la contrasena.
   *
   * Todo lo criptografico ya viene resuelto del navegador: aqui solo viaja
   * la clave maestra REENVUELTA, que el servidor sigue sin poder abrir.
   */
  cambiarPassword: (datos: {
    authKeyActual: string;
    kdfSalt: string;
    kdfParamsVersion: number;
    authKey: string;
    wrappedMasterKey: string;
  }) => pedir<{ ok: true }>('/api/auth/password', { method: 'POST', body: JSON.stringify(datos) }),

  auditoria: (limite = 40) =>
    pedir<{
      entradas: {
        accion: string;
        nodeId: string | null;
        ip: string | null;
        detalle: string | null;
        fecha: string;
      }[];
    }>(`/api/auditoria?limite=${String(limite)}`),
};

// ----------------------------------------------------------------------------
// Segundo factor
// ----------------------------------------------------------------------------

export const totp = {
  iniciar: () =>
    pedir<{ secreto: string; uri: string }>('/api/auth/totp/iniciar', { method: 'POST' }),

  confirmar: (codigo: string) =>
    pedir<{ ok: true }>('/api/auth/totp/confirmar', {
      method: 'POST',
      body: JSON.stringify({ codigo }),
    }),

  verificar: (codigo: string) =>
    pedir<{ ok: true }>('/api/auth/totp/verificar', {
      method: 'POST',
      body: JSON.stringify({ codigo }),
    }),

  /**
   * Empieza un cambio de aplicacion autenticadora.
   *
   * Pide la contrasena y NO un codigo del autenticador actual: quien
   * necesita esto suele ser justo quien ha perdido el movil.
   *
   * El secreto viejo sigue siendo el valido hasta confirmar.
   */
  cambiar: (authKeyActual: string) =>
    pedir<{ secreto: string; uri: string }>('/api/auth/totp/cambiar', {
      method: 'POST',
      body: JSON.stringify({ authKeyActual }),
    }),

  /** Confirma el cambio con un codigo de la aplicacion NUEVA. */
  confirmarCambio: (codigo: string) =>
    pedir<{ ok: true }>('/api/auth/totp/confirmar-cambio', {
      method: 'POST',
      body: JSON.stringify({ codigo }),
    }),
};

// ----------------------------------------------------------------------------
// Fichero de recuperacion
// ----------------------------------------------------------------------------

export const recuperacion = {
  guardar: (recoveryWrappedKey: string, recoverySalt: string) =>
    pedir<{ ok: true }>('/api/auth/recuperacion', {
      method: 'POST',
      body: JSON.stringify({ recoveryWrappedKey, recoverySalt }),
    }),

  estado: () => pedir<{ tieneRecuperacion: boolean }>('/api/auth/recuperacion/estado'),

  challenge: (email: string) =>
    pedir<{ recoveryWrappedKey: string; recoverySalt: string }>(
      '/api/auth/recuperacion/challenge',
      { method: 'POST', body: JSON.stringify({ email }) },
    ),

  completar: (datos: {
    email: string;
    pruebaDeRecuperacion: string;
    kdfSalt: string;
    authKey: string;
    wrappedMasterKey: string;
  }) =>
    pedir<{ ok: true }>('/api/auth/recuperacion/completar', {
      method: 'POST',
      body: JSON.stringify(datos),
    }),
};

// ----------------------------------------------------------------------------
// Arbol de ficheros
// ----------------------------------------------------------------------------

export const nodos = {
  /** Los nombres llegan CIFRADOS: hay que descifrarlos antes de pintarlos. */
  listar: (parentId: string | null) =>
    pedir<{ nodes: NodeDto[] }>(`/api/nodes${parentId === null ? '' : `?parent=${parentId}`}`),

  ver: (id: string) => pedir<NodeDto>(`/api/nodes/${id}`),

  /** Subarbol completo. Lo necesita el ZIP, que se arma en el navegador. */
  subarbol: (id: string) => pedir<{ nodes: NodeDto[] }>(`/api/nodes/${id}/tree`),

  crearCarpeta: (parentId: string | null, nameEncrypted: string) =>
    pedir<NodeDto>('/api/nodes/folder', {
      method: 'POST',
      body: JSON.stringify({ parentId, nameEncrypted }),
    }),

  renombrar: (id: string, nameEncrypted: string) =>
    pedir<NodeDto>(`/api/nodes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ nameEncrypted }),
    }),

  mover: (id: string, parentId: string | null) =>
    pedir<NodeDto>(`/api/nodes/${id}`, { method: 'PATCH', body: JSON.stringify({ parentId }) }),

  /** Manda a la papelera; no borra. El borrado definitivo esta en `papelera`. */
  aPapelera: (id: string) => pedir<{ aPapelera: number }>(`/api/nodes/${id}`, { method: 'DELETE' }),

  almacenamiento: () => pedir<{ usadoBytes: number; cuotaBytes: number }>('/api/almacenamiento'),
};

// ----------------------------------------------------------------------------
// Ficheros
// ----------------------------------------------------------------------------

export const ficheros = {
  /**
   * Sube un fichero YA CIFRADO.
   *
   * Los metadatos van en cabeceras para que el cuerpo sea el stream cifrado
   * puro, sin multipart que parsear.
   *
   * VA POR XMLHttpRequest Y NO POR `fetch` a propósito: `fetch` no informa
   * del progreso de SUBIDA (solo de la descarga de la respuesta), y sin ese
   * dato la segunda barra saltaría de 0 a 100 sin pasar por el medio. Es la
   * única razón; en todo lo demás `fetch` sería preferible.
   */
  subir: (datos: {
    contenidoCifrado: Uint8Array;
    nameEncrypted: string;
    wrappedDek: string;
    parentId: string | null;
    senal?: AbortSignal | undefined;
    alProgresar?: ((fraccion: number) => void) | undefined;
  }): Promise<NodeDto> =>
    new Promise<NodeDto>((resolver, rechazar) => {
      if (datos.senal?.aborted === true) {
        rechazar(new SubidaCancelada());
        return;
      }

      const peticion = new XMLHttpRequest();
      peticion.open('POST', '/api/files');
      peticion.withCredentials = true;
      peticion.setRequestHeader('Content-Type', 'application/octet-stream');
      peticion.setRequestHeader('X-Locker-Name', datos.nameEncrypted);
      peticion.setRequestHeader('X-Locker-Dek', datos.wrappedDek);
      if (datos.parentId !== null) {
        peticion.setRequestHeader('X-Locker-Parent', datos.parentId);
      }

      peticion.upload.onprogress = (evento) => {
        if (evento.lengthComputable && evento.total > 0) {
          datos.alProgresar?.(evento.loaded / evento.total);
        }
      };

      peticion.onload = () => {
        if (peticion.status >= 200 && peticion.status < 300) {
          try {
            resolver(JSON.parse(peticion.responseText) as NodeDto);
          } catch {
            rechazar(new ApiError(peticion.status, 'respuesta_ilegible', 'Respuesta inesperada.'));
          }
          return;
        }

        let cuerpo: { error?: string; message?: string } = {};
        try {
          cuerpo = JSON.parse(peticion.responseText) as typeof cuerpo;
        } catch {
          // Un error sin JSON (un 502 de nginx, por ejemplo) no es motivo
          // para perder el código de estado, que es lo que decide si esto
          // se reintenta o no.
        }

        rechazar(
          new ApiError(
            peticion.status,
            cuerpo.error ?? 'error_desconocido',
            cuerpo.message ?? 'No se pudo subir el fichero.',
          ),
        );
      };

      // Estado 0 sin `onerror` previo: la red se cayó o el servidor cortó.
      // Se distingue de un 4xx porque uno merece reintento y el otro no.
      peticion.onerror = () => {
        rechazar(new ErrorDeRed('No se pudo contactar con el servidor.'));
      };
      peticion.ontimeout = () => {
        rechazar(new ErrorDeRed('La subida tardó demasiado.'));
      };

      // Al abortar, el servidor ve la petición cortada y borra el temporal:
      // los blobs se escriben a `.parcial` y solo se renombran al final, así
      // que una subida cancelada no deja nada que recoger.
      peticion.onabort = () => {
        rechazar(new SubidaCancelada());
      };
      datos.senal?.addEventListener('abort', () => {
        peticion.abort();
      });

      peticion.send(datos.contenidoCifrado as XMLHttpRequestBodyInit);
    }),

  /** Descarga el contenido CIFRADO. Descifrarlo es cosa de quien llama. */
  descargar: async (id: string): Promise<Uint8Array> => {
    const respuesta = await fetch(`/api/files/${id}/contenido`, { credentials: 'same-origin' });

    if (!respuesta.ok) {
      throw new ApiError(respuesta.status, 'descarga_fallida', 'No se pudo descargar el fichero.');
    }

    return new Uint8Array(await respuesta.arrayBuffer());
  },
};

// ----------------------------------------------------------------------------
// Papelera
// ----------------------------------------------------------------------------

export const papelera = {
  listar: () => pedir<{ nodes: NodeDto[] }>('/api/papelera'),

  restaurar: (id: string) => pedir<NodeDto>(`/api/papelera/${id}/restaurar`, { method: 'POST' }),

  borrarDefinitivamente: (id: string) =>
    pedir<{ nodos: number; blobs: number }>(`/api/papelera/${id}`, { method: 'DELETE' }),

  vaciar: () => pedir<{ nodos: number; blobs: number }>('/api/papelera', { method: 'DELETE' }),
};
