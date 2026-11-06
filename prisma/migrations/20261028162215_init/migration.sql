-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rawText" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "whatsappMessageId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "noteId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "category" TEXT,
    "occurredAt" DATETIME NOT NULL,
    CONSTRAINT "Expense_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Reminder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "noteId" TEXT NOT NULL,
    "parsedDatetime" DATETIME,
    "status" TEXT NOT NULL,
    "calendarEventId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Reminder_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Note_whatsappMessageId_key" ON "Note"("whatsappMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "Expense_noteId_key" ON "Expense"("noteId");

-- CreateIndex
CREATE UNIQUE INDEX "Reminder_noteId_key" ON "Reminder"("noteId");
