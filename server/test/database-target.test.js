import { describe, expect, it } from "vitest";
import { assertSeparateTestDatabase } from "../src/database-target.js";

describe("integration database target safety", () => {
  it("recognizes loopback host aliases as the same database target", () => {
    expect(() => assertSeparateTestDatabase(
      "postgresql://localhost:5432/ops_test?schema=public",
      "postgresql://[::1]/ops_test?schema=private"
    )).toThrow(/separate from the development database/);
  });

  it("recognizes default PostgreSQL ports and rejects matching targets", () => {
    expect(() => assertSeparateTestDatabase(
      "postgresql://127.0.0.1/operations_under_pressure",
      "postgresql://localhost:5432/operations_under_pressure"
    )).toThrow(/separate from the development database/);
  });

  it("allows a different disposable database target", () => {
    expect(() => assertSeparateTestDatabase(
      "postgresql://localhost:55432/operations_under_pressure_test",
      "postgresql://127.0.0.1:5432/operations_under_pressure",
      "postgresql://localhost:5432/operations_development"
    )).not.toThrow();
  });

  it("rejects a test target matching DATABASE_URL even when DEVELOPMENT_DATABASE_URL differs", () => {
    expect(() => assertSeparateTestDatabase(
      "postgresql://localhost:5432/operations_under_pressure",
      "postgresql://127.0.0.1:5432/operations_under_pressure",
      "postgresql://localhost:5432/operations_development"
    )).toThrow(/separate from the development database/);
  });

  it("rejects a test target matching DEVELOPMENT_DATABASE_URL", () => {
    expect(() => assertSeparateTestDatabase(
      "postgresql://localhost:5432/operations_development",
      "postgresql://127.0.0.1:5432/operations_under_pressure",
      "postgresql://localhost:5432/operations_development"
    )).toThrow(/separate from the development database/);
  });

  it("fails closed when no development database URL is configured", () => {
    expect(() => assertSeparateTestDatabase(
      "postgresql://localhost:55432/operations_under_pressure_test"
    )).toThrow(/At least one development database URL is required/);
  });

  it("fails closed when a configured development database URL is malformed", () => {
    expect(() => assertSeparateTestDatabase(
      "postgresql://localhost:55432/operations_under_pressure_test",
      "not-a-postgresql-url"
    )).toThrow(/valid PostgreSQL connection URLs/);
  });
});
