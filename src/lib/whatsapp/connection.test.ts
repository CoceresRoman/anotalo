import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import db from "../db";

// Baileys' own types/enums (DisconnectReason etc.) are real — only the
// network-touching pieces (makeWASocket, useMultiFileAuthState,
// downloadMediaMessage) are replaced with mocks, so connection.ts can be
// exercised end-to-end (event wiring, routing, reconnect backoff) without a
// real socket, a real phone, or a real pairing.
const { mockMakeWASocket, mockUseMultiFileAuthState, mockDownloadMediaMessage, createFakeSocket } =
  vi.hoisted(() => {
    function createFakeSocket(ownJid: string, ownLid?: string) {
      const handlers: Record<string, (...args: unknown[]) => unknown> = {};
      return {
        ev: {
          on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
            handlers[event] = handler;
          }),
        },
        user: { id: ownJid, ...(ownLid ? { lid: ownLid } : {}) },
        sendMessage: vi.fn().mockResolvedValue(undefined),
        logger: {},
        updateMediaMessage: vi.fn(),
        __handlers: handlers,
      };
    }

    return {
      createFakeSocket,
      mockMakeWASocket: vi.fn(),
      mockUseMultiFileAuthState: vi.fn().mockResolvedValue({ state: {}, saveCreds: vi.fn() }),
      mockDownloadMediaMessage: vi.fn().mockResolvedValue(Buffer.from("audio-bytes")),
    };
  });

vi.mock("@whiskeysockets/baileys", async () => {
  const actual =
    await vi.importActual<typeof import("@whiskeysockets/baileys")>("@whiskeysockets/baileys");
  return {
    ...actual,
    default: mockMakeWASocket,
    makeWASocket: mockMakeWASocket,
    useMultiFileAuthState: mockUseMultiFileAuthState,
    downloadMediaMessage: mockDownloadMediaMessage,
  };
});

// The on-open reminder resume is stubbed; the rest of reminders.ts
// stays real so the router (used for real in the end-to-end tests below)
// works. The LLM is stubbed too.
const mockResumeReminderQueue = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./reminders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reminders")>()),
  resumeReminderQueue: mockResumeReminderQueue,
}));
const mockClassifyMessage = vi.hoisted(() => vi.fn());
vi.mock("./classify", () => ({ classifyMessage: mockClassifyMessage }));

let isSelfChatMessage: typeof import("./connection").isSelfChatMessage;
let sendSelfMessage: typeof import("./connection").sendSelfMessage;
let startWhatsAppConnection: typeof import("./connection").startWhatsAppConnection;
let getWhatsappLinkStatus: typeof import("./connection").getWhatsappLinkStatus;
let handleIncomingMessage: typeof import("./router").handleIncomingMessage;

// The durable first-boot cutoff file, redirected to a throwaway path so the
// real .wa-first-boot.json next to .wa-auth/ is never touched by tests.
const FIRST_BOOT_FILE = path.join(os.tmpdir(), `notas-wa-first-boot-${process.pid}.json`);
process.env.WA_FIRST_BOOT_FILE = FIRST_BOOT_FILE;

beforeAll(async () => {
  ({ isSelfChatMessage, sendSelfMessage, startWhatsAppConnection, getWhatsappLinkStatus } =
    await import("./connection"));
  ({ handleIncomingMessage } = await import("./router"));
});

const OWN_JID = "5491122334455@s.whatsapp.net";

type SharedState = {
  firstBootCutoffMs: number | null;
  selfSentIds: Map<string, number>;
  queue: Promise<void>;
  lastQr: string | null;
  connection: "connecting" | "open" | "close";
};
function sharedState(): SharedState {
  return (globalThis as unknown as { __notasWhatsApp: SharedState }).__notasWhatsApp;
}

beforeEach(async () => {
  mockMakeWASocket.mockReset();
  mockUseMultiFileAuthState.mockClear();
  mockDownloadMediaMessage.mockClear();
  mockResumeReminderQueue.mockReset().mockResolvedValue(undefined);
  mockClassifyMessage.mockReset();
  rmSync(FIRST_BOOT_FILE, { force: true });
  const st = sharedState();
  if (st) {
    st.firstBootCutoffMs = null;
    st.selfSentIds.clear();
    st.queue = Promise.resolve();
    st.lastQr = null;
    st.connection = "connecting";
  }
  await db.processedMessage.deleteMany();
  await db.expense.deleteMany();
  await db.reminder.deleteMany();
  await db.note.deleteMany();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  rmSync(FIRST_BOOT_FILE, { force: true });
});

