-- CreateTable
CREATE TABLE "ProcessedMessage" (
    "whatsappMessageId" TEXT NOT NULL PRIMARY KEY,
    "outcome" TEXT,
    "processedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Expense" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "noteId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "category" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'ARS',
    "occurredAt" DATETIME NOT NULL,
    CONSTRAINT "Expense_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Expense" ("amountCents", "category", "id", "noteId", "occurredAt") SELECT "amountCents", "category", "id", "noteId", "occurredAt" FROM "Expense";
DROP TABLE "Expense";
ALTER TABLE "new_Expense" RENAME TO "Expense";
CREATE UNIQUE INDEX "Expense_noteId_key" ON "Expense"("noteId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
