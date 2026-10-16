import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { createAuth } from "./auth.js";
import { errorHandler, HttpError } from "./errors.js";
import { validate, schemas } from "./validation.js";
import { createWorkItemRouter } from "./work-items.js";

export function createApp(prisma) {
  const app = express();
  const auth = createAuth(prisma);
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:5173" }));
  app.use(express.json({ limit: "32kb" }));
  app.get("/api/health", (_request, response) => response.json({ status: "ok" }));
  app.post("/api/auth/login", rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    handler: (_request, response) => response.status(429).json({
      error: "Too many sign-in attempts. Try again later.",
      code: "RATE_LIMITED"
    })
  }), validate(schemas.login), auth.login);
  app.get("/api/auth/me", auth.authenticate, async (request, response) => {
    const memberships = await prisma.membership.findMany({
      where: { userId: request.user.id },
      include: { team: { select: { id: true, name: true } } }
    });
    response.json({ user: { ...request.user, memberships } });
  });
  app.get("/api/teams", auth.authenticate, async (request, response) => {
    const memberships = await prisma.membership.findMany({
      where: { userId: request.user.id },
      include: { team: { select: { id: true, name: true } } }
    });
    response.json({ teams: memberships.map(({ team, role }) => ({ ...team, role })) });
  });
  app.get("/api/members", auth.authenticate, async (request, response) => {
    const memberships = await prisma.membership.findMany({
      where: { teamId: { in: (await prisma.membership.findMany({
        where: { userId: request.user.id },
        select: { teamId: true }
      })).map(({ teamId }) => teamId) } },
      include: {
        user: { select: { id: true, name: true } },
        team: { select: { id: true, name: true } }
      }
    });
    response.json({ members: memberships.map(({ user: member, team, role }) => ({ ...member, teamId: team.id, teamName: team.name, role })) });
  });
  app.use("/api/items", auth.authenticate, createWorkItemRouter(prisma));
  app.use((_request, _response, next) => next(new HttpError(404, "Endpoint not found.", "NOT_FOUND")));
  app.use(errorHandler);
  return app;
}
