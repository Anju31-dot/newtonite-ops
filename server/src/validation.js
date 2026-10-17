import { z } from "zod";
import { HttpError } from "./errors.js";

const itemTypes = ["INCIDENT", "CUSTOMER_ISSUE", "PAYMENT_INVESTIGATION", "COMPLIANCE_REQUEST", "GENERAL_TASK"];
const priorities = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const statuses = ["OPEN", "IN_PROGRESS", "AWAITING_APPROVAL", "RESOLVED", "CLOSED"];

export const schemas = {
  login: z.object({ email: z.string().email().max(254), password: z.string().min(1).max(128) }),
  list: z.object({
    q: z.string().trim().max(150).optional(),
    status: z.enum(statuses).optional(),
    priority: z.enum(priorities).optional(),
    type: z.enum(itemTypes).optional(),
    teamId: z.string().min(1).max(64).optional(),
    assigneeId: z.string().min(1).max(64).optional(),
    scope: z.enum(["mine", "unassignedUrgent", "approval"]).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(10),
    sortBy: z.enum(["createdAt", "updatedAt", "dueDate", "priority"]).default("updatedAt"),
    order: z.enum(["asc", "desc"]).default("desc")
  }),
  create: z.object({
    title: z.string().trim().min(3).max(160),
    description: z.string().trim().min(1).max(5000),
    type: z.enum(itemTypes),
    priority: z.enum(priorities).default("MEDIUM"),
    teamId: z.string().min(1).max(64),
    assigneeId: z.string().min(1).max(64).nullable().optional(),
    dueDate: z.string().datetime().nullable().optional()
  }),
  update: z.object({
    version: z.number().int().min(1),
    title: z.string().trim().min(3).max(160).optional(),
    description: z.string().trim().min(1).max(5000).optional(),
    type: z.enum(itemTypes).optional(),
    priority: z.enum(priorities).optional(),
    dueDate: z.string().datetime().nullable().optional()
  }).refine((body) => Object.keys(body).some((key) => key !== "version"), "Provide at least one field to update."),
  status: z.object({ version: z.number().int().min(1), status: z.enum(statuses) }),
  assignment: z.object({ version: z.number().int().min(1), assigneeId: z.string().min(1).max(64).nullable() }),
  itemId: z.object({ id: z.string().min(1).max(64) }),
  comment: z.object({ body: z.string().trim().min(1).max(2000) })
};

export function validate(schema, source = "body") {
  return (request, _response, next) => {
    const result = schema.safeParse(request[source]);
    if (!result.success) {
      return next(new HttpError(400, result.error.issues.map((issue) => `${issue.path.join(".") || source}: ${issue.message}`).join("; "), "VALIDATION_ERROR"));
    }
    request.validated ??= {};
    request.validated[source] = result.data;
    next();
  };
}
