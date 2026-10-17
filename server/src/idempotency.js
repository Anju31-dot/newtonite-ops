import { createHash } from "node:crypto";
import { HttpError } from "./errors.js";

function requestHash(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function validateKey(key) {
  if (key === undefined) return null;
  if (!/^[\x21-\x7e]{1,128}$/.test(key)) {
    throw new HttpError(400, "Idempotency-Key must be 1 to 128 printable ASCII characters.", "VALIDATION_ERROR");
  }
  return key;
}

function replay(record, hash) {
  if (record.requestHash !== hash) {
    throw new HttpError(409, "This idempotency key was already used with a different request.", "IDEMPOTENCY_KEY_REUSED");
  }
  if (record.response === null) {
    throw new Error("A committed idempotency record is missing its response.");
  }
  return record.response;
}

export async function runIdempotently(prisma, { actorId, scope, key, payload }, operation) {
  const idempotencyKey = validateKey(key);
  if (idempotencyKey === null) return prisma.$transaction(operation);

  const hash = requestHash(payload);
  const where = {
    actorId_scope_idempotencyKey: { actorId, scope, idempotencyKey }
  };

  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.idempotencyRecord.findUnique({ where });
      if (existing) return replay(existing, hash);

      await tx.idempotencyRecord.create({
        data: { actorId, scope, idempotencyKey, requestHash: hash }
      });
      const response = await operation(tx);
      await tx.idempotencyRecord.update({
        where,
        data: { response: JSON.parse(JSON.stringify(response)) }
      });
      return response;
    });
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    const existing = await prisma.idempotencyRecord.findUnique({ where });
    if (!existing) throw error;
    return replay(existing, hash);
  }
}
