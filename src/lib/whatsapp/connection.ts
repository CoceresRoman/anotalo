// WhatsApp connection layer: wraps @whiskeysockets/baileys (an unofficial
// WhatsApp Web protocol client) to receive messages from your own
// "Mensaje a mí mismo" (message-to-self) chat and to send replies back into
// it. This module deliberately does nothing else: no transcription,
// no classification/routing — it only delivers raw text or raw
// audio bytes to whatever `onMessage` callback the caller supplies.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Boom } from "@hapi/boom";
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  generateMessageIDV2,
  jidNormalizedUser,
  toNumber,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import db from "../db";

// Auth state is persisted to disk (gitignored, see .gitignore's "whatsapp /
// google auth" section) so pairing survives process restarts — Baileys only
// needs a fresh QR scan again if this folder is deleted or the session gets
// logged out from the phone side.
const AUTH_STATE_DIR = path.resolve(process.cwd(), ".wa-auth");

// Durable "first boot" cutoff, next to .wa-auth/ (gitignored too):
// the moment this bot first ever opened a WhatsApp connection for the
// current linked-device identity. Messages timestamped before it are the
// pre-pairing history Baileys replays; messages after it are real input,
// even when Baileys reports them as type "append" (offline delivery on
// reconnect). Overridable for tests.
function firstBootFilePath(): string {
  return process.env.WA_FIRST_BOOT_FILE ?? path.resolve(process.cwd(), ".wa-first-boot.json");
}

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

// How long a self-sent message id is remembered in memory for the echo
// guard. The durable copy (ProcessedMessage "self_sent", checked by the
// router) covers anything later, including across restarts.
const SELF_SENT_TTL_MS = 60 * 60 * 1000;

export type IncomingMessageHandler = (
  text: string | null,
  waMessageId: string,
  source: "text" | "audio" | "image",
  mediaBuffer?: Buffer
) => Promise<void>;

// Injectable so tests can assert scheduling happened without real timers or
// a real socket. Defaults to plain setTimeout in production.
export type ScheduleReconnectFn = (delayMs: number, reconnect: () => void) => void;

function defaultScheduleReconnect(delayMs: number, reconnect: () => void): void {
  setTimeout(reconnect, delayMs);
}

// Both conditions matter: WhatsApp's self-chat ("Mensaje a mí mismo") is the
// one chat where the device's own outgoing messages come back through
// messages.upsert with fromMe: true AND a remoteJid equal to one of the
// device's own JIDs. fromMe is also true for messages the bot sends to
// *other* chats (which must NOT be treated as input), and group/other-chat
// messages can coincidentally share other fields — so both must hold
// together.
//
// "One of" (plural) because WhatsApp has two addressing schemes for the
// same device identity: the classic phone-number JID (@s.whatsapp.net) and
// the newer LID ("linked ID", @lid) scheme that hides the phone number.
// Which form a given self-chat stanza arrives under is decided
// server-side, per message, not by this app — Baileys itself only learns
// the device's own LID once WhatsApp hands one out (sock.user.lid) and
// still keeps sock.user.id in the phone-number form. A comparison against
// only one form silently drops every message WhatsApp happens to address
// via the other: no error, nothing logged — exactly the "bot does
// nothing" symptom seen in production before this was understood.
export function isSelfChatMessage(
  msg: { key: { remoteJid?: string | null; fromMe?: boolean } },
  ownJids: readonly string[]
): boolean {
  return (
    msg.key.fromMe === true &&
    !!msg.key.remoteJid &&
    ownJids.includes(msg.key.remoteJid)
  );
}

function extractText(message: WAMessage["message"]): string | null {
  return message?.conversation ?? message?.extendedTextMessage?.text ?? null;
}

// All mutable connection state lives on globalThis, the same pattern
// as the Prisma singleton in src/lib/db.ts: Next.js can instantiate this
// module more than once (instrumentation.ts's boot vs. an API route bundle
// such as sin-clasificar/[id], which reaches sendSelfMessage through
// enqueueReminder). Plain module-level variables would give the route its
// own `socket === null` copy (sendSelfMessage would throw) and its own
// empty self-sent set (its prompts' echoes wouldn't be recognized).
type ConnectionState = {
  socket: WASocket | null;
  // WhatsApp message ids sendSelfMessage itself sent -> when. Every message
  // we send into the self-chat echoes back through messages.upsert
  // (fromMe: true, remoteJid === ownJid), indistinguishable from something
  // you typed. The id is generated and recorded *before* sendMessage is
  // called, so the echo can't race past the check.
  selfSentIds: Map<string, number>;
  // Tail of the serialized processing queue: each messages.upsert
  // batch (and the on-open reminder resume) runs only after the previous
  // one fully finished. Baileys' emitter does not await async listeners,
  // so without this two batches could run handleIncomingMessage
  // concurrently (e.g. two "sí" replies both reaching Calendar).
  queue: Promise<void>;
  firstBootCutoffMs: number | null;
  // Último QR de pareo emitido por Baileys (null una vez conectado o antes del
  // primer QR) y el estado de conexión, para que la webapp pueda mostrar el QR
  // como imagen escaneable en vez de obligar a leerlo de los logs.
  lastQr: string | null;
  connection: "connecting" | "open" | "close";
};

