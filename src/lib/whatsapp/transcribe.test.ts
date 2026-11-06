import { beforeEach, expect, test, vi } from "vitest";

// Only the Groq class itself is replaced — toFile and everything else from
// the real groq-sdk package stay real, since converting a Buffer into an
// Uploadable has no network dependency and is worth exercising for real.
const { mockCreate } = vi.hoisted(() => {
  return { mockCreate: vi.fn() };
});

vi.mock("groq-sdk", async () => {
  const actual = await vi.importActual<typeof import("groq-sdk")>("groq-sdk");
  class FakeGroq {
    audio = {
      transcriptions: {
        create: mockCreate,
      },
    };
  }
  return {
    ...actual,
    default: FakeGroq,
  };
});

import { transcribeAudio } from "./transcribe";

function mockGroqAudioTranscriptionToThrow() {
  mockCreate.mockRejectedValueOnce(new Error("Groq API error"));
}

function mockGroqAudioTranscriptionToReturn(text: string) {
  mockCreate.mockResolvedValueOnce({ text });
}

beforeEach(() => {
  mockCreate.mockReset();
});

test("transcribeAudio returns null instead of throwing when the Groq call fails", async () => {
  mockGroqAudioTranscriptionToThrow();
  const result = await transcribeAudio(Buffer.from("not real audio"));
  expect(result).toBeNull();
});

test("transcribeAudio returns the transcribed text on success", async () => {
  mockGroqAudioTranscriptionToReturn("compré café, 3000 pesos");
  const result = await transcribeAudio(Buffer.from("fake audio bytes"));
  expect(result).toBe("compré café, 3000 pesos");
});

test("transcribeAudio returns null when the transcription is empty or whitespace-only", async () => {
  mockGroqAudioTranscriptionToReturn("   ");
  const result = await transcribeAudio(Buffer.from("fake audio bytes"));
  expect(result).toBeNull();
});

test("transcribeAudio sends the buffer and the whisper-large-v3-turbo model to Groq", async () => {
  mockGroqAudioTranscriptionToReturn("ok");
  await transcribeAudio(Buffer.from("fake audio bytes"));
  expect(mockCreate).toHaveBeenCalledTimes(1);
  const params = mockCreate.mock.calls[0]![0];
  expect(params.model).toBe("whisper-large-v3-turbo");
  expect(params.file).toBeDefined();
});
