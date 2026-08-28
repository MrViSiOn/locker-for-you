import type { Db } from '../db/index.js';

/**
 * Bloqueo temporal por IP tras varios intentos fallidos de login.
 *
 * La contrasena maestra es el unico secreto del sistema: si se adivina, cae
 * la boveda entera. Argon2id ya hace cada intento caro (unos 106 ms), pero
 * sin limite eso solo significa que un atacante tarda mas, no que se rinda.
 * El backoff convierte la fuerza bruta online en algo inviable.
 *
 * Se cuenta por IP y no por cuenta a proposito: bloquear por cuenta permitiria
 * a cualquiera dejar a Dani fuera de su propia boveda sin mas que fallar el
 * login unas cuantas veces.
 */

/** Escalones de bloqueo: a partir de N fallos seguidos, esperar M minutos. */
const ESCALONES: readonly { fallos: number; minutos: number }[] = [
  { fallos: 15, minutos: 60 },
  { fallos: 10, minutos: 5 },
  { fallos: 5, minutos: 1 },
];

/**
 * Ventana en la que se miran los fallos. Fuera de ella, la cuenta se
 * reinicia: un fallo de hace una semana no debe pesar hoy.
 */
const VENTANA_MINUTOS = 60;

export interface EstadoBloqueo {
  bloqueada: boolean;
  /** Segundos que faltan para poder reintentar. */
  segundosRestantes: number;
  fallosRecientes: number;
}

/**
 * Mira si una IP esta bloqueada ahora mismo.
 *
 * Solo cuentan los fallos POSTERIORES al ultimo acierto: si alguien acerto,
 * ya no tiene sentido seguir castigandolo por los intentos previos.
 */
export function estadoDeBloqueo(db: Db, ip: string, ahora = Date.now()): EstadoBloqueo {
  const desde = new Date(ahora - VENTANA_MINUTOS * 60_000).toISOString();

  const ultimoAcierto = db
    .prepare(
      `SELECT created_at FROM login_attempts
       WHERE ip = ? AND success = 1 AND created_at >= ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(ip, desde) as { created_at: string } | undefined;

  const corte = ultimoAcierto?.created_at ?? desde;

  const fallos = db
    .prepare(
      `SELECT created_at FROM login_attempts
       WHERE ip = ? AND success = 0 AND created_at > ?
       ORDER BY created_at DESC`,
    )
    .all(ip, corte) as { created_at: string }[];

  const total = fallos.length;

  for (const escalon of ESCALONES) {
    if (total < escalon.fallos) {
      continue;
    }

    const ultimoFallo = fallos[0];
    if (ultimoFallo === undefined) {
      break;
    }

    const finBloqueo = new Date(ultimoFallo.created_at).getTime() + escalon.minutos * 60_000;
    const restante = finBloqueo - ahora;

    if (restante > 0) {
      return {
        bloqueada: true,
        segundosRestantes: Math.ceil(restante / 1000),
        fallosRecientes: total,
      };
    }

    break;
  }

  return { bloqueada: false, segundosRestantes: 0, fallosRecientes: total };
}

/**
 * Borra intentos viejos.
 *
 * Sin esto la tabla crece sin freno: un bot machacando el login durante meses
 * acabaria llenando el disco del VPS, que es un problema mas grave que el
 * propio intento de entrar.
 */
export function purgarIntentosAntiguos(db: Db, diasARetener = 7): number {
  const corte = new Date(Date.now() - diasARetener * 24 * 60 * 60_000).toISOString();
  return db.prepare('DELETE FROM login_attempts WHERE created_at < ?').run(corte).changes;
}
