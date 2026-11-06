import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Only startWhatsAppConnection is mocked — instrumentation.ts's own logic
// (the runtime guard and the try/catch around the initial call) is real.
const mockStartWhatsAppConnection = vi.hoisted(() => vi.fn());

vi.mock("./lib/whatsapp/connection", () => ({
  startWhatsAppConnection: mockStartWhatsAppConnection,
}));

let originalNextRuntime: string | undefined;

beforeEach(() => {
  originalNextRuntime = process.env.NEXT_RUNTIME;
  mockStartWhatsAppConnection.mockReset();
});

afterEach(() => {
  if (originalNextRuntime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = originalNextRuntime;
});

test("register() does not throw when startWhatsAppConnection fails at startup (e.g. an unwritable .wa-auth dir)", async () => {
  process.env.NEXT_RUNTIME = "nodejs";
  mockStartWhatsAppConnection.mockRejectedValue(new Error("EACCES: permission denied, .wa-auth"));
  const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const { register } = await import("./instrumentation");
  await expect(register()).resolves.toBeUndefined();

  expect(mockStartWhatsAppConnection).toHaveBeenCalledTimes(1);
  expect(consoleErrorSpy).toHaveBeenCalled();

  consoleErrorSpy.mockRestore();
});

test("register() does nothing outside the nodejs runtime (e.g. edge)", async () => {
  process.env.NEXT_RUNTIME = "edge";

  const { register } = await import("./instrumentation");
  await expect(register()).resolves.toBeUndefined();

  expect(mockStartWhatsAppConnection).not.toHaveBeenCalled();
});
