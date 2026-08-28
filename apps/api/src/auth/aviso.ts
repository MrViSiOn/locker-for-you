import { createTransport, type Transporter } from 'nodemailer';

import { config } from '../config.js';
import type { Db } from '../db/index.js';

/**
 * Aviso por correo cuando alguien intenta entrar en la boveda.
 *
 * Con una sola cuenta, este correo es la UNICA forma de enterarse de que
 * alguien lo esta intentando: no hay panel de administracion que nadie mire
 * ni equipo que revise logs.
 *
 * REGLA DE ORO DEL CONTENIDO: este correo sale del servidor y viaja por
 * internet en claro por varios saltos. No lleva NADA de la boveda -- ni
 * nombres de fichero, ni tamanos, ni estructura de carpetas, ni nada
 * relacionado con la contrasena. Solo IP, fecha y numero de intentos.
 */

/**
 * Un bot machacando el login no puede convertirse en cientos de correos: el
 * aviso pasaria de ser util a ser el problema, y acabaria en la papelera sin
 * leer justo el dia que importe.
 */
const HORAS_ENTRE_AVISOS = 6;

let transporte: Transporter | null = null;

function obtenerTransporte(): Transporter | null {
  if (config.smtp === null) {
    return null;
  }

  transporte ??= createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    // El 465 va con TLS desde el primer byte; el 587 empieza en claro y sube
    // con STARTTLS. Este servidor solo ofrece 25 y 465, asi que se usa el
    // 465: cifrado de entrada y sin ventana en claro.
    secure: config.smtp.port === 465,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
    // El servidor de correo es el de la propia maquina, con un certificado
    // que puede no coincidir con la IP del bridge Docker por la que se le
    // habla. La conexion no sale de la maquina, asi que verificar el nombre
    // no aporta nada aqui.
    tls: { rejectUnauthorized: false },
  });

  return transporte;
}

/** Comprueba si ya se aviso de esta IP hace poco. */
function avisadoRecientemente(db: Db, ip: string): boolean {
  const desde = new Date(Date.now() - HORAS_ENTRE_AVISOS * 60 * 60_000).toISOString();

  const fila = db
    .prepare(
      `SELECT 1 AS hay FROM audit_log
       WHERE action = 'aviso_intentos' AND detail = ? AND created_at >= ?
       LIMIT 1`,
    )
    .get(ip, desde) as { hay: number } | undefined;

  return fila !== undefined;
}

export interface DatosDelAviso {
  ip: string;
  fallos: number;
  minutosBloqueo: number;
}

/**
 * Manda el aviso, si procede.
 *
 * NUNCA lanza: un fallo de correo no puede tumbar el login. Si el servidor
 * SMTP esta caido, lo peor que debe pasar es quedarse sin aviso, no que el
 * usuario no pueda entrar en su boveda.
 */
export async function avisarDeIntentos(
  db: Db,
  userId: string,
  datos: DatosDelAviso,
): Promise<boolean> {
  const emisor = obtenerTransporte();
  if (emisor === null || config.smtp === null) {
    return false;
  }

  if (avisadoRecientemente(db, datos.ip)) {
    return false;
  }

  const cuando = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const texto = [
    'Alguien ha intentado entrar en tu boveda y ha sido bloqueado.',
    '',
    `Cuando:   ${cuando} UTC`,
    `Desde:    ${datos.ip}`,
    `Intentos: ${String(datos.fallos)} fallidos seguidos`,
    `Bloqueo:  ${String(datos.minutosBloqueo)} minutos`,
    '',
    'Si has sido tu, ignora este mensaje: el bloqueo se levanta solo.',
    '',
    'Si no has sido tu, tus ficheros siguen cifrados y a salvo: sin la',
    'contrasena maestra no se puede descifrar nada, ni siquiera desde el',
    'propio servidor. Aun asi, plantéate cambiar la contrasena.',
    '',
    '--',
    'Locker DrApps. Este aviso no contiene ningun dato de tus ficheros.',
  ].join('\n');

  try {
    await emisor.sendMail({
      from: `Locker DrApps <${config.smtp.user}>`,
      to: config.smtp.destinoAvisos,
      subject: `[Locker] Intentos de acceso bloqueados desde ${datos.ip}`,
      text: texto,
    });
  } catch {
    // Silencio a proposito: sin el catch, un SMTP caido tumbaria el login.
    return false;
  }

  db.prepare(
    `INSERT INTO audit_log (user_id, action, node_id, ip, detail, created_at)
     VALUES (?, 'aviso_intentos', NULL, ?, ?, ?)`,
  ).run(userId, datos.ip, datos.ip, new Date().toISOString());

  return true;
}

/** Solo para tests: reinicia el transporte cacheado. */
export function reiniciarTransporte(): void {
  transporte = null;
}
