# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# Se construye sobre Debian 12 (node:22-slim) y se ejecuta sobre distroless
# de la MISMA Debian 12.
#
# Por que no Alpine: better-sqlite3 es un modulo nativo (DRAPPS-1040).
# Compilado contra musl y ejecutado contra glibc -- o al reves -- revienta al
# arrancar con un error de simbolos que no dice nada util. Con la misma base
# glibc en build y runtime, el problema no llega a existir.
#
# Por que distroless en runtime: no trae shell, ni npm, ni apt, ni coreutils.
# En una boveda de claves privadas eso importa de verdad: si alguien llegara a
# ejecutar codigo en el contenedor, no tendria ni `sh` con el que moverse.
# Ademas corre como usuario `nonroot` (uid 65532) por defecto.
# ---------------------------------------------------------------------------
ARG BUILD_IMAGE=node:22-slim
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs22-debian12:nonroot

# --------------------------------- deps ------------------------------------
FROM ${BUILD_IMAGE} AS deps
WORKDIR /app

# better-sqlite3 es un modulo nativo y no siempre hay prebuild para la version
# exacta de Node de la imagen: cuando no lo hay, npm cae a compilarlo con
# node-gyp, que necesita Python, make y un compilador. Sin esto el build falla
# con "gyp ERR! find Python" -- y, si nadie mira la salida, `docker compose
# build` puede acabar dejando en pie la imagen ANTERIOR, con lo que el
# despliegue parece correcto y en realidad no ha cambiado nada.
#
# Todo esto se queda en el stage de build: al runtime solo viaja el
# node_modules ya compilado, asi que la imagen final no engorda.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Solo los manifiestos: mientras no cambien, esta capa se reutiliza y el
# npm ci no se repite en cada build.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/crypto/package.json ./packages/crypto/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

RUN --mount=type=cache,target=/root/.npm npm ci

# --------------------------------- build -----------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps

RUN npm run build

# Arbol de dependencias solo de produccion, para copiarlo al runtime sin
# arrastrar el tooling de desarrollo.
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# Los directorios de datos se crean aqui con el uid de distroless: distroless
# no tiene `mkdir` ni `chown` con los que crearlos en el runtime. Docker copia
# el propietario de estos directorios al volumen la primera vez que lo monta,
# que es lo que permite al proceso no-root escribir en ellos.
RUN mkdir -p /data/db /data/blobs && chown -R 65532:65532 /data

# -------------------------------- runtime ----------------------------------
FROM ${RUNTIME_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_DIR=/data/db \
    BLOBS_DIR=/data/blobs \
    WEB_DIST=/app/apps/web/dist

# --chown en cada COPY en vez de un `chown -R` posterior: el chown recursivo
# reescribe todos los ficheros y duplica la capa entera de node_modules
# (38 MB de mas en la primera version de este Dockerfile).
COPY --from=build --chown=65532:65532 /data /data

COPY --from=build --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /app/package.json ./package.json

COPY --from=build --chown=65532:65532 /app/packages/shared/package.json ./packages/shared/
COPY --from=build --chown=65532:65532 /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=65532:65532 /app/packages/crypto/package.json ./packages/crypto/
COPY --from=build --chown=65532:65532 /app/packages/crypto/dist ./packages/crypto/dist
COPY --from=build --chown=65532:65532 /app/apps/api/package.json ./apps/api/
COPY --from=build --chown=65532:65532 /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=65532:65532 /app/apps/web/dist ./apps/web/dist

EXPOSE 3000

# distroless no trae shell, asi que el healthcheck va en exec form. Node 22
# lleva fetch nativo: no hace falta curl ni wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# El ENTRYPOINT de distroless ya es node: aqui solo va el script.
CMD ["apps/api/dist/server.js"]
