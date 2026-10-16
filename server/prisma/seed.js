import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const passwordHash = await bcrypt.hash(process.env.DEMO_PASSWORD || "OpsDemo2026!", 12);

async function main() {
  const [ops, risk] = await Promise.all([
    prisma.team.upsert({ where: { name: "Service Operations" }, update: {}, create: { name: "Service Operations" } }),
    prisma.team.upsert({ where: { name: "Risk & Payments" }, update: {}, create: { name: "Risk & Payments" } })
  ]);
  const people = [
    { email: "admin@newtonite.demo", name: "Alex Morgan", team: ops, role: "ADMIN" },
    { email: "lead@newtonite.demo", name: "Jordan Lee", team: ops, role: "LEAD" },
    { email: "member@newtonite.demo", name: "Sam Patel", team: ops, role: "MEMBER" },
    { email: "viewer@newtonite.demo", name: "Taylor Kim", team: ops, role: "VIEWER" },
    { email: "risklead@newtonite.demo", name: "Casey Rivera", team: risk, role: "LEAD" }
  ];
  const users = {};
  for (const person of people) {
    users[person.email] = await prisma.user.upsert({
      where: { email: person.email },
      update: { name: person.name, passwordHash },
      create: { email: person.email, name: person.name, passwordHash }
    });
    await prisma.membership.upsert({
      where: { userId_teamId: { userId: users[person.email].id, teamId: person.team.id } },
      update: { role: person.role },
      create: { userId: users[person.email].id, teamId: person.team.id, role: person.role }
    });
  }

  const demos = [
    { title: "Checkout latency spike in EU region", description: "P95 latency rose above the 2s SLO after the latest deployment.", type: "INCIDENT", priority: "URGENT", status: "IN_PROGRESS", teamId: ops.id, assigneeId: users["member@newtonite.demo"].id },
    { title: "Refund request awaiting evidence", description: "Customer reports a duplicate card charge; reconcile processor records.", type: "CUSTOMER_ISSUE", priority: "HIGH", status: "OPEN", teamId: ops.id, assigneeId: null },
    { title: "Review disputed settlement batch", description: "Compare settlement batch 2026-10-15 with the ledger before approval.", type: "PAYMENT_INVESTIGATION", priority: "HIGH", status: "AWAITING_APPROVAL", teamId: risk.id, assigneeId: users["risklead@newtonite.demo"].id },
    { title: "Quarterly access review evidence", description: "Collect team membership evidence for the quarterly compliance review.", type: "COMPLIANCE_REQUEST", priority: "MEDIUM", status: "OPEN", teamId: risk.id, assigneeId: null },
    { title: "Refresh escalation runbook", description: "Update on-call contacts and incident handoff guidance.", type: "GENERAL_TASK", priority: "LOW", status: "RESOLVED", teamId: ops.id, assigneeId: users["lead@newtonite.demo"].id }
  ];
  for (const [index, demo] of demos.entries()) {
    const found = await prisma.workItem.findFirst({ where: { title: demo.title } });
    if (found) continue;
    const item = await prisma.workItem.create({
      data: {
        ...demo,
        creatorId: users["admin@newtonite.demo"].id,
        dueDate: new Date(Date.now() + (index + 1) * 86_400_000)
      }
    });
    await prisma.activity.create({
      data: { itemId: item.id, actorId: users["admin@newtonite.demo"].id, action: "created", details: { status: item.status } }
    });
  }
}

main()
  .catch((error) => {
    console.error("Seed failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
