# Operations Under Pressure

A small internal operations workspace for teams to create, assign, prioritize, and resolve work items. The frontend is React + Vite; the API is Express; PostgreSQL and Prisma store application data. Authentication is a seeded-demo email/password login with signed bearer tokens—there is no public sign-up.

**Challenge materials:** no official challenge brief or university advisory file was present in the workspace. This implementation follows the requirements supplied in the project request.

## Requirements and implementation checklist

- [x] React/Vite client, Express REST API, PostgreSQL/Prisma schema, demo seed, and Docker Compose database definition.
- [x] Hashed demo passwords (configurable with `DEMO_PASSWORD`), signed expiring JWTs, database-backed team membership/role checks, and resource-level team access checks.
- [x] Work item types, priorities, explicit workflow, comments, append-only activity events, filtering, search, sorting, and database pagination.
- [x] Conditional atomic claim; optimistic version checks return `409`; approval requires a team Lead or Admin.
- [x] Audited field changes and actor attribution; edit and approval activity writes share a transaction with their work-item update.
- [x] Client dashboard with queue filters, server-derived metrics, details/timeline/comments, role-aware mutation controls, conflict reconciliation, claim/assignment, and create/edit forms.
- [x] Mocked API tests for authentication, team access, approval authorization, invalid transitions, stale versions, and competing claim requests.
- [x] Opt-in PostgreSQL-backed integration tests for cross-team access, role enforcement, workflow, comments, audit history, stale versions, and competing claims.
- [x] Setup and decision documentation.
- [ ] Verify the browser workflow end to end. The automated API tests do not replace a manual browser walkthrough.

## Prerequisites

- Node.js 20.19 or later and npm.
- PostgreSQL 14+ **or** Docker Desktop with Compose.
- A 32-character-or-longer JWT signing secret.

## Local setup

Commands below are run from the repository root in PowerShell or a compatible shell.

1. Install JavaScript dependencies:

   ```sh
   npm install
   ```

2. Start PostgreSQL. With Docker Desktop installed:

   ```sh
   docker compose up -d postgres
   ```

   By default this creates a local database called `operations_under_pressure`, user `ops_user`, and password `change_me`. These fallback credentials are for local demos only and must not be used in a deployed environment. Docker Compose lets you override them using `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` from a root `.env` file or the shell environment. For an existing PostgreSQL server, create a database/user and set `DATABASE_URL` to that connection instead.

3. Copy `.env.example` to `server/.env`, then set its `DATABASE_URL` to match your PostgreSQL credentials. With the default local Compose settings, use `postgresql://ops_user:change_me@localhost:5432/operations_under_pressure?schema=public`. Replace `JWT_SECRET` with a random value of at least 32 characters and replace the `DEMO_PASSWORD` placeholder with your chosen local demo password. The root `.env` (if used to override Compose settings) and `server/.env` are separate local files; make their database settings agree. From PowerShell:

   ```sh
   Copy-Item .env.example server/.env
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

   Copy the printed random value into `JWT_SECRET` in `server/.env`. The server and Prisma commands load `server/.env`; do not commit it. For custom Compose credentials, copy `.env.example` to the repository-root `.env` as well, then set `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` there. Do not use the demo defaults outside a local development database.

4. Generate Prisma's client, apply the checked-in migration, and create demo data:

   ```sh
   npm run db:generate
   npm run db:migrate
   npm run db:seed
   ```

5. Start both applications in separate processes (or use the combined script):

   ```sh
   npm run dev
   ```

   The API is at `http://localhost:4000`; Vite is at `http://localhost:5173`. Set `CLIENT_ORIGIN` in `server/.env` if the UI is served from another origin. `VITE_API_URL` may be set in a client `.env` if the API is not at `http://localhost:4000/api`.

## Demo accounts

All seeded accounts use the same demo-only password. It is read from `DEMO_PASSWORD` in `server/.env`; the local fallback, when that variable is not set, is **`OpsDemo2026!`**. Seed data stores a bcrypt hash, not the plaintext value. Set a different local demo password if preferred; the login form asks for it rather than pre-filling a password.

| Email | Team | Role |
|---|---|---|
| `admin@newtonite.demo` | Service Operations | Admin |
| `lead@newtonite.demo` | Service Operations | Lead |
| `member@newtonite.demo` | Service Operations | Member |
| `viewer@newtonite.demo` | Service Operations | Viewer |
| `risklead@newtonite.demo` | Risk & Payments | Lead |

These are deliberately public demo credentials, not production identities. Replace the seed credentials and use a proper identity provider before using real data.

## Workflow and permissions

