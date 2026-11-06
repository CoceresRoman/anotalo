import { expect, test } from "vitest";
import db from "./db";

test("can create and read a Note", async () => {
  const note = await db.note.create({
    data: { rawText: "test", source: "text", type: "idea", whatsappMessageId: "wa1" },
  });
  const found = await db.note.findUnique({ where: { id: note.id } });
  expect(found?.rawText).toBe("test");
});
