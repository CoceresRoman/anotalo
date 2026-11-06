import { PrismaClient } from "@prisma/client";

// Standard Next.js + Prisma singleton pattern: cache the client on
// `globalThis` so dev-mode hot-reloading doesn't spawn a new PrismaClient
// (and a new SQLite connection pool) on every module reload.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const db = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}

export default db;
