import { beforeEach, expect, test, vi } from "vitest";

// Mockeamos solo connection (así el test no carga Baileys); qrImage queda real,
// de modo que el SVG se renderiza de verdad.
const { mockGetStatus } = vi.hoisted(() => ({ mockGetStatus: vi.fn() }));
vi.mock("../../../../lib/whatsapp/connection", () => ({
  getWhatsappLinkStatus: mockGetStatus,
}));

import { GET } from "./route";

beforeEach(() => {
  mockGetStatus.mockReset();
});

test("conectado => qrSvg null", async () => {
  mockGetStatus.mockReturnValue({ connected: true, qr: null });
  const res = await GET();
  expect(await res.json()).toEqual({ connected: true, qrSvg: null });
});

test("con un QR pendiente => qrSvg con markup SVG", async () => {
  mockGetStatus.mockReturnValue({ connected: false, qr: "2@" + "A".repeat(100) });
  const res = await GET();
  const body = await res.json();
  expect(body.connected).toBe(false);
  expect(body.qrSvg).toContain("<svg");
});

test("sin QR todavía (primer arranque) => qrSvg null", async () => {
  mockGetStatus.mockReturnValue({ connected: false, qr: null });
  const res = await GET();
  expect(await res.json()).toEqual({ connected: false, qrSvg: null });
});