const globalForWhatsApp = globalThis as unknown as { __notasWhatsApp?: ConnectionState };
const state: ConnectionState = (globalForWhatsApp.__notasWhatsApp ??= {
  socket: null,
  selfSentIds: new Map(),
  queue: Promise.resolve(),
  firstBootCutoffMs: null,
  lastQr: null,
  connection: "connecting",
});

// Estado de vinculación de WhatsApp para la webapp (página /vincular + ruta
// /api/whatsapp/estado). Solo lee el `state` a nivel de módulo que mantiene la
// conexión viva; nunca abre una conexión nueva.
export function getWhatsappLinkStatus(): { connected: boolean; qr: string | null } {
  return { connected: state.connection === "open", qr: state.lastQr };
}

function enqueue(work: () => Promise<void>): Promise<void> {
  const next = state.queue.then(work).catch((err) => {
    console.error("[whatsapp] queued work failed", err);
  });
  state.queue = next;
  return next;
}

function rememberSelfSent(messageId: string): void {
  const now = Date.now();
  state.selfSentIds.forEach((sentAt, id) => {
    if (now - sentAt > SELF_SENT_TTL_MS) state.selfSentIds.delete(id);
  });
  state.selfSentIds.set(messageId, now);
}

type FirstBootRecord = { identity: string; firstOpenAt: string };

function readFirstBootRecord(): FirstBootRecord | null {
  const file = firstBootFilePath();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<FirstBootRecord>;
    if (typeof parsed.identity !== "string" || typeof parsed.firstOpenAt !== "string") return null;
    if (Number.isNaN(new Date(parsed.firstOpenAt).getTime())) return null;
    return { identity: parsed.identity, firstOpenAt: parsed.firstOpenAt };
  } catch {
    return null;
  }
}

// Called on every successful "open". Writes the cutoff only the first time
// this identity ever connects and never overwrites it afterwards. The
// identity is the raw linked-device JID (sock.user.id, device suffix
// included): re-pairing (after deleting .wa-auth) yields a new device id,
// whose own fresh history replay must again be ignored, so a new identity
// gets a new cutoff. Sync fs on purpose: the cutoff must be in place before
// any messages.upsert batch is looked at.
function establishFirstBootCutoff(identity: string): number {
  const existing = readFirstBootRecord();
  if (existing && existing.identity === identity) return new Date(existing.firstOpenAt).getTime();

  const now = Date.now();
  const record: FirstBootRecord = { identity, firstOpenAt: new Date(now).toISOString() };
  const file = firstBootFilePath();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  renameSync(tmp, file);
  console.log("[whatsapp] recorded first-boot cutoff for this linked device:", record.firstOpenAt);
  return now;
}

function currentCutoffMs(): number | null {
  if (state.firstBootCutoffMs !== null) return state.firstBootCutoffMs;
  const record = readFirstBootRecord();
  return record ? new Date(record.firstOpenAt).getTime() : null;
}

