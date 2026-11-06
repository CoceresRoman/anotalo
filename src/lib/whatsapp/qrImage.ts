import QRCode from "qrcode";

// Zona de silencio (margen blanco) alrededor del QR, en módulos. El escáner de
// WhatsApp es estricto y rechaza —sin ningún error visible— un QR sin zona de
// silencio, así que esto va bakeado y lo afirma qrImage.test.ts sobre el output
// real: no es un default cosmético.
export const QR_QUIET_ZONE_MODULES = 4;

// Tamaño de display del SVG en px. node-qrcode lo escribe como width/height del
// <svg> sin tocar el viewBox (que sigue siendo símbolo + 2×margen), así que la
// aserción estructural de la zona de silencio en el test no se ve afectada.
const QR_DISPLAY_WIDTH_PX = 280;

// Renderiza el payload de pareo de Baileys a markup SVG escaneable. `margin`
// garantiza la zona de silencio; la versión del QR se autoajusta al largo del
// payload (el de Baileys es largo, ~200 caracteres), así que nada se trunca.
export async function renderPairingQrSvg(qr: string): Promise<string> {
  return QRCode.toString(qr, {
    type: "svg",
    margin: QR_QUIET_ZONE_MODULES,
    errorCorrectionLevel: "M",
    width: QR_DISPLAY_WIDTH_PX,
  });
}