test("isSelfChatMessage is true only for fromMe messages whose remoteJid equals one of the own JIDs", () => {
  const ownJid = OWN_JID;
  expect(isSelfChatMessage({ key: { remoteJid: ownJid, fromMe: true } }, [ownJid])).toBe(true);
  expect(
    isSelfChatMessage({ key: { remoteJid: "other@s.whatsapp.net", fromMe: true } }, [ownJid])
  ).toBe(false);
  expect(isSelfChatMessage({ key: { remoteJid: ownJid, fromMe: false } }, [ownJid])).toBe(false);
});

test("isSelfChatMessage matches a LID-addressed remoteJid when the own LID is among the own JIDs", () => {
  const ownLid = "35141523095807@lid";
  expect(isSelfChatMessage({ key: { remoteJid: ownLid, fromMe: true } }, [OWN_JID, ownLid])).toBe(
    true
  );
  // Without the LID in the accepted set (e.g. WhatsApp hasn't handed this
  // device a LID yet), the same message is correctly not recognized.
  expect(isSelfChatMessage({ key: { remoteJid: ownLid, fromMe: true } }, [OWN_JID])).toBe(false);
});

test("startWhatsAppConnection does not throw and wires the three event handlers to the socket", async () => {
  const fakeSocket = createFakeSocket(OWN_JID);
  mockMakeWASocket.mockReturnValue(fakeSocket);

  await expect(startWhatsAppConnection(vi.fn())).resolves.toBeUndefined();

  expect(mockUseMultiFileAuthState).toHaveBeenCalledWith(expect.stringContaining(".wa-auth"));
  expect(mockMakeWASocket).toHaveBeenCalled();
  expect(fakeSocket.ev.on).toHaveBeenCalledWith("creds.update", expect.any(Function));
  expect(fakeSocket.ev.on).toHaveBeenCalledWith("connection.update", expect.any(Function));
  expect(fakeSocket.ev.on).toHaveBeenCalledWith("messages.upsert", expect.any(Function));
});

test("routes a self-chat text message to onMessage as (text, id, 'text', undefined)", async () => {
  const fakeSocket = createFakeSocket(OWN_JID);
  mockMakeWASocket.mockReturnValue(fakeSocket);
  const onMessage = vi.fn().mockResolvedValue(undefined);

  await startWhatsAppConnection(onMessage);
  await fakeSocket.__handlers["messages.upsert"]({
    messages: [
      {
        key: { remoteJid: OWN_JID, fromMe: true, id: "WA-MSG-1" },
        message: { conversation: "gasté 500 en nafta" },
      },
    ],
    type: "notify",
  });

  expect(onMessage).toHaveBeenCalledWith("gasté 500 en nafta", "WA-MSG-1", "text", undefined);
});

test("still recognizes the self chat when sock.user.id carries a multi-device suffix", async () => {
  // Real WhatsApp multi-device JIDs look like "<number>:<device>@s.whatsapp.net",
  // but a chat's remoteJid never carries that device suffix — without
  // normalizing sock.user.id first, this message would be wrongly dropped.
  const fakeSocket = createFakeSocket(`${OWN_JID.split("@")[0]}:19@s.whatsapp.net`);
  mockMakeWASocket.mockReturnValue(fakeSocket);
  const onMessage = vi.fn().mockResolvedValue(undefined);

  await startWhatsAppConnection(onMessage);
  await fakeSocket.__handlers["messages.upsert"]({
    messages: [
      {
        key: { remoteJid: OWN_JID, fromMe: true, id: "WA-MSG-DEVICE" },
        message: { conversation: "funciona con sufijo de dispositivo" },
      },
    ],
    type: "notify",
  });

  expect(onMessage).toHaveBeenCalledWith(
    "funciona con sufijo de dispositivo",
    "WA-MSG-DEVICE",
    "text",
    undefined
  );
});

test("routes a self-chat message whose remoteJid is the LID form once WhatsApp has handed this device a LID", async () => {
  // Reproduces the production bug: WhatsApp's newer LID addressing scheme
  // can report a self-chat message's remoteJid as "<id>@lid" instead of
  // the phone-number "<number>@s.whatsapp.net" form, with sock.user.lid
  // carrying this device's own LID identity. Before accepting both forms,
  // this message was silently dropped — not even logged as ignored.
  const ownLid = "35141523095807@lid";
  const fakeSocket = createFakeSocket(OWN_JID, ownLid);
  mockMakeWASocket.mockReturnValue(fakeSocket);
  const onMessage = vi.fn().mockResolvedValue(undefined);

  await startWhatsAppConnection(onMessage);
  await fakeSocket.__handlers["messages.upsert"]({
    messages: [
      {
        key: { remoteJid: ownLid, fromMe: true, id: "WA-MSG-LID" },
        message: { conversation: "mensaje direccionado por LID" },
      },
    ],
    type: "notify",
  });

  expect(onMessage).toHaveBeenCalledWith("mensaje direccionado por LID", "WA-MSG-LID", "text", undefined);
});