function messageTimestampMs(msg: WAMessage): number | null {
  if (msg.messageTimestamp === null || msg.messageTimestamp === undefined) return null;
  const seconds = toNumber(msg.messageTimestamp);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

// Which messages of a batch are genuinely new input.
//
// Baileys reports type "append" for (a) history replay after pairing,
// (b) messages delivered while the socket was offline (messages-recv.js:
// `node.attrs.offline ? 'append' : 'notify'`) and (c) the bot's own sends
// (messages-send.js, emitOwnEvents). Its event buffer also merges buffered
// upserts and labels the whole flushed batch with the FIRST message's type
// (Utils/event-buffer.js), so a "notify" batch can carry replayed history
// and an "append" batch can carry live messages. The type alone is
// therefore not trusted: every message is judged by its own timestamp
// against the first-boot cutoff, whatever the batch type. (c) is handled
// by the self-sent checks, and anything replayed after the cutoff that was
// already handled is stopped by the router's ProcessedMessage ledger.
function selectNewMessages(messages: WAMessage[], type: string): WAMessage[] {
  if (type !== "notify" && type !== "append") return [];
  const cutoffMs = currentCutoffMs();

  const selected = messages.filter((msg) => {
    const ts = messageTimestampMs(msg);
    // Before any cutoff exists (never connected yet) or without a
    // timestamp, only a live "notify" can be trusted as new.
    if (cutoffMs === null || ts === null) return type === "notify";
    return ts > cutoffMs;
  });

  const skipped = messages.length - selected.length;
  if (skipped > 0) {
    console.log(`[whatsapp] ignored ${skipped} message(s) from before the first-boot cutoff (${type} batch)`);
  }
  // Offline batches are processed oldest-first, so e.g. a reminder and the
  // "sí" that answers it keep their real order.
  return selected.sort((a, b) => (messageTimestampMs(a) ?? 0) - (messageTimestampMs(b) ?? 0));
}

async function processUpsert(
  sock: WASocket,
  messages: WAMessage[],
  type: string,
  onMessage: IncomingMessageHandler
): Promise<void> {
  // sock.user.id carries a multi-device suffix (e.g. "...:19@s.whatsapp.net")
  // that never raw-equals a chat's remoteJid (e.g. "...@s.whatsapp.net") —
  // jidNormalizedUser strips it so the self-chat comparison actually matches.
  const rawOwnJid = sock.user?.id;
  if (!rawOwnJid) return;
  const ownJid = jidNormalizedUser(rawOwnJid);
  // sock.user.lid is this device's LID identity (also device-suffixed,
  // also needing jidNormalizedUser) once WhatsApp has handed one out —
  // absent on an account LID hasn't reached yet. See isSelfChatMessage's
  // comment: a self-chat message's remoteJid can legitimately be either
  // form, so both are accepted here, not just the phone-number one.
  const rawOwnLid = sock.user?.lid;
  const ownJids = rawOwnLid ? [ownJid, jidNormalizedUser(rawOwnLid)] : [ownJid];

  for (const msg of selectNewMessages(messages, type)) {
    // A single bad message (onMessage throwing, a malformed payload) must
    // never crash the process or stop the rest of the batch.
    try {
      // WAMessage's key.remoteJid can be `string | null | undefined`;
      // isSelfChatMessage treats null/undefined as never matching.
      if (!isSelfChatMessage(msg as { key: { remoteJid?: string | null; fromMe?: boolean } }, ownJids))
        continue;
      const waMessageId = msg.key.id;
      if (!waMessageId) continue;

      // Our own echo of something sendSelfMessage sent — not input from
      // the user — regardless of whether Baileys reported it as "notify" or
      // "append". Consumed on first sight; a second echo of the same id (or
      // one after a restart) is stopped by the durable "self_sent" row in
      // ProcessedMessage, which the router checks before anything else.
      if (state.selfSentIds.delete(waMessageId)) continue;

      const text = extractText(msg.message);
      if (text) {
        await onMessage(text, waMessageId, "text", undefined);
        continue;
      }

      if (msg.message?.audioMessage) {
        let audioBuffer: Buffer | undefined;
        try {
          audioBuffer = (await downloadMediaMessage(
            msg,
            "buffer",
            {},
            { logger: sock.logger, reuploadRequest: sock.updateMediaMessage }
          )) as Buffer;
        } catch (err) {
          // A failed download must not lose the voice note — it's
          // still handed over (without a buffer), and the router persists a
          // no_identificado placeholder Note for it.
          console.error("[whatsapp] could not download an audio message, passing it on without audio", err);
        }
        await onMessage(null, waMessageId, "audio", audioBuffer);
        continue;
      }

      if (msg.message?.imageMessage) {
        let imageBuffer: Buffer | undefined;
        try {
          imageBuffer = (await downloadMediaMessage(
            msg,
            "buffer",
            {},
            { logger: sock.logger, reuploadRequest: sock.updateMediaMessage }
          )) as Buffer;
        } catch (err) {
          // A failed download must not lose the receipt photo — it's
          // still handed over (without a buffer); the router persists a
          // no_identificado placeholder Note for it (a placeholder;
          // the real handling replaces it).
          console.error("[whatsapp] could not download an image message, passing it on without image", err);
        }
        await onMessage(null, waMessageId, "image", imageBuffer);
      }
    } catch (err) {
      console.error("[whatsapp] failed to process an incoming message, skipping it", err);
    }
  }
}

export async function startWhatsAppConnection(
  onMessage: IncomingMessageHandler,
  scheduleReconnect: ScheduleReconnectFn = defaultScheduleReconnect,
  reconnectAttempt = 0
): Promise<void> {
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_STATE_DIR);

  const sock = makeWASocket({ auth: authState });
  state.socket = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // One-time pairing: print the QR payload to the server console/log.
      // You scan it with WhatsApp (Linked devices) to pair.
      console.log("[whatsapp] Scan this QR code with WhatsApp to pair:");
      console.log(qr);
      state.lastQr = qr;
    }

    if (connection === "open") {
      console.log("[whatsapp] connection open, own JID:", sock.user?.id ?? "(unknown)");
      state.connection = "open";
      // Ya vinculado: el QR dejó de servir y no debe seguir mostrándose.
      state.lastQr = null;
      // Reset backoff on a healthy connection so a later disconnect starts
      // counting from the first retry delay again, not wherever this
      // (possibly long-lived) connection last left off.
      reconnectAttempt = 0;

      if (sock.user?.id) {
        try {
          state.firstBootCutoffMs = establishFirstBootCutoff(sock.user.id);
        } catch (err) {
          console.error("[whatsapp] could not persist the first-boot cutoff", err);
        }
      }

      // Prompt any reminder stranded in "queued" while disconnected
      // (e.g. created from the webapp with nothing else pending). Through
      // the same queue as messages, so it never overlaps a reply being
      // handled. Dynamic import: reminders.ts itself imports this module.
      void enqueue(async () => {
        const { resumeReminderQueue } = await import("./reminders");
        await resumeReminderQueue();
      });
    }

    if (connection === "close") {
      state.connection = "close";
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        console.error(
          "[whatsapp] session logged out from the phone — delete .wa-auth and restart to re-pair with a new QR code."
        );
        return;
      }

      const delayMs = Math.min(
        INITIAL_RECONNECT_DELAY_MS * 2 ** reconnectAttempt,
        MAX_RECONNECT_DELAY_MS
      );
      console.warn(
        `[whatsapp] connection closed (status ${statusCode ?? "unknown"}), reconnecting in ${delayMs}ms`
      );
      scheduleReconnect(delayMs, () => {
        startWhatsAppConnection(onMessage, scheduleReconnect, reconnectAttempt + 1).catch((err) =>
          console.error("[whatsapp] reconnect attempt failed", err)
        );
      });
    }
  });

  // Returns the queued promise only so tests can await a batch; Baileys
  // ignores it. Serialized: see ConnectionState.queue.
  sock.ev.on("messages.upsert", ({ messages, type }) =>
    enqueue(() => processUpsert(sock, messages, type, onMessage))
  );
}

