import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import pg from "pg";
import { createApp } from "../src/app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
// This signing key is only for local integration requests and is not an application credential.
const signingSecret = "postgres-integration-test-secret-change-me";

integration("PostgreSQL-backed API integration tests", () => {
  let pool;
  let prisma;
  let app;
  let team;
  let otherTeam;
  let member;
  let secondMember;
  let viewer;
  let lead;
  let outsider;
  let openItem;
  let approvalItem;
  let staleItem;

  function tokenFor(userId) {
    return jwt.sign({ sub: userId }, signingSecret, { algorithm: "HS256", expiresIn: "5m" });
  }

  function authorized(userId) {
    return { Authorization: `Bearer ${tokenFor(userId)}` };
  }

  beforeAll(async () => {
    process.env.JWT_SECRET = signingSecret;
    pool = new pg.Pool({ connectionString: databaseUrl });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    await prisma.$connect();

    const suffix = randomUUID();
    [team, otherTeam] = await Promise.all([
      prisma.team.create({ data: { name: `Integration Ops ${suffix}` } }),
      prisma.team.create({ data: { name: `Integration Other ${suffix}` } })
    ]);
    [member, secondMember, viewer, lead, outsider] = await Promise.all([
      prisma.user.create({ data: { email: `member-${suffix}@example.test`, name: "Member One", passwordHash: "unused" } }),
      prisma.user.create({ data: { email: `member-two-${suffix}@example.test`, name: "Member Two", passwordHash: "unused" } }),
      prisma.user.create({ data: { email: `viewer-${suffix}@example.test`, name: "Read Only", passwordHash: "unused" } }),
      prisma.user.create({ data: { email: `lead-${suffix}@example.test`, name: "Team Lead", passwordHash: "unused" } }),
      prisma.user.create({ data: { email: `outsider-${suffix}@example.test`, name: "Other Team", passwordHash: "unused" } })
    ]);

    await prisma.membership.createMany({
      data: [
        { userId: member.id, teamId: team.id, role: "MEMBER" },
        { userId: secondMember.id, teamId: team.id, role: "MEMBER" },
        { userId: viewer.id, teamId: team.id, role: "VIEWER" },
        { userId: lead.id, teamId: team.id, role: "LEAD" },
        { userId: outsider.id, teamId: otherTeam.id, role: "ADMIN" }
      ]
    });
    [openItem, approvalItem, staleItem] = await Promise.all([
      prisma.workItem.create({
        data: { title: `Open ${suffix}`, description: "Integration test item", type: "GENERAL_TASK", teamId: team.id, creatorId: lead.id }
      }),
      prisma.workItem.create({
        data: { title: `Approval ${suffix}`, description: "Integration approval item", type: "INCIDENT", status: "AWAITING_APPROVAL", teamId: team.id, creatorId: lead.id }
      }),
      prisma.workItem.create({
        data: { title: `Stale ${suffix}`, description: "Integration stale item", type: "GENERAL_TASK", teamId: team.id, creatorId: lead.id, version: 2 }
      })
    ]);
    app = createApp(prisma);
  }, 30000);

  afterAll(async () => {
    if (!prisma) return;
    const teamIds = [team?.id, otherTeam?.id].filter(Boolean);
    await prisma.workItem.deleteMany({ where: { teamId: { in: teamIds } } });
    await prisma.team.deleteMany({ where: { id: { in: teamIds } } });
    await prisma.user.deleteMany({
      where: { id: { in: [member?.id, secondMember?.id, viewer?.id, lead?.id, outsider?.id].filter(Boolean) } }
    });
    await prisma.$disconnect();
    await pool.end();
  }, 30000);

  it("denies cross-team reads and mutations without changing the foreign item", async () => {
    const getResult = await request(app).get(`/api/items/${openItem.id}`).set(authorized(outsider.id));
    const claimResult = await request(app).post(`/api/items/${openItem.id}/claim`).set(authorized(outsider.id));
    const assignResult = await request(app).patch(`/api/items/${openItem.id}/assignment`)
      .set(authorized(member.id)).send({ version: 1, assigneeId: outsider.id });
    const commentResult = await request(app).post(`/api/items/${openItem.id}/comments`)
      .set(authorized(outsider.id)).send({ body: "Should not be stored." });

    expect(getResult.status).toBe(403);
    expect(claimResult.status).toBe(403);
    expect(assignResult.status).toBe(403);
    expect(commentResult.status).toBe(403);
    expect(await prisma.workItem.findUnique({ where: { id: openItem.id } })).toMatchObject({ assigneeId: null, version: 1 });
    expect(await prisma.comment.count({ where: { itemId: openItem.id } })).toBe(0);
  });

  it("rejects Viewer mutations while allowing the Viewer to read their team item", async () => {
    const readResult = await request(app).get(`/api/items/${openItem.id}`).set(authorized(viewer.id));
    const editResult = await request(app).patch(`/api/items/${openItem.id}`)
      .set(authorized(viewer.id)).send({ version: 1, title: "Forbidden edit" });
    const assignResult = await request(app).patch(`/api/items/${openItem.id}/assignment`)
      .set(authorized(viewer.id)).send({ version: 1, assigneeId: viewer.id });
    const claimResult = await request(app).post(`/api/items/${openItem.id}/claim`).set(authorized(viewer.id));
    const commentResult = await request(app).post(`/api/items/${openItem.id}/comments`)
      .set(authorized(viewer.id)).send({ body: "Forbidden comment" });
    const transitionResult = await request(app).patch(`/api/items/${openItem.id}/status`)
      .set(authorized(viewer.id)).send({ version: 1, status: "IN_PROGRESS" });

    expect(readResult.status).toBe(200);
    expect([editResult.status, assignResult.status, claimResult.status, commentResult.status, transitionResult.status])
      .toEqual([403, 403, 403, 403, 403]);
    expect(await prisma.workItem.findUnique({ where: { id: openItem.id } })).toMatchObject({ assigneeId: null, status: "OPEN", version: 1 });
    expect(await prisma.comment.count({ where: { itemId: openItem.id } })).toBe(0);
  });

  it("rejects invalid transitions and allows only a Lead to approve an awaiting item", async () => {
    const invalid = await request(app).patch(`/api/items/${openItem.id}/status`)
      .set(authorized(member.id)).send({ version: 1, status: "CLOSED" });
    const forbiddenApproval = await request(app).patch(`/api/items/${approvalItem.id}/status`)
      .set(authorized(member.id)).send({ version: 1, status: "RESOLVED" });
    const approved = await request(app).patch(`/api/items/${approvalItem.id}/status`)
      .set(authorized(lead.id)).send({ version: 1, status: "RESOLVED" });

    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("INVALID_TRANSITION");
    expect(forbiddenApproval.status).toBe(403);
    expect(approved.status).toBe(200);
    expect(await prisma.workItem.findUnique({ where: { id: approvalItem.id } })).toMatchObject({ status: "RESOLVED", version: 2 });
    expect(await prisma.activity.count({
      where: { itemId: approvalItem.id, actorId: lead.id, action: "status_changed" }
    })).toBe(1);
  });

  it("returns 409 for a stale version without writing an activity", async () => {
    const result = await request(app).patch(`/api/items/${staleItem.id}`)
      .set(authorized(member.id)).send({ version: 1, title: "Outdated title" });

    expect(result.status).toBe(409);
    expect(result.body.code).toBe("STALE_VERSION");
    expect(await prisma.workItem.findUnique({ where: { id: staleItem.id } })).toMatchObject({ title: staleItem.title, version: 2 });
    expect(await prisma.activity.count({ where: { itemId: staleItem.id } })).toBe(0);
  });

  it("lets exactly one of two concurrent PostgreSQL claims succeed and records one activity", async () => {
    const results = await Promise.all([
      request(app).post(`/api/items/${openItem.id}/claim`).set(authorized(member.id)),
      request(app).post(`/api/items/${openItem.id}/claim`).set(authorized(secondMember.id))
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual([200, 409]);
    const storedItem = await prisma.workItem.findUnique({ where: { id: openItem.id } });
    expect([member.id, secondMember.id]).toContain(storedItem.assigneeId);
    expect(storedItem.version).toBe(2);
    expect(await prisma.activity.count({ where: { itemId: openItem.id, action: "assigned" } })).toBe(1);
  });
});