test("still ignores a message addressed to a LID that isn't this device's own (fromMe true, different LID)", async () => {
  const fakeSocket = createFakeSocket(OWN_JID, "35141523095807@lid");
  mockMakeWASocket.mockReturnValue(fakeSocket);
  const onMessage = vi.fn().mockResolvedValue(undefined);

  await startWhatsAppConnection(onMessage);
  await fakeSocket.__handlers["messages.upsert"]({
    messages: [
      {
        key: { remoteJid: "99999999999999@lid", fromMe: true, id: "WA-MSG-OTHER-LID" },
        message: { conversation: "no es mi chat" },
      },
    ],
    type: "notify",
  });

  expect(onMessage).not.toHaveBeenCalled();
});

test("extracts text from extendedTextMessage when conversation is absent", async () => {
  const fakeSocket = createFakeSocket(OWN_JID);
  mockMakeWASocket.mockReturnValue(fakeSocket);
  const onMessage = vi.fn().mockResolvedValue(undefined);

  await startWhatsAppConnection(onMessage);
  await fakeSocket.__handlers["messages.upsert"]({
    messages: [
      {
        key: { remoteJid: OWN_JID, fromMe: true, id: "WA-MSG-2" },
        message: { extendedTextMessage: { text: "idea: app de notas" } },
      },
    ],
    type: "notify",
  });

  expect(onMessage).toHaveBeenCalledWith("idea: app de notas", "WA-MSG-2", "text", undefined);
});

test("ignores messages that are not in the self chat (fromMe true but different remoteJid)", async () => {
  const fakeSocket = createFakeSocket(OWN_JID);
  mockMakeWASocket.mockReturnValue(fakeSocket);
  const onMessage = vi.fn().mockResolvedValue(undefined);

  await startWhatsAppConnection(onMessage);
  await fakeSocket.__handlers["messages.upsert"]({
    messages: [
      {
        key: { remoteJid: "5491199998888@s.whatsapp.net", fromMe: true, id: "WA-MSG-3" },
        message: { conversation: "mensaje a otro chat" },
      },
    ],
    type: "notify",
  });

  expect(onMessage).not.toHaveBeenCalled();
});

test("ignores incoming messages from others even in the own JID's chat (fromMe false)", async () => {
  const fakeSocket = createFakeSocket(OWN_JID);
  mockMakeWASocket.mockReturnValue(fakeSocket);
  const onMessage = vi.fn().mockResolvedValue(undefined);

  await startWhatsAppConnection(onMessage);
  await fakeSocket.__handlers["messages.upsert"]({
    messages: [
      {
        key: { remoteJid: OWN_JID, fromMe: false, id: "WA-MSG-4" },
        message: { conversation: "no debería procesarse" },
      },
    ],
    type: "notify",
  });

  expect(onMessage).not.toHaveBeenCalled();
});

test("routes a self-chat audio message to onMessage as (null, id, 'audio', buffer) after downloading it", async () => {
  const fakeSocket = createFakeSocket(OWN_JID);
  mockMakeWASocket.mockReturnValue(fakeSocket);
  const onMessage = vi.fn().mockResolvedValue(undefined);
  const audioMessage = { mimetype: "audio/ogg" };
  const waMessage = {
    key: { remoteJid: OWN_JID, fromMe: true, id: "WA-MSG-5" },
    message: { audioMessage },
  };

  await startWhatsAppConnection(onMessage);
  await fakeSocket.__handlers["messages.upsert"]({ messages: [waMessage], type: "notify" });

  expect(mockDownloadMediaMessage).toHaveBeenCalledWith(
    waMessage,
    "buffer",
    {},
    expect.objectContaining({ reuploadRequest: fakeSocket.updateMediaMessage })
  );
  expect(onMessage).toHaveBeenCalledWith(null, "WA-MSG-5", "audio", Buffer.from("audio-bytes"));
});

test("un mensaje con imageMessage descarga la imagen y llama a onMessage con source 'image'", async () => {
  const fakeSocket = createFakeSocket(OWN_JID);
  mockMakeWASocket.mockReturnValue(fakeSocket);
  const onMessage = vi.fn().mockResolvedValue(undefined);
  mockDownloadMediaMessage.mockResolvedValueOnce(Buffer.from("image-bytes"));
  const imageMessage = { mimetype: "image/jpeg" };
  const waMessage = {
    key: { remoteJid: OWN_JID, fromMe: true, id: "WA-MSG-IMG-1" },
    message: { imageMessage },
  };

  await startWhatsAppConnection(onMessage);
  await fakeSocket.__handlers["messages.upsert"]({ messages: [waMessage], type: "notify" });

  expect(mockDownloadMediaMessage).toHaveBeenCalledWith(
    waMessage,
    "buffer",
    {},
    expect.objectContaining({ reuploadRequest: fakeSocket.updateMediaMessage })
  );
  expect(onMessage).toHaveBeenCalledWith(null, "WA-MSG-IMG-1", "image", Buffer.from("image-bytes"));
});

