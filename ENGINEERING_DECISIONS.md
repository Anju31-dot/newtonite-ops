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
- **Trade-offs:** PostgreSQL provides the serialization point with no additional service. Clients must handle `409` by refreshing and reconciling the latest item. The integration suite is present but was not run in this workspace because Docker and PostgreSQL were unavailable; passing mocked tests are not evidence of real database concurrency.
