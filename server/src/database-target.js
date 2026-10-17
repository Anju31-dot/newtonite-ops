function databaseTarget(connectionString) {
  if (!connectionString) {
    throw new Error("A PostgreSQL connection URL is required to verify integration database safety.");
  }
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("Database URLs must be valid PostgreSQL connection URLs.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("Database URLs must use the PostgreSQL protocol.");
  }
  const normalizedHostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const hostname = ["localhost", "127.0.0.1", "::1"].includes(normalizedHostname)
    ? "loopback"
    : normalizedHostname;
  return `${hostname}:${url.port || "5432"}/${decodeURIComponent(url.pathname.slice(1))}`;
}

export function assertSeparateTestDatabase(testUrl, ...developmentUrls) {
  const configuredDevelopmentUrls = developmentUrls.filter((url) => url !== undefined && url !== null);
  if (configuredDevelopmentUrls.length === 0) {
    throw new Error("At least one development database URL is required to verify integration database safety.");
  }

  const testTarget = databaseTarget(testUrl);
  if (configuredDevelopmentUrls.some((url) => testTarget === databaseTarget(url))) {
    throw new Error("PostgreSQL integration tests require TEST_DATABASE_URL to target a database separate from the development database.");
  }
}
