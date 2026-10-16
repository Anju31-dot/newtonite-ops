import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { createApp } from "../src/app.js";

const user = { id: "user-member", name: "Sam Member", email: "member@newtonite.demo" };
const secondUser = { id: "user-member-2", name: "Riley Member", email: "riley@newtonite.demo" };
const item = {
  id: "item-1",
  title: "Unassigned incident",
  description: "A sample incident",
  type: "INCIDENT",
  priority: "URGENT",
  status: "OPEN",
  teamId: "team-ops",
  assigneeId: null,
  creatorId: "user-lead",
  version: 1,
  team: { id: "team-ops", name: "Operations" },
  assignee: null,
  creator: { id: "user-lead", name: "Jordan Lead" }
};
// This signing key and user password are test-only; they are never used by the application runtime.
const secret = "test-secret-that-is-long-enough-for-unit-tests";
const testPasswordHash = await bcrypt.hash("correct-password", 4);
process.env.JWT_SECRET = secret;

function makePrisma({ role = "MEMBER", member = true } = {}) {
  const state = { item: { ...item }, claimCount: 0 };
  const prisma = {
    state,
    user: {
      findUnique: vi.fn(async ({ where }) => {
        if (where.id === user.id) return user;
        if (where.id === secondUser.id) return secondUser;
        if (where.email === user.email) return { ...user, passwordHash: testPasswordHash };
        return null;
      })
    },
    membership: {
      findUnique: vi.fn(async ({ where }) => member ? { userId: where.userId, teamId: item.teamId, role } : null),
      findMany: vi.fn(async () => member ? [{ teamId: item.teamId, role }] : [])
    },
    workItem: {
      findUnique: vi.fn(async () => ({ ...state.item })),
      findMany: vi.fn(async ({ where }) => where.teamId?.in?.length === 0 ? [] : [state.item]),
      count: vi.fn(async ({ where }) => where.teamId?.in?.length === 0 ? 0 : 1),
      updateMany: vi.fn(async ({ where, data }) => {
        if (where.assigneeId === null) {
          if (state.item.assigneeId !== null || state.item.status === "CLOSED") return { count: 0 };
          state.claimCount += 1;
        } else if (where.version !== state.item.version) {
          return { count: 0 };
        }
        const { version, ...fields } = data;
        Object.assign(state.item, fields);
        if (version?.increment) state.item.version += version.increment;
        return { count: 1 };
      })
    },
    activity: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    comment: { create: vi.fn(async ({ data }) => ({ id: "comment-1", ...data })), findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (callback) => callback(prisma))
  };
  return prisma;
}

function tokenFor(id = user.id) {
  return jwt.sign({ sub: id }, secret);
}

