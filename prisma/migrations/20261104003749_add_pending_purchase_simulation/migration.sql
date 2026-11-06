-- CreateTable
CREATE TABLE "PendingPurchaseSimulation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationText" TEXT NOT NULL,
    "missingField" TEXT NOT NULL,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
