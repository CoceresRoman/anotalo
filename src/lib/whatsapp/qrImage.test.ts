import { expect, test } from "vitest";
import QRCode from "qrcode";
import { renderPairingQrSvg, QR_QUIET_ZONE_MODULES } from "./qrImage";

// Un payload de pareo de Baileys es largo (~200 caracteres); usamos uno
// representativo para ejercitar el auto-size de la versión del QR.
const LONG_PAYLOAD = "2@" + "A".repeat(200) + ",xyz/abc+DEF==";

function viewBoxSide(svg: string): number {
  const m = svg.match(/viewBox="0 0 (\d+) \d+"/);
  if (!m) throw new Error("el SVG no tiene viewBox");
  return Number(m[1]);
}

test("renderPairingQrSvg devuelve markup SVG", async () => {
  const svg = await renderPairingQrSvg(LONG_PAYLOAD);
  expect(svg).toContain("<svg");
});

// El fallo histórico: WhatsApp rechaza (sin error) un QR sin zona de silencio.
// Este test afirma el margen en el OUTPUT real (el lado del viewBox == tamaño
// del símbolo + 2×margen), no sobre el objeto de opciones — así falla si
// alguien saca el margen.
test("el SVG incluye la zona de silencio (quiet zone) en el output", async () => {
  const svg = await renderPairingQrSvg(LONG_PAYLOAD);
  const symbolSize = QRCode.create(LONG_PAYLOAD, { errorCorrectionLevel: "M" }).modules.size;
  expect(viewBoxSide(svg)).toBe(symbolSize + 2 * QR_QUIET_ZONE_MODULES);
  expect(QR_QUIET_ZONE_MODULES).toBeGreaterThanOrEqual(4);
});

// El payload largo no se trunca: QRCode.create lanza si no entra, así que que
// no lance (y elija una versión > 1, cuyo símbolo mide más de 21 módulos)
// prueba que la versión se autoajusta al largo.
test("el payload largo de Baileys no se trunca (auto-size de versión)", () => {
  const qr = QRCode.create(LONG_PAYLOAD, { errorCorrectionLevel: "M" });
  expect(qr.modules.size).toBeGreaterThan(21);
});
