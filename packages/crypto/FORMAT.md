# Formato del blob cifrado

**Esto es un contrato de por vida.** Define cómo se leerán ficheros guardados
hace años. Cualquier cambio incompatible obliga a subir `FORMAT_VERSION` y a
mantener el lector de la versión anterior — nunca a romperlo.

## Estructura

```
┌─────────────────────── cabecera (17 bytes, en claro) ───────────────────────┐
│ "LCKR"  │ versión │ chunkSize │        nonceBase                            │
│  4 B    │   1 B   │  4 B (BE) │          8 B                                │
└─────────────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────── cuerpo ──────────────────────────────────────┐
│ chunk 0: ciphertext (≤ chunkSize) + tag GCM 16 B                            │
│ chunk 1: ciphertext (≤ chunkSize) + tag GCM 16 B                            │
│ ...                                                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

La cabecera va en claro, pero **autenticada**: forma parte de los AAD de cada
chunk, así que modificar un solo bit hace que el descifrado falle.

## El texto plano antes de cifrar

```
[longitud real u32 BE][contenido][relleno aleatorio hasta múltiplo de 4096]
```

El relleno se aplica **al texto plano, antes de cifrar**. Al revés no serviría
de nada: el tamaño del ciphertext seguiría delatando el del original.

La longitud real va **dentro** del plano y nunca en un metadato del servidor.
Ponerla fuera reintroduciría exactamente la fuga que el relleno tapa.

## Por qué cada decisión

### Nonce = `nonceBase (8 B) ‖ contador de chunk (4 B BE)`

El contador no es opcional ni puede ser aleatorio. **Repetir un nonce con la
misma clave en AES-GCM revela el XOR de los dos textos planos y permite forjar
mensajes**: es el fallo que hundió al WEP y a varias implementaciones desde
entonces. Derivarlo del índice garantiza que no se repite dentro de un fichero,
y el `nonceBase` aleatorio que no se repita entre ficheros.

Con un contador de 32 bits y chunks de 1 MiB, el techo son 4 PB por fichero.

### AAD = `cabecera ‖ índice ‖ esÚltimo`

Tres protecciones en un solo campo:

| Se incluye   | Impide                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **índice**   | Reordenar chunks                                                                                                                          |
| **esÚltimo** | **Ataque de truncado**: cortar el final del fichero. El último chunk que quedase se autenticaría como "no último" y la verificación falla |
| **cabecera** | Mezclar chunks de dos blobs cifrados con la misma clave                                                                                   |

Los tres casos tienen su test en `blob.test.ts`.

### El byte de versión

Existe desde el primer fichero guardado. Es lo que permitirá cambiar de
algoritmo dentro de cinco años sin dejar la bóveda vieja ilegible. **Sin él, no
hay migración posible** — solo pérdida de datos o quedarse congelado en AES-GCM
para siempre.

Un lector que encuentre una versión que no conoce **falla con un mensaje
explícito**, nunca intenta interpretar los bytes a su manera.

### Relleno a 4 KiB

En claves privadas el tamaño exacto es casi una huella dactilar:

| Tipo de clave | Tamaño aproximado |
| ------------- | ----------------- |
| Ed25519       | ~400 B            |
| RSA-2048      | ~1,7 KB           |
| RSA-4096      | ~3,2 KB           |

Sin relleno, quien tuviera acceso al disco sabría qué tipo de claves guardas y
cuántas de cada, **sin descifrar nada**. Con el redondeo a 4 KiB las tres
ocupan lo mismo. Coste máximo: 4 KB por fichero.

**Limitación asumida:** en ficheros grandes esto no oculta prácticamente nada
(50 MB siguen siendo 50 MB ± 4 KB). Es aceptable porque el caso de uso real son
ficheros pequeños.

### Un fichero vacío sigue teniendo un chunk

Su prefijo de longitud y su relleno. Sin él no habría nada que autenticar, y un
blob truncado a cero pasaría por un fichero vacío legítimo.

## Errores

Todos los fallos lanzan `BlobFormatError`. El mensaje **no distingue** entre
clave incorrecta, bit corrompido, chunk reordenado y fichero truncado: todos
significan "estos bytes no son de fiar", y detallarlo solo ayudaría a quien
está sondeando.

Nunca se devuelven bytes a medio verificar. Entregar un fichero parcialmente
descifrado como si fuera bueno es peor que no entregar nada: el usuario creería
que su clave privada está corrupta cuando en realidad está intacta.

## Parámetros

| Constante            | Valor  | Dónde           |
| -------------------- | ------ | --------------- |
| `FORMAT_VERSION`     | 1      | `blob.ts`       |
| `DEFAULT_CHUNK_SIZE` | 1 MiB  | `blob.ts`       |
| `PADDING_BLOCK`      | 4096 B | `blob.ts`       |
| Tag GCM              | 16 B   | fijo en AES-GCM |
| Nonce                | 12 B   | fijo en AES-GCM |
