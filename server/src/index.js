import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import pg from "pg";
import { createApp } from "./app.js";
import { getJwtSecret } from "./auth.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const port = Number(process.env.PORT || 4000);

try {
  getJwtSecret();
  await prisma.$connect();
  const server = createApp(prisma).listen(port, () => {
    console.info(`Operations API listening on http://localhost:${port}`);
  });
  const shutdown = async () => {
    server.close(async () => {
      await prisma.$disconnect();
      await pool.end();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (error) {
  console.error("API startup failed:", error.message);
  await prisma.$disconnect();
  await pool.end();
  process.exit(1);
}