Allowed transitions are:

| Current status | Allowed next status |
|---|---|
| Open | In Progress |
| In Progress | Awaiting Approval, Resolved |
| Awaiting Approval | In Progress, Resolved |
| Resolved | Closed, In Progress |
| Closed | None |

Only a Lead or Admin of the item's team can approve `Awaiting Approval → Resolved`. Viewers can read items in their teams and cannot create, edit, assign, claim, comment, or transition them. Members, Leads, and Admins can work on items in their teams. The API looks up the user's account and team membership; it does not accept a client-supplied role or actor identity.

### Critical behavior notes

- **Concurrent claims:** the API uses an `UPDATE ... WHERE assigneeId IS NULL` via Prisma `updateMany` inside a transaction. PostgreSQL serializes competing row updates and rechecks the predicate, so only one claim can succeed. Only that successful transaction writes the assignment activity.
- **Stale edits:** editable work-item fields carry the version seen by the client. The write matches both the item ID and version and increments the version atomically. If a different request updated it first, the match count is zero and the API returns `409 STALE_VERSION`.
- **Audit history:** changed work-item fields create actor-attributed activity records in the same transaction as the versioned update. If activity persistence fails, the item update rolls back. Descriptions are recorded as changed without copying their potentially long contents into the activity log.
- **Workflow/authorization:** every item route checks team membership; edit/assignment actions check the membership role; transition edges and approval permissions are validated server-side.
- **Retry behavior:** competing claim retries return a conflict and never add a second assignment activity. Versioned writes reject repeats with a conflict. Item creation and comment POSTs accept an `Idempotency-Key` header; a repeated key with the same authenticated actor, operation, and payload replays the original response, while a different payload returns `409 IDEMPOTENCY_KEY_REUSED`. The key and response are stored in PostgreSQL in the same transaction as the mutation, so concurrent duplicate requests create only one item/comment. The UI reuses a key when retrying an unchanged submission in the same page session and creates a new key when its payload changes. Requests without the header retain the legacy non-idempotent behavior.
- **Client conflict handling:** a stale edit closes the outdated form, reloads the latest item, and asks the user to review it before editing again. The client also refreshes after stale assignment or workflow requests. Viewer controls are hidden in the UI, with API role checks remaining authoritative.

## REST API overview

All routes are prefixed with `/api`; protected routes require `Authorization: Bearer <token>`.

| Method and path | Purpose |
|---|---|
| `GET /health` | Liveness probe |
| `POST /auth/login` | Exchange demo email/password for an eight-hour token |
| `GET /auth/me` | Current user and team memberships |
| `GET /teams`, `GET /members` | Teams and members visible to the current user |
| `GET /items` | Search/filter/sort/page items; accepts `q`, `status`, `priority`, `type`, `teamId`, `assigneeId`, `scope`, `page`, `pageSize`, `sortBy`, and `order` |
| `POST /items` | Create an item in a team where the actor can create work; supports the `Idempotency-Key` header |
| `GET /items/:id` | Item detail, activity timeline, and comments (team members only) |
| `PATCH /items/:id` | Edit supported fields using `{ "version": 1, ... }` |
| `PATCH /items/:id/status` | Transition using `{ "version": 1, "status": "IN_PROGRESS" }` |
| `PATCH /items/:id/assignment` | Assign or unassign using `{ "version": 1, "assigneeId": "..." }` |
| `POST /items/:id/claim` | Atomically claim an unassigned item for the current user |
| `POST /items/:id/comments` | Add `{ "body": "..." }`; supports the `Idempotency-Key` header |

`POST /items` also supports the optional `Idempotency-Key` header. Keys are scoped to the authenticated user and endpoint (including the item for comment requests). Keep the same key for retries of the same request; use a new key for a new logical operation. Reusing a key with a different validated payload returns `409 IDEMPOTENCY_KEY_REUSED`.

Responses use JSON. Validation errors are `400`, unauthenticated requests `401`, forbidden actions `403`, missing resources `404`, stale writes/claim conflicts `409`, and unexpected server errors `500` without database details in the response.

## Verification

```sh
npm run db:generate
npm test
npm run build
```

The regular backend route tests use a Prisma-shaped test double. Their concurrent-claim case is a mocked simulation and **does not verify PostgreSQL concurrency**. The separate `server/test/postgres.integration.test.js` suite uses two simultaneous HTTP requests against a real PostgreSQL database, and is skipped unless `TEST_DATABASE_URL` is set. Use a disposable, migrated database for this suite. Example PowerShell commands, after PostgreSQL is available:

