import { beforeEach, expect, test, vi } from "vitest";

import * as en from "./en";
import * as es from "./es";
import * as pt from "./pt";

const prompts = { es, en, pt } as const;

const SOME_NOW_ISO = "2026-11-02T13:00:00.000Z";

test.each(["es", "en", "pt"] as const)(
  "buildSystemPrompt for %s mentions every classification key",
  (locale) => {
    const prompt = prompts[locale].buildSystemPrompt(SOME_NOW_ISO, "America/Argentina/Buenos_Aires", "-03:00");
    for (const key of ["intent", "noteType", "amountCents", "category", "currency", "parsedDatetime", "isSalary"]) {
      expect(prompt).toContain(key);
    }
  }
);

// Only the Groq class itself is replaced, same pattern as classify.test.ts.
const { mockCreate } = vi.hoisted(() => {
  return { mockCreate: vi.fn() };
});

vi.mock("groq-sdk", async () => {
  const actual = await vi.importActual<typeof import("groq-sdk")>("groq-sdk");
  class FakeGroq {
    chat = {
      completions: {
        create: mockCreate,
      },
    };
  }
  return {
    ...actual,
    default: FakeGroq,
  };
});

vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return {
    ...actual,
    config: { ...actual.config, locale: "en" },
  };
});

import { config } from "../../config";
import { classifyMessage } from "../classify";

beforeEach(() => {
  mockCreate.mockReset();
});

test("classifyMessage uses the configured locale's prompt (config.locale = 'en')", async () => {
  mockCreate.mockResolvedValueOnce({
    choices: [{ message: { content: JSON.stringify({ intent: "capture", noteType: "idea" }) } }],
  });

  const nowIso = "2026-10-28T10:00:00Z";
  await classifyMessage("something", nowIso);

  const params = mockCreate.mock.calls[0]![0];
  const systemMessage = params.messages.find((m: { role: string }) => m.role === "system");
  expect(systemMessage.content).toBe(en.buildSystemPrompt(nowIso, config.timezone, config.utcOffset));
});