describe("mocked API route tests — not PostgreSQL integration tests", () => {
  let prisma;
  let app;

  beforeEach(() => {
    prisma = makePrisma();
    app = createApp(prisma);
  });

  it("serves the liveness endpoint without requiring a database query", async () => {
    const response = await request(app).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("rejects requests without a valid authenticated account", async () => {
    const response = await request(app).get("/api/items/item-1");
    expect(response.status).toBe(401);
  });

  it("returns a client error for malformed JSON", async () => {
    const response = await request(app).post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send('{"email":');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_JSON");
  });

  it("validates filters and uses database pagination with stable sorting", async () => {
    const invalid = await request(app).get("/api/items?page=0")
      .set("Authorization", `Bearer ${tokenFor()}`);
    expect(invalid.status).toBe(400);
    expect(prisma.workItem.findMany).not.toHaveBeenCalled();

    const response = await request(app).get("/api/items?page=2&pageSize=5&sortBy=createdAt&order=asc")
      .set("Authorization", `Bearer ${tokenFor()}`);
    expect(response.status).toBe(200);
    expect(prisma.workItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 5,
      take: 5,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }]
    }));
  });

  it("passes search and supported filters to the database query", async () => {
    const response = await request(app).get(
      "/api/items?q=refund&status=OPEN&priority=URGENT&type=INCIDENT&teamId=team-ops&assigneeId=user-member"
    ).set("Authorization", `Bearer ${tokenFor()}`);

    expect(response.status).toBe(200);
    expect(prisma.workItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        teamId: { equals: "team-ops" },
        status: "OPEN",
        priority: "URGENT",
        type: "INCIDENT",
        assigneeId: "user-member",
        OR: [
          { title: { contains: "refund", mode: "insensitive" } },
          { description: { contains: "refund", mode: "insensitive" } }
        ]
      }
    }));
  });

  it("rejects a bearer token signed with a different secret", async () => {
    const forged = jwt.sign({ sub: user.id }, "attacker-controlled-secret-that-is-long-enough");
    const response = await request(app).get("/api/items/item-1").set("Authorization", `Bearer ${forged}`);
    expect(response.status).toBe(401);
  });

  it("returns a sanitized server error when the database cannot load the authenticated user", async () => {
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    prisma.user.findUnique.mockRejectedValue(new Error("database connection details"));

    const response = await request(app).get("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor()}`);

    expect(response.status).toBe(500);
    expect(response.body.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(response.body)).not.toContain("database connection details");
    expect(logError).toHaveBeenCalledOnce();
  });

  it("does not trust a role claim in a valid JWT over the database membership", async () => {
    prisma.state.item.status = "AWAITING_APPROVAL";
    prisma.workItem.findUnique.mockImplementation(async () => ({ ...prisma.state.item }));
    const tokenWithForgedRole = jwt.sign({ sub: user.id, role: "ADMIN" }, secret);
    const response = await request(app).patch("/api/items/item-1/status")
      .set("Authorization", `Bearer ${tokenWithForgedRole}`)
      .send({ status: "RESOLVED", version: 1 });
    expect(response.status).toBe(403);
    expect(prisma.workItem.updateMany).not.toHaveBeenCalled();
  });

  it("authenticates a seeded user and returns a signed token", async () => {
    const response = await request(app).post("/api/auth/login")
      .send({ email: user.email, password: "correct-password" });
    expect(response.status).toBe(200);
    expect(response.body.user.id).toBe(user.id);
    expect(jwt.verify(response.body.token, secret).sub).toBe(user.id);
  });

  it("rejects incorrect credentials without issuing a token", async () => {
    const response = await request(app).post("/api/auth/login")
      .send({ email: user.email, password: "wrong-password" });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("INVALID_CREDENTIALS");
  });

  it("denies a user who is not a member of the item's team", async () => {
    prisma = makePrisma({ member: false });
    app = createApp(prisma);
    const response = await request(app).get("/api/items/item-1").set("Authorization", `Bearer ${tokenFor()}`);
    expect(response.status).toBe(403);
    const updateResponse = await request(app).patch("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor()}`)
      .send({ version: 1, title: "Unauthorized edit" });
    expect(updateResponse.status).toBe(403);
    expect(prisma.workItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.activity.findMany).not.toHaveBeenCalled();
  });

  it("does not allow a Viewer to approve an item awaiting approval", async () => {
    prisma = makePrisma({ role: "VIEWER" });
    prisma.state.item.status = "AWAITING_APPROVAL";
    prisma.workItem.findUnique.mockImplementation(async () => ({ ...prisma.state.item }));
    app = createApp(prisma);
    const response = await request(app).patch("/api/items/item-1/status")
      .set("Authorization", `Bearer ${tokenFor()}`)
      .send({ status: "RESOLVED", version: 1 });
    expect(response.status).toBe(403);
    expect(prisma.workItem.updateMany).not.toHaveBeenCalled();
  });

  it("allows a team Lead to approve an item awaiting approval", async () => {
    prisma = makePrisma({ role: "LEAD" });
    prisma.state.item.status = "AWAITING_APPROVAL";
    prisma.workItem.findUnique.mockImplementation(async () => ({ ...prisma.state.item }));
    app = createApp(prisma);
    const response = await request(app).patch("/api/items/item-1/status")
      .set("Authorization", `Bearer ${tokenFor()}`)
      .send({ status: "RESOLVED", version: 1 });
    expect(response.status).toBe(200);
    expect(response.body.item.status).toBe("RESOLVED");
    expect(prisma.activity.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "status_changed" })
    }));
  });

  it("rejects invalid workflow transitions on the server", async () => {
    const response = await request(app).patch("/api/items/item-1/status")
      .set("Authorization", `Bearer ${tokenFor()}`)
      .send({ status: "CLOSED", version: 1 });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_TRANSITION");
  });

  it("limits the approval queue to teams where the current user is a Lead or Admin", async () => {
    const response = await request(app).get("/api/items?scope=approval")
      .set("Authorization", `Bearer ${tokenFor()}`);
    expect(response.status).toBe(200);
    expect(response.body.items).toEqual([]);
  });

  it("does not allow a Viewer to add comments", async () => {
    prisma = makePrisma({ role: "VIEWER" });
    app = createApp(prisma);
    const response = await request(app).post("/api/items/item-1/comments")
      .set("Authorization", `Bearer ${tokenFor()}`)
      .send({ body: "I should not be able to add this." });
    expect(response.status).toBe(403);
    expect(prisma.comment.create).not.toHaveBeenCalled();
  });

  it("creates a comment for the authenticated actor on an accessible item", async () => {
    const response = await request(app).post("/api/items/item-1/comments")
      .set("Authorization", `Bearer ${tokenFor()}`)
      .send({ body: "I have started investigating." });

    expect(response.status).toBe(201);
    expect(prisma.comment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: { itemId: "item-1", authorId: user.id, body: "I have started investigating." }
    }));
  });

  it("returns item activity and comments in chronological order", async () => {
    const activity = { id: "activity-1", action: "priority_changed" };
    const comment = { id: "comment-1", body: "Investigation started." };
    prisma.activity.findMany.mockResolvedValue([activity]);
    prisma.comment.findMany.mockResolvedValue([comment]);

    const response = await request(app).get("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor()}`);

    expect(response.status).toBe(200);
    expect(response.body.activities).toEqual([activity]);
    expect(response.body.comments).toEqual([comment]);
    expect(prisma.activity.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { itemId: "item-1" },
      orderBy: { createdAt: "asc" }
    }));
    expect(prisma.comment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { itemId: "item-1" },
      orderBy: { createdAt: "asc" }
    }));
  });

  it("blocks Viewer create, edit, assignment, claim, and status actions", async () => {
    prisma = makePrisma({ role: "VIEWER" });
    app = createApp(prisma);
    const auth = `Bearer ${tokenFor()}`;
    const responses = await Promise.all([
      request(app).post("/api/items").set("Authorization", auth)
        .send({ title: "New task", description: "Details", type: "GENERAL_TASK", teamId: "team-ops" }),
      request(app).patch("/api/items/item-1").set("Authorization", auth)
        .send({ title: "Changed", version: 1 }),
      request(app).patch("/api/items/item-1/assignment").set("Authorization", auth)
        .send({ assigneeId: user.id, version: 1 }),
      request(app).post("/api/items/item-1/claim").set("Authorization", auth),
      request(app).patch("/api/items/item-1/status").set("Authorization", auth)
        .send({ status: "IN_PROGRESS", version: 1 })
    ]);
    expect(responses.map(({ status }) => status)).toEqual([403, 403, 403, 403, 403]);
    expect(prisma.workItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.activity.create).not.toHaveBeenCalled();
  });

  it("returns 409 when an edit uses a stale version", async () => {
    prisma.state.item.version = 2;
    prisma.workItem.findUnique.mockImplementation(async () => ({ ...prisma.state.item }));
    const response = await request(app).patch("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor()}`)
      .send({ title: "Updated incident", version: 1 });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("STALE_VERSION");
  });

  it("returns 409 for a stale status update before validating the old workflow state", async () => {
    prisma.state.item.status = "IN_PROGRESS";
    prisma.state.item.version = 2;
    prisma.workItem.findUnique.mockImplementation(async () => ({ ...prisma.state.item }));

    const response = await request(app).patch("/api/items/item-1/status")
      .set("Authorization", `Bearer ${tokenFor()}`)
      .send({ status: "CLOSED", version: 1 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("STALE_VERSION");
    expect(prisma.workItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.activity.create).not.toHaveBeenCalled();
  });

  it("records a priority change in the same transaction as the versioned update", async () => {
    const response = await request(app).patch("/api/items/item-1")
      .set("Authorization", `Bearer ${tokenFor()}`)
      .send({ priority: "HIGH", version: 1 });

    expect(response.status).toBe(200);
    expect(response.body.item.priority).toBe("HIGH");
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(prisma.activity.create).toHaveBeenCalledWith({
      data: {
        itemId: "item-1",
        actorId: user.id,
        action: "priority_changed",
        details: { from: "URGENT", to: "HIGH" }
      }
    });
  });

  it("records assignment activity with the actor and new assignee", async () => {
    const response = await request(app).patch("/api/items/item-1/assignment")
      .set("Authorization", `Bearer ${tokenFor()}`)
      .send({ assigneeId: secondUser.id, version: 1 });

    expect(response.status).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(prisma.activity.create).toHaveBeenCalledWith({
      data: {
        itemId: "item-1",
        actorId: user.id,
        action: "assigned",
        details: { from: null, to: secondUser.name }
      }
    });
  });

  it("simulates two concurrent claim requests with a mocked database", async () => {
    const results = await Promise.all([
      request(app).post("/api/items/item-1/claim").set("Authorization", `Bearer ${tokenFor()}`),
      request(app).post("/api/items/item-1/claim").set("Authorization", `Bearer ${tokenFor(secondUser.id)}`)
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(prisma.state.claimCount).toBe(1);
    expect([user.id, secondUser.id]).toContain(prisma.state.item.assigneeId);
    expect(prisma.activity.create).toHaveBeenCalledTimes(1);
  });
});