```powershell
$env:TEST_DATABASE_URL = "postgresql://<test-user>:<test-password>@<test-host>:5432/operations_under_pressure_test?schema=public"
$previousDatabaseUrl = $env:DATABASE_URL
Push-Location server
$env:DATABASE_URL = $env:TEST_DATABASE_URL
npx prisma migrate deploy
if ($null -eq $previousDatabaseUrl) { Remove-Item Env:DATABASE_URL } else { $env:DATABASE_URL = $previousDatabaseUrl }
Pop-Location
npm run test --workspace=server
npm run test --workspace=client
npm run build
Remove-Item Env:TEST_DATABASE_URL
```

The integration suite uses only `TEST_DATABASE_URL`, creates uniquely named users, teams, memberships, and items, then deletes records by the UUIDs created by that run. It does not truncate, reset, seed, or drop a database. The suite is skipped if `TEST_DATABASE_URL` is unset. If it is set, the suite checks before connecting that at least one development URL is configured, every configured `DATABASE_URL` and `DEVELOPMENT_DATABASE_URL` is valid, and the test URL matches neither development URL after normalizing loopback aliases, default PostgreSQL ports, and database names; otherwise it fails closed. Still use only a dedicated disposable database; do not point it at a production database. It tests authorization across teams and roles, workflow transitions, stale writes, and simultaneous PostgreSQL claims.

### Manual browser checklist

The application browser workflow has not been automated. The project owner reports manual browser checks succeeded for creating and editing work items, claiming and assigning them, starting work, recording activity, and adding comments. This review did not repeat those browser checks; it also has no reported manual result for approval or stale-conflict flows. To verify the remaining paths locally:

1. Start PostgreSQL and the application using the local setup above, then sign in as `member@newtonite.demo` with the configured `DEMO_PASSWORD`.
2. Create a work item and confirm it appears in the queue; open it, claim it, add a comment, and confirm the comment and actor appear in the item detail.
3. Move it from Open to In Progress, then request approval. Sign in as `lead@newtonite.demo` and approve the item from Awaiting Approval to Resolved.
4. Sign in as `viewer@newtonite.demo`; confirm create, edit, assignment, claim, comment, and workflow controls are absent. Verify that attempts to call protected mutations through the API return `403`.
5. Open the same item in two sessions. Save an edit in the first session, then submit a stale edit in the second; confirm it is rejected and the latest detail is loaded.
6. Open one unassigned item in two member sessions and claim at nearly the same time; verify only one succeeds and the other receives a conflict.

### Verification status for this workspace

Checked on 17 October 2026:

- `npm run db:generate` and `npx prisma validate`: passed.
- `npm run test --workspace=server -- test/postgres.integration.test.js`: **12 passed, 0 skipped, 0 failed** against the isolated PostgreSQL test database, including retry, payload-mismatch, and concurrent duplicate-request cases for item and comment creation.
- `npm test`: server **48 passed, 0 skipped, 0 failed** (including all 12 PostgreSQL integration tests); client **8 passed, 0 skipped, 0 failed**.
- `npm run build`: passed.
- `npx prisma migrate deploy` applied the committed `20261016000000_init` and `20261017000000_idempotency_records` migrations only to the isolated PostgreSQL 16 test database at `127.0.0.1:55432/operations_under_pressure_test`, on its own Docker volume. The container is stopped and its volume retained.
- Integration-test cleanup left zero test users, teams, work items, activities, comments, and idempotency records. The full test run used the isolated test database; development database coordinates were verified distinct and no development database writes were made.
- No seed, reset, truncate, database drop, existing-volume removal, or development-database migration was run.
- Manual browser checks reported by the project owner: create/edit/claim/assign/start-work/activity/comments succeeded. This review did not independently repeat them.

The test service was created for this verification only. The disposable integration database is separate from the development endpoint and database; the safety guard compares normalized host, default port, and database name before integration tests run.

## Known limitations

- No production identity provider, password reset, self-registration, or persistent server-side session revocation.
- No user-facing team administration or team-creation screen; seed data defines the demo teams and membership roles.
- The `Idempotency-Key` header is optional for API callers; requests without it remain non-idempotent. The browser retains retry keys in memory for the current page session, so a retry after a page reload must reuse the original key explicitly. Idempotency response records are retained until the associated user is deleted; there is no expiry cleanup.
- Browser checks are manual, not automated; approval and stale-conflict browser behavior remain unconfirmed here. A PostgreSQL integration run requires a separately configured disposable test database.
- The documented seed-password fallback and Compose database credentials are local-demo defaults only. Override them through environment variables and never reuse them for a deployed or sensitive database.
