import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { HttpError } from "./errors.js";

export function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error("JWT_SECRET must contain at least 32 characters.");
  return secret;
}

export function createAuth(prisma) {
  async function login(request, response, next) {
    try {
      const { email, password } = request.validated.body;
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        throw new HttpError(401, "Email or password is incorrect.", "INVALID_CREDENTIALS");
      }
      const token = jwt.sign({ sub: user.id }, getJwtSecret(), { expiresIn: "8h" });
      const memberships = await prisma.membership.findMany({
        where: { userId: user.id },
        include: { team: { select: { id: true, name: true } } }
      });
      response.json({ token, user: { id: user.id, name: user.name, email: user.email, memberships } });
    } catch (error) {
      next(error);
    }
  }

  async function authenticate(request, _response, next) {
    try {
      const value = request.get("authorization");
      if (!value?.startsWith("Bearer ")) throw new HttpError(401, "Sign in to continue.", "UNAUTHENTICATED");
      const payload = jwt.verify(value.slice(7), getJwtSecret(), { algorithms: ["HS256"] });
      if (typeof payload === "string" || typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new HttpError(401, "Your session is invalid or expired.", "UNAUTHENTICATED");
      }
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, name: true, email: true }
      });
      if (!user) throw new HttpError(401, "Your account is no longer available.", "UNAUTHENTICATED");
      request.user = user;
      next();
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(401, "Your session is invalid or expired.", "UNAUTHENTICATED"));
    }
  }

  return { login, authenticate };
}