test("si falla la descarga de una imagen, igual se llama a onMessage con source 'image' sin buffer", async () => {
  const fakeSocket = createFakeSocket(OWN_JID);
  mockMakeWASocket.mockReturnValue(fakeSocket);
  mockDownloadMediaMessage.mockRejectedValueOnce(new Error("image download failed"));
  const onMessage = vi.fn().mockResolvedValue(undefined);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  await startWhatsAppConnection(onMessage);
  await fakeSocket.__handlers["messages.upsert"]({
    messages: [
      {
        key: { remoteJid: OWN_JID, fromMe: true, id: "WA-MSG-IMG-2" },
        message: { imageMessage: { mimetype: "image/jpeg" } },
      },
    ],
    type: "notify",
  });

  expect(onMessage).toHaveBeenCalledWith(null, "WA-MSG-IMG-2", "image", undefined);
  errorSpy.mockRestore();
});

test("startWhatsAppConnection schedules a reconnect attempt when the socket closes for a retryable reason", async () => {
  const fakeSocket = createFakeSocket(OWN_JID);
  mockMakeWASocket.mockReturnValue(fakeSocket);
  const scheduleSpy = vi.fn();

  await startWhatsAppConnection(vi.fn(), scheduleSpy);
  await fakeSocket.__handlers["connection.update"]({
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 408 } }, date: new Date() },
  });

  expect(scheduleSpy).toHaveBeenCalledTimes(1);
  expect(scheduleSpy).toHaveBeenCalledWith(1000, expect.any(Function));
});

test("does NOT schedule a reconnect when the disconnect reason is a logged-out session", async () => {
  const fakeSocket = createFakeSocket(OWN_JID);
  mockMakeWASocket.mockReturnValue(fakeSocket);
  const scheduleSpy = vi.fn();

  await startWhatsAppConnection(vi.fn(), scheduleSpy);
  await fakeSocket.__handlers["connection.update"]({
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 401 } }, date: new Date() },
  });

  expect(scheduleSpy).not.toHaveBeenCalled();
});

test("reconnect backoff doubles on successive retryable closes, capped at 60s", async () => {
  const fakeSocket = createFakeSocket(OWN_JID);
  mockMakeWASocket.mockReturnValue(fakeSocket);
  const scheduleSpy = vi.fn();
  const closeEvent = {
    connection: "close" as const,
    lastDisconnect: { error: { output: { statusCode: 408 } }, date: new Date() },
  };

  await startWhatsAppConnection(vi.fn(), scheduleSpy);
  await fakeSocket.__handlers["connection.update"](closeEvent);
  expect(scheduleSpy.mock.calls[0][0]).toBe(1000);

  // Invoking the scheduled callback simulates the timer firing: it
  // reconnects (recursing into startWhatsAppConnection with the attempt
  // count carried forward) and re-registers handlers on the same fake
  // socket, so the next close is reachable the same way.
  await scheduleSpy.mock.calls[0][1]();
  await fakeSocket.__handlers["connection.update"](closeEvent);
  expect(scheduleSpy.mock.calls[1][0]).toBe(2000);

  await scheduleSpy.mock.calls[1][1]();
  await fakeSocket.__handlers["connection.update"](closeEvent);
  expect(scheduleSpy.mock.calls[2][0]).toBe(4000);

  // Drive it far enough that the uncapped value (1000 * 2^n) would blow past
  // 60s, and confirm it's clamped instead of growing unbounded.
  for (let i = 3; i < 8; i++) {
    await scheduleSpy.mock.calls[i - 1][1]();
    await fakeSocket.__handlers["connection.update"](closeEvent);
  }
  expect(scheduleSpy.mock.calls[7][0]).toBe(60_000);
});

test("a fresh connection (connection === open) resets the backoff counter for its own subsequent closes", async () => {
  const fakeSocket = createFakeSocket(OWN_JID);
  mockMakeWASocket.mockReturnValue(fakeSocket);
  const scheduleSpy = vi.fn();

  await startWhatsAppConnection(vi.fn(), scheduleSpy);
  await fakeSocket.__handlers["connection.update"]({ connection: "open" });
  await fakeSocket.__handlers["connection.update"]({
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 408 } }, date: new Date() },
  });

  expect(scheduleSpy).toHaveBeenCalledWith(1000, expect.any(Function));
});

test("getWhatsappLinkStatus arranca sin conexión y sin QR", () => {
  expect(getWhatsappLinkStatus()).toEqual({ connected: false, qr: null });
});

