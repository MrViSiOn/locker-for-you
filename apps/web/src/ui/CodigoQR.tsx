import generarQr from 'qrcode-generator';

import { color } from './tokens.js';

/**
 * Código QR, dibujado como SVG.
 *
 * SVG y no canvas por dos motivos concretos: se imprime nítido a cualquier
 * tamaño, y no obliga a leer píxeles de un canvas, que es justo la clase de
 * operación que una CSP estricta acaba complicando.
 *
 * La librería se empaqueta con la app y se sirve desde nuestro propio origen.
 * Aquí no cabe un QR generado por un servicio externo: la URL `otpauth://`
 * lleva el secreto del segundo factor, y mandárselo a un tercero para que
 * dibuje una imagen sería regalarlo.
 */

/**
 * Corrección de errores media: aguanta manchas y dobleces sin agrandar
 * demasiado el código. Este QR se imprime y se guarda en un papel.
 */
const NIVEL_DE_CORRECCION = 'M';

export function CodigoQR({
  texto,
  tamano = 200,
}: {
  texto: string;
  tamano?: number;
}): React.JSX.Element {
  // Tipo 0 = que la librería elija el tamaño mínimo que admita el contenido.
  const qr = generarQr(0, NIVEL_DE_CORRECCION);
  qr.addData(texto);
  qr.make();

  const modulos = qr.getModuleCount();

  // Un borde en blanco alrededor no es decorativo: sin esa "zona tranquila"
  // muchos lectores no reconocen el código.
  const margen = 2;
  const lado = modulos + margen * 2;

  const trazos: string[] = [];
  for (let fila = 0; fila < modulos; fila++) {
    for (let columna = 0; columna < modulos; columna++) {
      if (qr.isDark(fila, columna)) {
        trazos.push(`M${String(columna + margen)},${String(fila + margen)}h1v1h-1z`);
      }
    }
  }

  return (
    <svg
      width={tamano}
      height={tamano}
      viewBox={`0 0 ${String(lado)} ${String(lado)}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="Código QR para la aplicación de autenticación"
      style={{ borderRadius: '2px', display: 'block' }}
    >
      {/* El fondo va claro siempre, incluso en una interfaz oscura: un QR en
          negativo lo rechazan bastantes lectores. */}
      <rect width={lado} height={lado} fill={color.papel} />
      <path d={trazos.join('')} fill={color.papelTinta} />
    </svg>
  );
}
