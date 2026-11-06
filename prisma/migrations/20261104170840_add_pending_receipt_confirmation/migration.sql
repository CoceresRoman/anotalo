-- CreateTable
CREATE TABLE "PendingReceiptConfirmation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "amountCents" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "occurredAt" DATETIME NOT NULL,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