// Unlike processUpsert, this only needs *one* valid destination JID for the
// self chat, not every form WhatsApp might use to address an incoming
// message — sending to the phone-number form keeps working regardless of
// whether WhatsApp later reports the echo's remoteJid as that same form or
// as the LID form (isSelfChatMessage above accepts both, so the echo is
// still recognized either way).
export async function sendSelfMessage(text: string): Promise<void> {
  const sock = state.socket;
  if (!sock) {
    throw new Error("sendSelfMessage called before startWhatsAppConnection established a socket");
  }
  const rawOwnJid = sock.user?.id;
  if (!rawOwnJid) {
    throw new Error("sendSelfMessage called before the socket has an own JID (not yet connected)");
  }
  const ownJid = jidNormalizedUser(rawOwnJid);

  // Generate and record the message ID *before* sending — the echo can
  // arrive before sendMessage resolves. Recorded twice: in memory (fast
  // path, checked right here in processUpsert) and durably as a
  // ProcessedMessage "self_sent" row, so an echo redelivered later — e.g.
  // in an "append" batch after a restart, when the in-memory set is empty
  // — is still never treated as your input.
  const messageId = generateMessageIDV2(ownJid);
  rememberSelfSent(messageId);
  try {
    await db.processedMessage.create({ data: { whatsappMessageId: messageId, outcome: "self_sent" } });
  } catch (err) {
    console.error("[whatsapp] could not record a self-sent message id durably", err);
  }
  try {
    await sock.sendMessage(ownJid, { text }, { messageId });
  } catch (err) {
    state.selfSentIds.delete(messageId);
    throw err;
  }
}
