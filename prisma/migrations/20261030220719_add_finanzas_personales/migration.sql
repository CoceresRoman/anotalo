-- CreateTable
CREATE TABLE "Income" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "noteId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "isSalary" BOOLEAN NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ARS',
    "occurredAt" DATETIME NOT NULL,
    CONSTRAINT "Income_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecurringGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "RecurringItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "totalInstallments" INTEGER,
    "startInstallment" INTEGER NOT NULL DEFAULT 1,
    "startYearMonth" TEXT NOT NULL,
    "groupId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecurringItem_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "RecurringGroup" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecurringPayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "yearMonth" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "paidAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecurringPayment_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "RecurringItem" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RecurringPayment_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PendingCuotaPayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidates" TEXT NOT NULL,
    "overrideAmountCents" INTEGER,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Income_noteId_key" ON "Income"("noteId");

-- CreateIndex
CREATE UNIQUE INDEX "RecurringPayment_itemId_yearMonth_key" ON "RecurringPayment"("itemId", "yearMonth");
