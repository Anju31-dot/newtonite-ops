# Operations Under Pressure

A small internal operations workspace for teams to create, assign, prioritize, and resolve work items. The frontend is React + Vite; the API is Express; PostgreSQL and Prisma store application data. Authentication is a seeded-demo email/password login with signed bearer tokens—there is no public sign-up.

**Challenge materials:** no official challenge brief or university advisory file was present in the workspace. This implementation follows the requirements supplied in the project request.

## Requirements and implementation checklist

- [x] React/Vite client, Express REST API, PostgreSQL/Prisma schema, demo seed, and Docker Compose database definition.
- [x] Hashed demo passwords (configurable with `DEMO_PASSWORD`), signed expiring JWTs, database-backed team membership/role checks, and resource-level team access checks.
- [x] Work item types, priorities, explicit workflow, comments, append-only activity events, filtering, search, sorting, and database pagination.
- [x] Conditional atomic claim; optimistic version checks return `409`; approval requires a team Lead or Admin.
- [x] Client dashboard with queue filters, server-derived metrics, details/timeline/comments, claim/assignment, status controls, and create/edit forms.
- [x] Mocked API tests for authentication, team access, approval authorization, invalid transitions, stale versions, and competing claim requests.
- [x] Opt-in PostgreSQL-backed integration tests for cross-team access, role enforcement, workflow, stale versions, and competing claims.
- [x] Setup and decision documentation.
- [ ] Run against a live PostgreSQL database, execute migrations/seed, and verify the browser workflow end to end. This environment has Node.js 24/npm 11, but does not have Docker/Compose or `psql`; install/start PostgreSQL (or install Docker Desktop) to complete these checks.

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
- **Workflow/authorization:** every item route checks team membership; edit/assignment actions check the membership role; transition edges and approval permissions are validated server-side.
- **Retry behavior:** competing claim retries return a conflict and never add a second assignment activity. Comments intentionally create a new comment for every accepted POST; clients should not automatically retry comment submissions.

## REST API overview

All routes are prefixed with `/api`; protected routes require `Authorization: Bearer <token>`.

| Method and path | Purpose |
|---|---|
| `GET /health` | Liveness probe |
| `POST /auth/login` | Exchange demo email/password for an eight-hour token |
| `GET /auth/me` | Current user and team memberships |
| `GET /teams`, `GET /members` | Teams and members visible to the current user |
| `GET /items` | Search/filter/sort/page items; accepts `q`, `status`, `priority`, `type`, `teamId`, `assigneeId`, `scope`, `page`, `pageSize`, `sortBy`, and `order` |
| `POST /items` | Create an item in a team where the actor can create work |
| `GET /items/:id` | Item detail, activity timeline, and comments (team members only) |
| `PATCH /items/:id` | Edit supported fields using `{ "version": 1, ... }` |
| `PATCH /items/:id/status` | Transition using `{ "version": 1, "status": "IN_PROGRESS" }` |
| `PATCH /items/:id/assignment` | Assign or unassign using `{ "version": 1, "assigneeId": "..." }` |
| `POST /items/:id/claim` | Atomically claim an unassigned item for the current user |
| `POST /items/:id/comments` | Add `{ "body": "..." }` |

Responses use JSON. Validation errors are `400`, unauthenticated requests `401`, forbidden actions `403`, missing resources `404`, stale writes/claim conflicts `409`, and unexpected server errors `500` without database details in the response.

## Verification

```sh
npm run db:generate
npm test
npm run build
```

The regular backend route tests use a Prisma-shaped test double. Their concurrent-claim case is a mocked simulation and **does not verify PostgreSQL concurrency**. The separate `server/test/postgres.integration.test.js` suite uses two simultaneous HTTP requests against a real PostgreSQL database, and is skipped unless `TEST_DATABASE_URL` is set. Use a disposable, migrated database for this suite. Example PowerShell commands, after PostgreSQL is available:

```powershell
$env:DATABASE_URL = "postgresql://ops_user:change_me@localhost:5432/operations_under_pressure_test?schema=public"
npm run db:generate
npm run db:migrate
$env:TEST_DATABASE_URL = $env:DATABASE_URL
npm run test --workspace=server
npm run test --workspace=client
npm run build
```

The integration suite creates uniquely named users, teams, memberships, and items, then removes those records. Do not point it at a production database. It tests authorization across teams and roles, workflow transitions, stale writes, and simultaneous PostgreSQL claims. The browser workflow still requires manually starting `npm run dev` and signing in through a browser; it is not an automated browser test.

### Verification status for this workspace

Checked on 16 October 2026:

- `npm test`: server mocked route tests **16 passed**; PostgreSQL integration tests **5 skipped** because `TEST_DATABASE_URL` is unavailable; client tests **2 passed**.
- `npm run build`: passed.
- `npm run db:generate`: passed.
- `npx prisma validate`: passed.
- `npm audit --audit-level=moderate`: zero reported vulnerabilities.
- PostgreSQL migration/seed, live API workflow, PostgreSQL race behavior, and browser end-to-end behavior: **not run**. Docker and PostgreSQL are unavailable in the checked workspace.

## Known limitations

- No production identity provider, password reset, self-registration, or persistent server-side session revocation.
- No user-facing team administration or team-creation screen; seed data defines the demo teams and membership roles.
- No comment idempotency key; a deliberate/retried comment POST creates another comment.
- At the latest environment check, Docker/Compose and PostgreSQL client/server tools were not found, and `127.0.0.1:5432` did not accept a connection. No migration, seed, PostgreSQL integration test, real database concurrency, or browser end-to-end run has been performed.
- The documented seed-password fallback and Compose database credentials are local-demo defaults only. Override them through environment variables and never reuse them for a deployed or sensitive database.
