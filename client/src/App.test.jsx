import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.jsx";

const apiMock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./api.js", () => apiMock);

const member = { id: "user-1", name: "Sam Member", email: "member@example.test" };
const team = { id: "team-1", name: "Operations" };
const item = {
  id: "item-1",
  title: "Unassigned incident",
  description: "Investigate the service issue.",
  type: "INCIDENT",
  priority: "HIGH",
  status: "OPEN",
  teamId: team.id,
  assigneeId: null,
  version: 1,
  team,
  assignee: null,
  creator: { id: "lead-1", name: "Jordan Lead" },
  dueDate: null
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let root;
let container;
let currentRole;
let currentStatus;
let currentVersion;
let currentTitle;
let currentActivities;
let conflictOnEdit;
let failCreateOnce;
let failCommentOnce;

function makeDetail() {
  return {
    item: { ...item, title: currentTitle, status: currentStatus, version: currentVersion },
    activities: currentActivities,
    comments: []
  };
}

function setupApi() {
  apiMock.api.mockImplementation(async (path, options = {}) => {
    if (path === "/auth/me") return { user: member };
    if (path === "/teams") return { teams: [{ ...team, role: currentRole }] };
    if (path === "/members") {
      return { members: [{ ...member, teamId: team.id, teamName: team.name, role: currentRole }] };
    }
    if (path.startsWith("/items?")) {
      return {
        items: [makeDetail().item],
        metrics: { open: 1, urgent: 0, inProgress: 0, awaitingApproval: 0 },
        pagination: { page: 1, pageSize: 10, total: 1, totalPages: 1 }
      };
    }
    if (path === "/items" && options.method === "POST") {
      if (failCreateOnce) {
        failCreateOnce = false;
        throw new Error("Temporary network failure");
      }
      return { item: makeDetail().item };
    }
    if (path === "/items/item-1/comments" && options.method === "POST") {
      if (failCommentOnce) {
        failCommentOnce = false;
        throw new Error("Temporary network failure");
      }
      return { comment: { id: "comment-1" } };
    }
    if (path === "/items/item-1" && options.method === "PATCH") {
      currentVersion = 2;
      if (conflictOnEdit) {
        currentTitle = "Latest item title";
        throw Object.assign(new Error("This item changed since you opened it."), { status: 409, code: "STALE_VERSION" });
      }
      currentTitle = JSON.parse(options.body).title;
      currentActivities = [{
        id: "activity-1",
        action: "title_changed",
        details: { from: item.title, to: currentTitle },
        actor: { id: member.id, name: member.name },
        createdAt: new Date().toISOString()
      }];
      return { item: { ...makeDetail().item, title: currentTitle } };
    }
    if (path === "/items/item-1") return makeDetail();
    throw new Error(`Unexpected API request: ${path}`);
  });
}

async function renderApp(role, status = "OPEN") {
  currentRole = role;
  currentStatus = status;
  currentVersion = 1;
  currentTitle = item.title;
  currentActivities = [];
  conflictOnEdit = true;
  failCreateOnce = false;
  failCommentOnce = false;
  localStorage.setItem("ops-token", "test-token");
  setupApi();
  await act(async () => {
    root.render(<App />);
    await flush();
    await flush();
  });
}

async function openItem() {
  await act(async () => {
    container.querySelector("tbody tr").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    await flush();
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  apiMock.api.mockReset();
});

describe("work-item UI authorization and conflict handling", () => {
  it("hides work-item mutations from Viewers", async () => {
    await renderApp("VIEWER");
    expect(container.textContent).not.toContain("New work item");
    await openItem();

    expect(container.textContent).not.toContain("Claim this item");
    expect(container.textContent).not.toContain("Start work");
    expect(container.textContent).not.toContain("Edit work item");
    expect(container.querySelector('[aria-label="Assign work item"]')).toBeNull();
    expect(container.querySelector('[aria-label="Write a comment"]')).toBeNull();
  });

  it("shows approval controls only to Leads and Admins", async () => {
    await renderApp("MEMBER", "AWAITING_APPROVAL");
    await openItem();
    expect(container.textContent).not.toContain("Approve & resolve");

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderApp("LEAD", "AWAITING_APPROVAL");
    await openItem();
    expect(container.textContent).toContain("Approve & resolve");
  });

  it("reloads the latest item after a stale edit conflict", async () => {
    await renderApp("MEMBER");
    await openItem();
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Edit work item").click();
    });

    const form = container.querySelector(".create-form");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
      await flush();
    });

    expect(container.textContent).toContain("This item changed elsewhere. The latest version is loaded");
    expect(container.querySelector(".create-modal")).toBeNull();
    expect(apiMock.api).toHaveBeenCalledWith("/items/item-1", { token: "test-token" });
  });

  it("refreshes the activity timeline after a successful edit", async () => {
    await renderApp("MEMBER");
    await openItem();
    conflictOnEdit = false;
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Edit work item").click();
    });

    const form = container.querySelector(".create-form");
    form.querySelector('[name="title"]').value = "Edited incident title";
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
      await flush();
      await flush();
    });

    expect(container.textContent).toContain("Edited incident title");
    expect(container.textContent).toContain("title changed");
  });

  it("reuses an idempotency key when retrying unchanged item creation", async () => {
    await renderApp("MEMBER");
    failCreateOnce = true;
    await act(async () => {
      container.querySelector(".top-actions button").click();
    });
    const form = container.querySelector(".create-form");
    form.querySelector('[name="title"]').value = "Retryable item";
    form.querySelector('[name="description"]').value = "Retry after a transient failure.";

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await act(async () => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await flush();
        await flush();
      });
    }

    const createCalls = apiMock.api.mock.calls.filter(([path, options]) => path === "/items" && options.method === "POST");
    expect(createCalls).toHaveLength(2);
    expect(createCalls[1][1].headers["Idempotency-Key"]).toBe(createCalls[0][1].headers["Idempotency-Key"]);
  });

  it("reuses an idempotency key when retrying an unchanged comment", async () => {
    await renderApp("MEMBER");
    failCommentOnce = true;
    await openItem();
    const input = container.querySelector('[aria-label="Write a comment"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, "Retryable comment");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await act(async () => {
        container.querySelector(".comment-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await flush();
        await flush();
      });
    }

    const commentCalls = apiMock.api.mock.calls.filter(([path, options]) => path === "/items/item-1/comments" && options.method === "POST");
    expect(commentCalls).toHaveLength(2);
    expect(commentCalls[1][1].headers["Idempotency-Key"]).toBe(commentCalls[0][1].headers["Idempotency-Key"]);
  });
});
