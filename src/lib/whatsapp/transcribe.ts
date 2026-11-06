import Groq, { toFile } from "groq-sdk";

/**
 * Transcribes a WhatsApp voice note with Groq's hosted Whisper model.
 *
 * Never throws: a failed or empty transcription becomes a `no_identificado`
 * note downstream, not a crash, so every error path here
 * resolves to `null` instead of propagating.
 */
export async function transcribeAudio(buffer: Buffer): Promise<string | null> {
  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const file = await toFile(buffer, "audio.ogg");

    const transcription = await groq.audio.transcriptions.create({
      file,
      model: "whisper-large-v3-turbo",
    });

    const text = transcription.text?.trim();
    return text ? text : null;
  } catch {
    return null;
  }
}
