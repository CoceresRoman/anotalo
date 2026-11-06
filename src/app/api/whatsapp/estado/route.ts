import { NextResponse } from "next/server";
import { getWhatsappLinkStatus } from "../../../../lib/whatsapp/connection";
import { renderPairingQrSvg } from "../../../../lib/whatsapp/qrImage";

// Fuerza el render por-request bajo `next start`. Sin esto, `next build`
// prerenderiza la ruta estática (su GET no lee `request`), horneando en
// build-time la respuesta {connected:false, qrSvg:null} (el bot no corre
// durante el build) y sirviéndola para siempre: la página /vincular nunca
// mostraría el QR ni "vinculado" en producción. Mismo opt-out que las rutas
// hermanas (recordatorios, sin-clasificar, dashboard).
export const dynamic = "force-dynamic";

// Estado de vinculación de WhatsApp para la página /vincular. Corre en runtime
// Node (default de Next): importa connection.ts, que importa Baileys, así que
// nunca debe marcarse como Edge. Queda detrás del login por el middleware
// (solo api/cron/ está excluido). Solo LEE el estado; no abre conexiones.
export async function GET() {
  const { connected, qr } = getWhatsappLinkStatus();
  if (connected || !qr) {
    return NextResponse.json({ connected, qrSvg: null });
  }
  const qrSvg = await renderPairingQrSvg(qr);
  return NextResponse.json({ connected, qrSvg });
}