test("un evento connection.update con qr expone ese QR sin marcar conectado", async () => {
  const fakeSocket = createFakeSocket(OWN_JID);
  mockMakeWASocket.mockReturnValue(fakeSocket);

  await startWhatsAppConnection(vi.fn(), vi.fn());
  await fakeSocket.__handlers["connection.update"]({ qr: "QR-PAYLOAD-DE-PAREO" });

  expect(getWhatsappLinkStatus()).toEqual({ connected: false, qr: "QR-PAYLOAD-DE-PAREO" });
});

test("connection === open marca conectado y limpia el QR", async () => {
  const fakeSocket = createFakeSocket(OWN_JID);
  mockMakeWASocket.mockReturnValue(fakeSocket);

  await startWhatsAppConnection(vi.fn(), vi.fn());
  await fakeSocket.__handlers["connection.update"]({ qr: "QR-PAYLOAD-DE-PAREO" });
  await fakeSocket.__handlers["connection.update"]({ connection: "open" });

  expect(getWhatsappLinkStatus()).toEqual({ connected: true, qr: null });
});

test("sendSelfMessage throws before any connection has been established", async () => {
  // The live socket is process-wide state on globalThis, so "no
  // connection yet" means a process where that state was never created.
  const saved = (globalThis as Record<string, unknown>).__notasWhatsApp;
  delete (globalThis as Record<string, unknown>).__notasWhatsApp;
  try {
    vi.resetModules();
    const freshModule = await import("./connection");
    await expect(freshModule.sendSelfMessage("hola")).rejects.toThrow();
  } finally {
    (globalThis as Record<string, unknown>).__notasWhatsApp = saved;
  }
});

test("sendSelfMessage sends text to the socket's own JID using the active connection", async () => {
  const fakeSocket = createFakeSocket(OWN_JID);
  mockMakeWASocket.mockReturnValue(fakeSocket);

  await startWhatsAppConnection(vi.fn());
  await sendSelfMessage("listo");

  expect(fakeSocket.sendMessage).toHaveBeenCalledWith(
    OWN_JID,
    { text: "listo" },
    { messageId: expect.any(String) }
  );
});

test("sendSelfMessage normalizes a device-suffixed own JID before sending", async () => {
  const fakeSocket = createFakeSocket(`${OWN_JID.split("@")[0]}:19@s.whatsapp.net`);
  mockMakeWASocket.mockReturnValue(fakeSocket);

  await startWhatsAppConnection(vi.fn());
  await sendSelfMessage("listo");

  expect(fakeSocket.sendMessage).toHaveBeenCalledWith(
    OWN_JID,
    { text: "listo" },
    { messageId: expect.any(String) }
  );
});

test("ignores an 'append' batch when the bot has never opened a connection yet (pure pre-pairing history)", async () => {
  const fakeSocket = createFakeSocket(OWN_JID);
  mockMakeWASocket.mockReturnValue(fakeSocket);
  const onMessage = vi.fn().mockResolvedValue(undefined);

  await startWhatsAppConnection(onMessage);
  await fakeSocket.__handlers["messages.upsert"]({
    messages: [
      {
        key: { remoteJid: OWN_JID, fromMe: true, id: "WA-HISTORY-1" },
        message: { conversation: "un mensaje viejo del historial" },
      },
    ],
    type: "append",
  });

  expect(onMessage).not.toHaveBeenCalled();
});

test("does not re-deliver a message this module itself sent via sendSelfMessage (echo-loop guard)", async () => {
  const fakeSocket = createFakeSocket(OWN_JID);
  mockMakeWASocket.mockReturnValue(fakeSocket);
  const onMessage = vi.fn().mockResolvedValue(undefined);

  await startWhatsAppConnection(onMessage);
  await sendSelfMessage("confirmado");

  const [, , sendOptions] = fakeSocket.sendMessage.mock.calls[0];
  const sentMessageId = (sendOptions as { messageId: string }).messageId;
  expect(sentMessageId).toEqual(expect.any(String));

  // This is exactly what Baileys does in reality: a message sent into the
  // self-chat echoes back through messages.upsert with fromMe: true and the
  // own remoteJid — otherwise indistinguishable from a message you typed.
  await fakeSocket.__handlers["messages.upsert"]({
    messages: [
      {
        key: { remoteJid: OWN_JID, fromMe: true, id: sentMessageId },
        message: { conversation: "confirmado" },
      },
    ],
    type: "notify",
  });

  expect(onMessage).not.toHaveBeenCalled();
});

