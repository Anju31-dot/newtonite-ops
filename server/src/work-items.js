import { Router } from "express";
import { HttpError } from "./errors.js";
import { runIdempotently } from "./idempotency.js";
import { schemas, validate } from "./validation.js";

const includeDetails = {
  team: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true, email: true } },
  creator: { select: { id: true, name: true } },
  _count: { select: { comments: true } }
};
const editableRoles = ["MEMBER", "LEAD", "ADMIN"];
const transitions = {
  OPEN: ["IN_PROGRESS"],
  IN_PROGRESS: ["AWAITING_APPROVAL", "RESOLVED"],
  AWAITING_APPROVAL: ["IN_PROGRESS", "RESOLVED"],
  RESOLVED: ["CLOSED", "IN_PROGRESS"],
  CLOSED: []
};

export function createWorkItemRouter(prisma) {
  const router = Router();

  async function membership(userId, teamId) {
    const record = await prisma.membership.findUnique({
      where: { userId_teamId: { userId, teamId } }
    });
    if (!record) throw new HttpError(403, "You are not a member of this team.", "FORBIDDEN");
    return record;
  }

  async function getAccessibleItem(userId, itemId) {
    const item = await prisma.workItem.findUnique({ where: { id: itemId }, include: includeDetails });
    if (!item) throw new HttpError(404, "Work item not found.", "NOT_FOUND");
    await membership(userId, item.teamId);
    return item;
  }

  router.get("/", validate(schemas.list, "query"), async (request, response) => {
    const filters = request.validated.query;
    const memberships = await prisma.membership.findMany({
      where: { userId: request.user.id },
      select: { teamId: true, role: true }
    });
    const teamIds = memberships.map(({ teamId }) => teamId);
    const approvalTeamIds = memberships
      .filter(({ role }) => ["LEAD", "ADMIN"].includes(role))
      .map(({ teamId }) => teamId);
    if (filters.teamId && !teamIds.includes(filters.teamId)) {
      throw new HttpError(403, "You are not a member of this team.", "FORBIDDEN");
    }
    if (filters.scope === "approval" && filters.teamId && !approvalTeamIds.includes(filters.teamId)) {
      throw new HttpError(403, "You cannot approve work items for this team.", "FORBIDDEN");
    }
    const visibleTeamIds = filters.scope === "approval" ? approvalTeamIds : teamIds;
    const where = { teamId: filters.teamId ? { equals: filters.teamId } : { in: visibleTeamIds } };
    if (filters.status) where.status = filters.status;
    if (filters.priority) where.priority = filters.priority;
    if (filters.type) where.type = filters.type;
    if (filters.assigneeId) where.assigneeId = filters.assigneeId;
    if (filters.scope === "mine") where.assigneeId = request.user.id;
    if (filters.scope === "unassignedUrgent") {
      where.assigneeId = null;
      where.priority = "URGENT";
    }
    if (filters.scope === "approval") where.status = "AWAITING_APPROVAL";
    if (filters.q) {
      where.OR = [
        { title: { contains: filters.q, mode: "insensitive" } },
        { description: { contains: filters.q, mode: "insensitive" } }
      ];
    }
    const [items, total, open, urgent, inProgress, awaitingApproval] = await Promise.all([
      prisma.workItem.findMany({
        where,
        include: includeDetails,
        orderBy: [{ [filters.sortBy]: filters.order }, { id: "asc" }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize
      }),
      prisma.workItem.count({ where }),
      prisma.workItem.count({ where: { teamId: { in: teamIds }, status: { not: "CLOSED" } } }),
      prisma.workItem.count({ where: { teamId: { in: teamIds }, status: { not: "CLOSED" }, priority: "URGENT" } }),
      prisma.workItem.count({ where: { teamId: { in: teamIds }, status: "IN_PROGRESS" } }),
      prisma.workItem.count({ where: { teamId: { in: teamIds }, status: "AWAITING_APPROVAL" } })
    ]);
    response.json({
      items,
      metrics: { open, urgent, inProgress, awaitingApproval },
      pagination: { page: filters.page, pageSize: filters.pageSize, total, totalPages: Math.ceil(total / filters.pageSize) }
    });
  });

  router.post("/", validate(schemas.create), async (request, response) => {
    const data = request.validated.body;
    const teamMembership = await membership(request.user.id, data.teamId);
    if (!editableRoles.includes(teamMembership.role)) throw new HttpError(403, "Your team role cannot create work items.", "FORBIDDEN");
    if (data.assigneeId) {
      await membership(data.assigneeId, data.teamId);
    }
    const item = await runIdempotently(prisma, {
      actorId: request.user.id,
      scope: "POST /items",
      key: request.get("Idempotency-Key"),
      payload: data
    }, async (tx) => {
      const created = await tx.workItem.create({
        data: {
          ...data,
          dueDate: data.dueDate ? new Date(data.dueDate) : null,
          creatorId: request.user.id
        },
        include: includeDetails
      });
      await tx.activity.create({
        data: { itemId: created.id, actorId: request.user.id, action: "created", details: { status: created.status, priority: created.priority } }
      });
      if (created.assigneeId) {
        const assignee = await tx.user.findUnique({ where: { id: created.assigneeId }, select: { name: true } });
        await tx.activity.create({
          data: { itemId: created.id, actorId: request.user.id, action: "assigned", details: { from: null, to: assignee.name } }
        });
      }
      return created;
    });
    response.status(201).json({ item });
  });

  router.get("/:id", validate(schemas.itemId, "params"), async (request, response) => {
    const item = await getAccessibleItem(request.user.id, request.params.id);
    const [activities, comments] = await Promise.all([
      prisma.activity.findMany({
        where: { itemId: item.id },
        include: { actor: { select: { id: true, name: true } } },
        orderBy: { createdAt: "asc" }
      }),
      prisma.comment.findMany({
        where: { itemId: item.id },
        include: { author: { select: { id: true, name: true } } },
        orderBy: { createdAt: "asc" }
      })
    ]);
    response.json({ item, activities, comments });
  });

  router.patch("/:id", validate(schemas.itemId, "params"), validate(schemas.update), async (request, response) => {
    const current = await getAccessibleItem(request.user.id, request.params.id);
    const teamMembership = await membership(request.user.id, current.teamId);
    if (!editableRoles.includes(teamMembership.role)) throw new HttpError(403, "Your team role cannot edit work items.", "FORBIDDEN");
    const { version, ...input } = request.validated.body;
    const data = { ...input, dueDate: input.dueDate === undefined ? undefined : input.dueDate ? new Date(input.dueDate) : null };
    const result = await prisma.$transaction(async (tx) => {
      const update = await tx.workItem.updateMany({
        where: { id: current.id, version },
        data: { ...data, version: { increment: 1 } }
      });
      if (update.count !== 1) throw new HttpError(409, "This item changed since you opened it. Reload and try again.", "STALE_VERSION");
      for (const [field, value] of Object.entries(data)) {
        if (value === undefined) continue;
        const previous = current[field] ?? null;
        const next = value instanceof Date ? value.toISOString() : value;
        const previousValue = previous instanceof Date ? previous.toISOString() : previous;
        if (next === previousValue) continue;
        await tx.activity.create({
          data: {
            itemId: current.id,
            actorId: request.user.id,
            action: `${field === "dueDate" ? "due_date" : field}_changed`,
            details: field === "description" ? { field } : { from: previousValue, to: next }
          }
        });
      }
      return tx.workItem.findUnique({ where: { id: current.id }, include: includeDetails });
    });
    response.json({ item: result });
  });

  router.patch("/:id/status", validate(schemas.itemId, "params"), validate(schemas.status), async (request, response) => {
    const current = await getAccessibleItem(request.user.id, request.params.id);
    const teamMembership = await membership(request.user.id, current.teamId);
    const { version, status } = request.validated.body;
    if (!editableRoles.includes(teamMembership.role)) throw new HttpError(403, "Your team role cannot change workflow status.", "FORBIDDEN");
    if (version !== current.version) throw new HttpError(409, "This item changed since you opened it. Reload and try again.", "STALE_VERSION");
    if (status === "RESOLVED" && current.status === "AWAITING_APPROVAL" && !["LEAD", "ADMIN"].includes(teamMembership.role)) {
      throw new HttpError(403, "Only a team Lead or Admin may approve this item.", "FORBIDDEN");
    }
    if (!transitions[current.status].includes(status)) {
      throw new HttpError(400, `Cannot move an item from ${current.status} to ${status}.`, "INVALID_TRANSITION");
    }
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.workItem.updateMany({
        where: { id: current.id, version },
        data: { status, version: { increment: 1 } }
      });
      if (result.count !== 1) throw new HttpError(409, "This item changed since you opened it. Reload and try again.", "STALE_VERSION");
      await tx.activity.create({
        data: { itemId: current.id, actorId: request.user.id, action: "status_changed", details: { from: current.status, to: status } }
      });
      return tx.workItem.findUnique({ where: { id: current.id }, include: includeDetails });
    });
    response.json({ item: updated });
  });

  router.patch("/:id/assignment", validate(schemas.itemId, "params"), validate(schemas.assignment), async (request, response) => {
    const current = await getAccessibleItem(request.user.id, request.params.id);
    const teamMembership = await membership(request.user.id, current.teamId);
    if (!editableRoles.includes(teamMembership.role)) throw new HttpError(403, "Your team role cannot assign work items.", "FORBIDDEN");
    const { version, assigneeId } = request.validated.body;
    if (assigneeId) await membership(assigneeId, current.teamId);
    const assigned = await prisma.$transaction(async (tx) => {
      const result = await tx.workItem.updateMany({
        where: { id: current.id, version },
        data: { assigneeId, version: { increment: 1 } }
      });
      if (result.count !== 1) throw new HttpError(409, "This item changed since you opened it. Reload and try again.", "STALE_VERSION");
      if (current.assigneeId !== assigneeId) {
        await tx.activity.create({
          data: {
            itemId: current.id,
            actorId: request.user.id,
            action: "assigned",
            details: {
              from: current.assignee?.name || null,
              to: assigneeId ? (await tx.user.findUnique({ where: { id: assigneeId }, select: { name: true } })).name : null
            }
          }
        });
      }
      return tx.workItem.findUnique({ where: { id: current.id }, include: includeDetails });
    });
    response.json({ item: assigned });
  });

  router.post("/:id/claim", validate(schemas.itemId, "params"), async (request, response) => {
    const current = await getAccessibleItem(request.user.id, request.params.id);
    const teamMembership = await membership(request.user.id, current.teamId);
    if (!editableRoles.includes(teamMembership.role)) throw new HttpError(403, "Your team role cannot claim work items.", "FORBIDDEN");
    const claimed = await prisma.$transaction(async (tx) => {
      const result = await tx.workItem.updateMany({
        where: { id: current.id, assigneeId: null, status: { not: "CLOSED" } },
        data: { assigneeId: request.user.id, version: { increment: 1 } }
      });
      if (result.count !== 1) throw new HttpError(409, "This item has already been claimed or is closed.", "CLAIM_CONFLICT");
      await tx.activity.create({
        data: { itemId: current.id, actorId: request.user.id, action: "assigned", details: { from: null, to: request.user.name } }
      });
      return tx.workItem.findUnique({ where: { id: current.id }, include: includeDetails });
    });
    response.json({ item: claimed });
  });

  router.post("/:id/comments", validate(schemas.itemId, "params"), validate(schemas.comment), async (request, response) => {
    const item = await getAccessibleItem(request.user.id, request.params.id);
    const teamMembership = await membership(request.user.id, item.teamId);
    if (!editableRoles.includes(teamMembership.role)) throw new HttpError(403, "Your team role cannot comment on work items.", "FORBIDDEN");
    const input = request.validated.body;
    const comment = await runIdempotently(prisma, {
      actorId: request.user.id,
      scope: `POST /items/${item.id}/comments`,
      key: request.get("Idempotency-Key"),
      payload: input
    }, (tx) => tx.comment.create({
      data: { itemId: item.id, authorId: request.user.id, body: input.body },
      include: { author: { select: { id: true, name: true } } }
    }));
    response.status(201).json({ comment });
  });

  return router;
}
