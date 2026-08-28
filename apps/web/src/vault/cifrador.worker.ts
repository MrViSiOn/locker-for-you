import { encryptBlob } from '@locker/crypto';

/**
 * Worker de cifrado.
 *
 * OJO CON EL MOTIVO, PORQUE EL OBVIO ES FALSO: se suele dar por hecho que
 * cifrar en el hilo de la interfaz la congela. Con WebCrypto no: medido en
 * Chrome sobre 40 MB, `crypto.subtle.encrypt` tarda 48 ms y NO produce
 * ningún atasco perceptible (el trabajo criptográfico no ocurre en el hilo
 * de JavaScript). El worker cuesta 66 ms para lo mismo. Es decir: sale algo
 * más lento y no arregla un problema que, en esta máquina, no existe.
 *
 * Se mantiene por lo que sí es de JavaScript y sí corre en este hilo: el
 * relleno, el troceado y la concatenación de un fichero de hasta 50 MB, que
 * en un portátil viejo o un móvil pesan mucho más que aquí. Los 18 ms de
 * diferencia son un precio ridículo por quitarle ese trabajo a la interfaz
 * en las máquinas donde de verdad se nota.
 *
 * Si algún día estorba, quitarlo es seguro: `cifrador.ts` ya sabe cifrar en
 * este hilo y lo hace solo cuando el navegador no admite workers.
 *
 * LA CLAVE VIAJA, PERO NO SE ESCAPA: la DEK se manda como `CryptoKey`, que
 * el navegador clona sin exponer nunca su material (sigue siendo no
 * extraíble al otro lado). No se serializan bytes de clave en ningún
 * momento; si se hiciera, quedarían en un mensaje estructurado y en la
 * memoria de dos hilos a la vez.
 */

export interface PeticionDeCifrado {
  id: number;
  dek: CryptoKey;
  contenido: ArrayBuffer;
}

export type RespuestaDeCifrado =
  | { id: number; tipo: 'progreso'; hechos: number; total: number }
  | { id: number; tipo: 'hecho'; cifrado: ArrayBuffer }
  | { id: number; tipo: 'error'; mensaje: string };

/**
 * El `self` de un worker tipado a mano.
 *
 * El proyecto compila con la lib DOM, donde `self` es un `Window`. Declarar
 * aquí la lib `webworker` la mezclaría con la del resto de la app y provoca
 * conflictos de tipos globales; esta vista mínima es lo único que se usa.
 */
const hilo = self as unknown as {
  onmessage: ((evento: MessageEvent<PeticionDeCifrado>) => void) | null;
  postMessage: (mensaje: RespuestaDeCifrado, transferibles?: Transferable[]) => void;
};

hilo.onmessage = (evento) => {
  const { id, dek, contenido } = evento.data;

  void (async () => {
    try {
      const cifrado = await encryptBlob(
        new Uint8Array(contenido),
        dek,
        undefined,
        (hechos, total) => hilo.postMessage({ id, tipo: 'progreso', hechos, total }),
      );

      // El buffer se TRANSFIERE en vez de copiarse: con ficheros grandes,
      // clonarlo duplicaría la memoria y añadiría una pausa al hilo
      // principal, que es exactamente lo que este worker viene a evitar.
      const buffer = cifrado.buffer as ArrayBuffer;
      hilo.postMessage({ id, tipo: 'hecho', cifrado: buffer }, [buffer]);
    } catch (fallo) {
      hilo.postMessage({
        id,
        tipo: 'error',
        mensaje: fallo instanceof Error ? fallo.message : 'No se pudo cifrar el fichero.',
      });
    }
  })();
};