test("a thrown error from onMessage for one message does not crash processing of the rest of the batch", async () => {
  const fakeSocket = createFakeSocket(OWN_JID);
  mockMakeWASocket.mockReturnValue(fakeSocket);
  const onMessage = vi
    .fn()
    .mockRejectedValueOnce(new Error("boom"))
    .mockResolvedValueOnce(undefined);

  await startWhatsAppConnection(onMessage);

  await expect(
    fakeSocket.__handlers["messages.upsert"]({
      messages: [
        {
          key: { remoteJid: OWN_JID, fromMe: true, id: "WA-BAD" },
          message: { conversation: "esto hace explotar a onMessage" },
        },
        {
          key: { remoteJid: OWN_JID, fromMe: true, id: "WA-GOOD" },
          message: { conversation: "este debería seguir procesándose" },
        },
      ],
      type: "notify",
    })
  ).resolves.toBeUndefined();

  expect(onMessage).toHaveBeenCalledTimes(2);
  expect(onMessage).toHaveBeenNthCalledWith(
    2,
    "este debería seguir procesándose",
    "WA-GOOD",
    "text",
    undefined
  );
});

test("a downloadMediaMessage failure for one audio message does not crash processing of the rest of the batch", async () => {
  const fakeSocket = createFakeSocket(OWN_JID);
  mockMakeWASocket.mockReturnValue(fakeSocket);
  mockDownloadMediaMessage.mockRejectedValueOnce(new Error("network blip"));
  const onMessage = vi.fn().mockResolvedValue(undefined);

  await startWhatsAppConnection(onMessage);

  await expect(
    fakeSocket.__handlers["messages.upsert"]({
      messages: [
        {
          key: { remoteJid: OWN_JID, fromMe: true, id: "WA-AUDIO-FAIL" },
          message: { audioMessage: { mimetype: "audio/ogg" } },
        },
        {
          key: { remoteJid: OWN_JID, fromMe: true, id: "WA-AFTER-FAIL" },
          message: { conversation: "este sí debería llegar" },
        },
      ],
      type: "notify",
    })
  ).resolves.toBeUndefined();

  // The failed-download voice note is still handed over (no buffer) —
  // the old behavior (silently never calling onMessage) lost it.
  expect(onMessage).toHaveBeenCalledTimes(2);
  expect(onMessage).toHaveBeenNthCalledWith(1, null, "WA-AUDIO-FAIL", "audio", undefined);
  expect(onMessage).toHaveBeenNthCalledWith(2, "este sí debería llegar", "WA-AFTER-FAIL", "text", undefined);
});

test("A voice note whose download fails still ends up as a persisted no_identificado Note (end to end through the router)", async () => {
  const fakeSocket = createFakeSocket(OWN_JID);
  mockMakeWASocket.mockReturnValue(fakeSocket);
  mockDownloadMediaMessage.mockRejectedValueOnce(new Error("media expired"));
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  await startWhatsAppConnection(handleIncomingMessage);
  await fakeSocket.__handlers["messages.upsert"]({
    messages: [
      {
        key: { remoteJid: OWN_JID, fromMe: true, id: "WA-AUDIO-LOST" },
        message: { audioMessage: { mimetype: "audio/ogg" } },
      },
    ],
    type: "notify",
  });

  const note = await db.note.findUnique({ where: { whatsappMessageId: "WA-AUDIO-LOST" } });
  expect(note?.type).toBe("no_identificado");
  expect(note?.source).toBe("audio");
  errorSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Offline delivery, first-boot cutoff, echo guard, queueing
// ---------------------------------------------------------------------------

const BOOT = new Date("2026-10-28T12:00:00Z");
const secondsAfterBoot = (s: number) => Math.floor(BOOT.getTime() / 1000) + s;

function selfMsg(id: string, text: string, messageTimestamp?: number) {
  return {
    key: { remoteJid: OWN_JID, fromMe: true, id },
    message: { conversation: text },
    ...(messageTimestamp !== undefined ? { messageTimestamp } : {}),
  };
}

async function bootAt(date: Date, onMessage: (...args: never[]) => Promise<void>, scheduleSpy = vi.fn()) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(date);
  const fakeSocket = createFakeSocket(`${OWN_JID.split("@")[0]}:7@s.whatsapp.net`);
  mockMakeWASocket.mockReturnValue(fakeSocket);
  await startWhatsAppConnection(onMessage as never, scheduleSpy);
  await fakeSocket.__handlers["connection.update"]({ connection: "open" });
  return { fakeSocket, scheduleSpy };
}

test("The first successful open persists the first-boot cutoff, and later opens never overwrite it", async () => {
  const { fakeSocket } = await bootAt(BOOT, vi.fn().mockResolvedValue(undefined));
  const first = JSON.parse(readFileSync(FIRST_BOOT_FILE, "utf-8"));
  expect(first.firstOpenAt).toBe(BOOT.toISOString());

  vi.setSystemTime(new Date("2026-10-30T09:00:00Z"));
  await fakeSocket.__handlers["connection.update"]({ connection: "open" });
  // A process restart (fresh in-memory state) must not reset it either.
  sharedState().firstBootCutoffMs = null;
  await startWhatsAppConnection(vi.fn());
  await fakeSocket.__handlers["connection.update"]({ connection: "open" });

  expect(JSON.parse(readFileSync(FIRST_BOOT_FILE, "utf-8")).firstOpenAt).toBe(BOOT.toISOString());
});

test("Re-pairing (a new linked-device identity) gets its own fresh cutoff", async () => {
  await bootAt(BOOT, vi.fn().mockResolvedValue(undefined));

  const later = new Date("2026-11-02T10:00:00Z");
  vi.setSystemTime(later);
  const repaired = createFakeSocket(`${OWN_JID.split("@")[0]}:31@s.whatsapp.net`);
  mockMakeWASocket.mockReturnValue(repaired);
  await startWhatsAppConnection(vi.fn());
  await repaired.__handlers["connection.update"]({ connection: "open" });

  expect(JSON.parse(readFileSync(FIRST_BOOT_FILE, "utf-8")).firstOpenAt).toBe(later.toISOString());
});

test("After a disconnect + reconnect, an 'append' batch of messages sent while offline (after the cutoff) is processed into a real Note", async () => {
  mockClassifyMessage.mockResolvedValue({ intent: "capture", noteType: "idea" });
  const { fakeSocket, scheduleSpy } = await bootAt(BOOT, handleIncomingMessage);

  // Connection drops, the backoff timer fires, the bot reconnects.
  await fakeSocket.__handlers["connection.update"]({
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 408 } }, date: new Date() },
  });
  vi.setSystemTime(new Date(BOOT.getTime() + 10 * 60 * 1000));
  await scheduleSpy.mock.calls[0][1]();
  await fakeSocket.__handlers["connection.update"]({ connection: "open" });

  // Baileys delivers what the user sent while the bot was down as "append".
  await fakeSocket.__handlers["messages.upsert"]({
    messages: [selfMsg("WA-OFFLINE-1", "idea mandada con el bot caído", secondsAfterBoot(300))],
    type: "append",
  });

  const note = await db.note.findUnique({ where: { whatsappMessageId: "WA-OFFLINE-1" } });
  expect(note?.type).toBe("idea");
  expect(note?.rawText).toBe("idea mandada con el bot caído");
});

