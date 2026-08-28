# Locker Secure

Bóveda personal de ficheros con **cifrado extremo a extremo real** (zero-knowledge).
Pensada para custodiar claves privadas y secretos propios.

_This README is also available [in English](README.md), where it is a bit more
detailed — that is the version shown on GitHub._

## La premisa

> Aunque alguien entre al servidor con root, no ve nada ni sabe cómo descifrarlo.

Esto no es una app "con cifrado": es una app en la que **el servidor no tiene la
llave, por diseño**. El servidor almacena bytes opacos que no puede interpretar,
ni siquiera los nombres de los ficheros.

```
Navegador                                  Servidor
---------                                  --------
password ──Argon2id(salt, m=64MB)──> MK    (nunca la ve)
MK ──AES-KW──unwrap──> DEK por fichero     (nunca la ve)
fichero ──AES-256-GCM(DEK)──> blob    ──>  guarda blob opaco
nombre  ──AES-256-GCM(MK)───> blob    ──>  guarda blob opaco
```

- **MK** (Master Key): se deriva en el cliente con Argon2id. Nunca viaja.
- Cada fichero tiene su propia **DEK** aleatoria, envuelta con la MK. Permite
  cambiar la contraseña sin recifrar los ficheros: solo se reenvuelven las DEK.
- La clave de autenticación que sí se envía al servidor se deriva por una rama
  distinta de HKDF, para que conocerla no diga nada sobre la MK.

## ⚠️ Antes de usarlo

**No hay recuperación de contraseña.** Si se pierde la contraseña maestra, los
ficheros son irrecuperables — y los backups tampoco sirven, porque contienen los
mismos bytes cifrados. Por eso existe el **fichero de recuperación offline**
(Emergency Kit) que se genera al crear la cuenta: guárdalo.

## Estructura

```
locker-for-you/
├── packages/
│   ├── crypto/        # @locker/crypto — lógica criptográfica, sin I/O
│   └── shared/        # tipos y contratos de la API
├── apps/
│   ├── api/           # Fastify + SQLite
│   └── web/           # React + Vite
└── docker/
```

`packages/crypto` es **compartido entre cliente y servidor** a propósito: la
lógica criptográfica se escribe y se testea una sola vez, y así ambos lados no
pueden divergir en el formato.

## Desarrollo

```bash
npm install
npm run dev        # API en :3000, web en :5173 (proxy /api → :3000)
npm test           # tests
npm run build      # compila todo
npm run lint
```

Requiere **Node 22 o superior**.

## Despliegue

Docker Compose detrás de un reverse proxy que termine el TLS. El
`docker-compose.yml` publica el puerto solo en loopback a propósito: exponerlo
crudo dejaría la aplicación accesible por HTTP plano, y en una bóveda cifrada
eso significa mandar la clave de autenticación en claro.

**Los tests del paquete de cripto bloquean el despliegue**: un bug ahí no es un
error visible, es pérdida de datos silenciosa e irreversible.
