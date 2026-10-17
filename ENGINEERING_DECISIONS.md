# Engineering decisions

## 1. Keep the application as one Express API and one React client

- **Context:** The challenge needs a REST backend and a team dashboard, and the project should be easy for a student to explain.
- **Alternatives:** Split services, add a message broker, or introduce a full-stack framework.
- **Chosen approach:** A single Express process exposes the API and a Vite/React client consumes it. Backend concerns live in small modules for authentication, validation, errors, and work-item routes.
- **Trade-offs:** The deployment boundary is simple and the workflow is easy to trace; scaling API components independently is not a goal of this demo.

## 2. PostgreSQL + Prisma, with database-backed authorization

- **Context:** Work items need relational ownership, team membership, constraints, and safe multi-user updates.
- **Alternatives:** An in-memory store, a document database, or client-only role checks.
- **Chosen approach:** PostgreSQL models users, teams, composite-key memberships, work items, comments, and activity. Prisma supplies typed model access and migrations. JWT middleware verifies an HS256 signature, loads the current user from the database, and every protected item is checked against that user's current team membership and role.
- **Trade-offs:** A local PostgreSQL service is needed to run the complete application. The database remains the authority for item relationships; the browser never gets to choose the actor or role.

## 3. Password-hashed demo login and short-lived signed tokens

- **Context:** The application needs a straightforward login for seeded demo users without public account registration or committed secrets.
- **Alternatives:** Plaintext demo passwords, a hardcoded unsigned identity, or integrating an external identity provider.
- **Chosen approach:** Seed passwords are bcrypt hashes; the demo seed password can be set with `DEMO_PASSWORD` and has a documented local-only fallback. Successful login returns a signed eight-hour JWT containing only the user subject. The API verifies the signature and loads the user from PostgreSQL on protected requests. The signing secret comes from the environment.
- **Trade-offs:** This is sufficient for a local demo, but JWT revocation and enterprise identity lifecycle are not implemented. Docker Compose credentials also have local-only fallback values and can be overridden with environment variables. A production deployment should use an identity provider and managed secrets.

## 4. Explicit workflow transitions and team-scoped roles

- **Context:** A valid status change depends on the current status, and approval is a privileged action.
- **Alternatives:** Allow arbitrary status values, encode role rules in the UI, or use one global role per user.
- **Chosen approach:** The API owns a small explicit transition table. Roles belong to the user/team membership; item reads, writes, assignment, comments, and approval check the corresponding team membership in the backend. There is no API for changing team membership or administering users; team roles are provisioned by seed data/database operations.
- **Trade-offs:** Transitions are easy to inspect and test, but adding a workflow state requires updating the API, UI affordances, tests, and documentation.

## 5. Atomic claims and optimistic version checks

- **Context:** Two operators may claim one unassigned item, and users can edit details from stale browser views.
- **Alternatives:** Read-then-write assignment, last-write-wins edits, or extra queueing infrastructure.
- **Chosen approach:** Claim is a single conditional database update (`assigneeId IS NULL`) inside a transaction that also writes the activity entry. Edits match the submitted version and increment it atomically; zero matched rows returns `409 Conflict`. Mocked route tests cover these responses; a separate opt-in integration suite exercises real PostgreSQL behavior when `TEST_DATABASE_URL` points to a migrated disposable database.
- **Trade-offs:** PostgreSQL provides the serialization point with no additional service. Clients must handle `409` by refreshing and reconciling the latest item. During the 17 October 2026 pre-submission review, the PostgreSQL integration suite passed against a newly created, loopback-only PostgreSQL 16 test service on its own Docker volume; the development database endpoint and row counts were unchanged. This local verification is not a production deployment validation.

## 6. Audited updates and role-aware controls

- **Context:** Operators need to know which item fields changed and who made a change, while read-only users should not be offered controls that the API will reject.
- **Chosen approach:** Every changed work-item field creates an actor-attributed activity record in the same Prisma transaction as the version-checked update. The client refreshes item details after a `409` conflict and only renders mutation controls for users with an editable team role; approval remains Lead/Admin-only in both the UI and API.
- **Trade-offs:** Description activity records identify the changed field without copying potentially long or sensitive text into the audit payload. UI role checks improve usability but are not an authorization boundary; server membership checks remain mandatory.

## 7. Persistent idempotency for create requests

- **Context:** Retried item and comment creation requests must not produce duplicate records, including when requests race across API processes.
- **Chosen approach:** When a client supplies `Idempotency-Key`, a PostgreSQL record is uniquely scoped by authenticated actor and operation. The request hash, stored response, created item/comment, and item activity are committed together in a transaction. PostgreSQL's unique constraint arbitrates concurrent requests; matching retries replay the stored response, and key reuse with a different validated payload returns `409`.
- **Trade-offs:** The header remains optional for compatibility, so callers must reuse a key to receive retry safety. Response snapshots remain stored until the actor is deleted; no expiry or cleanup worker is included.