test("An 'append' batch with timestamps before the first-boot cutoff (pairing history replay) is ignored", async () => {
  const onMessage = vi.fn().mockResolvedValue(undefined);
  const { fakeSocket } = await bootAt(BOOT, onMessage);

  await fakeSocket.__handlers["messages.upsert"]({
    messages: [
      selfMsg("WA-HIST-1", "nota vieja de hace un mes", secondsAfterBoot(-30 * 24 * 3600)),
      selfMsg("WA-HIST-2", "nota vieja de ayer", secondsAfterBoot(-3600)),
    ],
    type: "append",
  });

  expect(onMessage).not.toHaveBeenCalled();
});

test("A buffered batch Baileys labels 'notify' still drops a pre-cutoff history message mixed into it", async () => {
  const onMessage = vi.fn().mockResolvedValue(undefined);
  const { fakeSocket } = await bootAt(BOOT, onMessage);

  await fakeSocket.__handlers["messages.upsert"]({
    messages: [selfMsg("WA-OLD", "viejo", secondsAfterBoot(-60)), selfMsg("WA-NEW", "nuevo", secondsAfterBoot(60))],
    type: "notify",
  });

  expect(onMessage).toHaveBeenCalledTimes(1);
  expect(onMessage).toHaveBeenCalledWith("nuevo", "WA-NEW", "text", undefined);
});

test("Offline messages in one 'append' batch are processed oldest first", async () => {
  const onMessage = vi.fn().mockResolvedValue(undefined);
  const { fakeSocket } = await bootAt(BOOT, onMessage);

  await fakeSocket.__handlers["messages.upsert"]({
    messages: [selfMsg("WA-B", "segundo", secondsAfterBoot(200)), selfMsg("WA-A", "primero", secondsAfterBoot(100))],
    type: "append",
  });

  expect(onMessage.mock.calls.map((c) => c[1])).toEqual(["WA-A", "WA-B"]);
});

test("The bot's own sent message is never redelivered as input when Baileys reports its echo as 'append' (or twice)", async () => {
  const onMessage = vi.fn().mockResolvedValue(undefined);
  const { fakeSocket } = await bootAt(BOOT, onMessage);
  vi.setSystemTime(new Date(BOOT.getTime() + 60_000));

  await sendSelfMessage("Entendí: algo, ¿va?");
  const sentId = (fakeSocket.sendMessage.mock.calls[0][2] as { messageId: string }).messageId;

  // messages-send.js emits our own send as "append" (emitOwnEvents) ...
  await fakeSocket.__handlers["messages.upsert"]({
    messages: [selfMsg(sentId, "Entendí: algo, ¿va?", secondsAfterBoot(60))],
    type: "append",
  });
  expect(onMessage).not.toHaveBeenCalled();

  // ... and a second echo of the same id (e.g. a "notify" from the server
  // or a later replay) reaches onMessage, where the router's durable
  // ledger still stops it (asserted end to end in the next test).
  expect(await db.processedMessage.findUnique({ where: { whatsappMessageId: sentId } })).toMatchObject({
    outcome: "self_sent",
  });
});

