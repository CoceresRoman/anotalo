-- CreateTable
CREATE TABLE "Saving" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "noteId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ARS',
    "occurredAt" DATETIME NOT NULL,
    CONSTRAINT "Saving_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Saving_noteId_key" ON "Saving"("noteId");