test("An echo of the bot's own message arriving after a restart (in-memory guard empty) still never becomes a Note", async () => {
  mockClassifyMessage.mockResolvedValue({ intent: "capture", noteType: "idea" });
  const { fakeSocket } = await bootAt(BOOT, handleIncomingMessage);
  vi.setSystemTime(new Date(BOOT.getTime() + 60_000));

  await sendSelfMessage("Entendí: \"turno\" para el 04/11/2026 a las 15:00, ¿va? (respondé sí/no)");
  const sentId = (fakeSocket.sendMessage.mock.calls[0][2] as { messageId: string }).messageId;
  sharedState().selfSentIds.clear(); // simulate a process restart

  await fakeSocket.__handlers["messages.upsert"]({
    messages: [selfMsg(sentId, "Entendí: ...", secondsAfterBoot(60))],
    type: "append",
  });

  expect(mockClassifyMessage).not.toHaveBeenCalled();
  expect(await db.note.count()).toBe(0);
});

test("The same message delivered by 'notify' and again in a later 'append' batch only has its effect once", async () => {
  mockClassifyMessage.mockResolvedValue({ intent: "capture", noteType: "idea" });
  const { fakeSocket } = await bootAt(BOOT, handleIncomingMessage);
  const msg = selfMsg("WA-TWICE", "una idea", secondsAfterBoot(30));

  await fakeSocket.__handlers["messages.upsert"]({ messages: [msg], type: "notify" });
  await fakeSocket.__handlers["messages.upsert"]({ messages: [msg], type: "append" });

  expect(mockClassifyMessage).toHaveBeenCalledTimes(1);
  expect(await db.note.count({ where: { whatsappMessageId: "WA-TWICE" } })).toBe(1);
});

test("messages.upsert batches are processed strictly one at a time, even when Baileys fires them without awaiting", async () => {
  let releaseFirst: () => void = () => {};
  const events: string[] = [];
  const onMessage = vi.fn(async (_text: string | null, id: string) => {
    events.push(`start:${id}`);
    if (id === "WA-1") await new Promise<void>((resolve) => (releaseFirst = resolve));
    events.push(`end:${id}`);
  });
  const fakeSocket = createFakeSocket(OWN_JID);
  mockMakeWASocket.mockReturnValue(fakeSocket);
  await startWhatsAppConnection(onMessage);

  // Fired back to back, NOT awaited — exactly how Baileys' emitter calls us.
  const first = fakeSocket.__handlers["messages.upsert"]({ messages: [selfMsg("WA-1", "sí")], type: "notify" });
  const second = fakeSocket.__handlers["messages.upsert"]({ messages: [selfMsg("WA-2", "dale")], type: "notify" });

  await vi.waitFor(() => expect(events).toEqual(["start:WA-1"]));
  await new Promise((r) => setTimeout(r, 20));
  expect(events).toEqual(["start:WA-1"]); // WA-2 has not started

  releaseFirst();
  await Promise.all([first, second]);
  expect(events).toEqual(["start:WA-1", "end:WA-1", "start:WA-2", "end:WA-2"]);
});

test("Every successful open (including reconnects) resumes the reminder queue", async () => {
  const { fakeSocket } = await bootAt(BOOT, vi.fn().mockResolvedValue(undefined));
  await sharedState().queue;
  expect(mockResumeReminderQueue).toHaveBeenCalledTimes(1);

  await fakeSocket.__handlers["connection.update"]({ connection: "open" });
  await sharedState().queue;
  expect(mockResumeReminderQueue).toHaveBeenCalledTimes(2);
});

test("A separately-instantiated copy of this module (as Next.js bundles API routes) sends through the same live socket", async () => {
  const fakeSocket = createFakeSocket(OWN_JID);
  mockMakeWASocket.mockReturnValue(fakeSocket);
  await startWhatsAppConnection(vi.fn());

  vi.resetModules();
  const routeBundleCopy = await import("./connection");
  await routeBundleCopy.sendSelfMessage("desde la webapp");

  expect(fakeSocket.sendMessage).toHaveBeenCalledWith(
    OWN_JID,
    { text: "desde la webapp" },
    { messageId: expect.any(String) }
  );
  // ...and its echo is recognized by the instance that owns the listener.
  const sentId = (fakeSocket.sendMessage.mock.calls[0][2] as { messageId: string }).messageId;
  expect(sharedState().selfSentIds.has(sentId)).toBe(true);
});
