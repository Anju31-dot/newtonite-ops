import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api.js";

const initialFilters = { q: "", status: "", priority: "", type: "", assigneeId: "", scope: "" };
const typeLabels = {
  INCIDENT: "Incident",
  CUSTOMER_ISSUE: "Customer issue",
  PAYMENT_INVESTIGATION: "Payment investigation",
  COMPLIANCE_REQUEST: "Compliance request",
  GENERAL_TASK: "General task"
};
const statusLabels = { OPEN: "Open", IN_PROGRESS: "In progress", AWAITING_APPROVAL: "Awaiting approval", RESOLVED: "Resolved", CLOSED: "Closed" };
const roleNames = { VIEWER: "Viewer", MEMBER: "Member", LEAD: "Lead", ADMIN: "Admin" };
const shortDate = (value) => value ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(value)) : "No due date";

function Login({ onLogin, error }) {
  const [email, setEmail] = useState("member@newtonite.demo");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await onLogin(email, password);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-mark">N</div>
        <p className="eyebrow">NEWTONITE · OPERATIONS</p>
        <h1>Keep the work<br />moving forward.</h1>
        <p className="muted">A focused command center for the work that matters now.</p>
        <form onSubmit={submit} className="login-form">
          <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="username" /></label>
          <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="current-password" /></label>
          {error && <p className="notice error">{error}</p>}
          <button className="button primary wide" disabled={busy}>{busy ? "Signing in…" : "Sign in to workspace"} <span aria-hidden="true">→</span></button>
        </form>
        <p className="login-hint">Demo accounts are listed in the project README.</p>
      </section>
      <aside className="login-art"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="art-orbit orbit-three" /><span>OPS</span><p>Clarity in every<br />critical moment.</p><small>BUILT FOR THE WORK IN BETWEEN</small></aside>
    </main>
  );
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem("ops-token"));
  const [user, setUser] = useState(null);
  const [loginError, setLoginError] = useState("");
  const [items, setItems] = useState([]);
  const [teams, setTeams] = useState([]);
  const [members, setMembers] = useState([]);
  const [metrics, setMetrics] = useState({ open: 0, urgent: 0, inProgress: 0, awaitingApproval: 0 });
  const [pagination, setPagination] = useState({ page: 1, pageSize: 10, total: 0, totalPages: 0 });
  const [filters, setFilters] = useState({ ...initialFilters, teamId: "", assigneeId: "" });
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [comment, setComment] = useState("");
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState(false);

  const queryString = useMemo(() => {
    const query = new URLSearchParams({ page: String(pagination.page), pageSize: String(pagination.pageSize), sortBy: "updatedAt", order: "desc" });
    Object.entries(filters).forEach(([key, value]) => { if (value) query.set(key, value); });
    return query.toString();
  }, [filters, pagination.page, pagination.pageSize]);

  const loadItems = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const data = await api(`/items?${queryString}`, { token });
      setItems(data.items);
      setMetrics(data.metrics);
      setPagination((previous) => ({ ...previous, ...data.pagination }));
    } catch (loadError) {
      setError(loadError.message);
      if (loadError.status === 401) signOut();
    } finally {
      setLoading(false);
    }
  }, [token, queryString]);

  function signOut() {
    localStorage.removeItem("ops-token");
    setToken(null);
    setUser(null);
    setSelected(null);
    setDetail(null);
  }

  useEffect(() => {
    if (!token) return;
    Promise.all([api("/auth/me", { token }), api("/teams", { token }), api("/members", { token })])
      .then(([{ user: currentUser }, { teams: availableTeams }, { members: availableMembers }]) => {
        setUser(currentUser);
        setTeams(availableTeams);
        setMembers(availableMembers);
      })
      .catch(() => signOut());
  }, [token]);

  useEffect(() => {
    if (user) loadItems();
  }, [user, loadItems]);

  useEffect(() => {
    if (!selected || !token) return;
    setDetailLoading(true);
    api(`/items/${selected.id}`, { token })
      .then(setDetail)
      .catch((loadError) => setError(loadError.message))
      .finally(() => setDetailLoading(false));
  }, [selected, token]);

  async function login(email, password) {
    setLoginError("");
    try {
      const data = await api("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      localStorage.setItem("ops-token", data.token);
      setToken(data.token);
      setUser(data.user);
    } catch (error) {
      setLoginError(error.message);
    }
  }

  function setFilter(key, value) {
    setPagination((current) => ({ ...current, page: 1 }));
    setFilters((current) => ({ ...current, [key]: value }));
  }

  async function runAction(path, body, success) {
    try {
      await api(path, { token, method: body ? "PATCH" : "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
      setToast(success);
      await loadItems();
      if (selected) {
        const fresh = await api(`/items/${selected.id}`, { token });
        setDetail(fresh);
        setSelected(fresh.item);
      }
      window.setTimeout(() => setToast(""), 3000);
    } catch (actionError) {
      setToast(actionError.message);
      if (actionError.status === 409) {
        await loadItems();
        if (selected) {
          const fresh = await api(`/items/${selected.id}`, { token });
          setDetail(fresh);
          setSelected(fresh.item);
        }
      }
    }
  }

  async function addComment(event) {
    event.preventDefault();
    if (!comment.trim() || !selected) return;
    try {
      await api(`/items/${selected.id}/comments`, { token, method: "POST", body: JSON.stringify({ body: comment }) });
      setComment("");
      setDetail(await api(`/items/${selected.id}`, { token }));
      setToast("Comment added.");
      window.setTimeout(() => setToast(""), 2500);
    } catch (actionError) {
      setToast(actionError.message);
    }
  }

  async function createItem(event) {
    event.preventDefault();
    setCreating(true);
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const response = await api("/items", { token, method: "POST", body: JSON.stringify({
        title: data.get("title"),
        description: data.get("description"),
        type: data.get("type"),
        priority: data.get("priority"),
        teamId: data.get("teamId")
      }) });
      setCreateOpen(false);
      form.reset();
      setToast("Work item created.");
      await loadItems();
      setSelected(response.item);
      window.setTimeout(() => setToast(""), 2500);
    } catch (createError) {
      setToast(createError.message);
    } finally {
      setCreating(false);
    }
  }

  async function updateItem(event) {
    event.preventDefault();
    if (!detail) return;
    setCreating(true);
    const data = new FormData(event.currentTarget);
    try {
      const response = await api(`/items/${detail.item.id}`, { token, method: "PATCH", body: JSON.stringify({
        version: detail.item.version,
        title: data.get("title"),
        description: data.get("description"),
        type: data.get("type"),
        priority: data.get("priority"),
        dueDate: data.get("dueDate") ? new Date(data.get("dueDate")).toISOString() : null
      }) });
      setEditing(false);
      setDetail({ ...detail, item: response.item });
      setSelected(response.item);
      await loadItems();
      setToast("Work item updated.");
      window.setTimeout(() => setToast(""), 2500);
    } catch (updateError) {
      setToast(updateError.message);
    } finally {
      setCreating(false);
    }
  }

  if (!token) return <Login onLogin={login} error={loginError} />;
  if (!user) return <main className="startup-state"><span className="spinner" /> Checking your workspace…</main>;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#"><span className="brand-mark small">N</span><span>Newtonite<small>OPERATIONS</small></span></a>
        <div className="workspace-label">WORKSPACE</div>
        <button className={`nav-item ${!filters.scope ? "active" : ""}`} onClick={() => setFilter("scope", "")}><span>▦</span> All work <b>{pagination.total}</b></button>
        <button className={`nav-item ${filters.scope === "mine" ? "active" : ""}`} onClick={() => setFilter("scope", "mine")}><span>◉</span> Assigned to me</button>
        <button className={`nav-item ${filters.scope === "unassignedUrgent" ? "active" : ""}`} onClick={() => setFilter("scope", "unassignedUrgent")}><span className="nav-alert">!</span> Urgent & unassigned</button>
        {teams.some((team) => ["LEAD", "ADMIN"].includes(team.role)) && <button className={`nav-item ${filters.scope === "approval" ? "active" : ""}`} onClick={() => setFilter("scope", "approval")}><span>◷</span> Awaiting approval</button>}
        <div className="sidebar-bottom"><div className="status-online"><i /> All systems operational</div><div className="profile"><div className="avatar">{user.name.split(" ").map((part) => part[0]).join("")}</div><div><strong>{user.name}</strong><small>Workspace member</small></div><button title="Sign out" onClick={signOut}>↗</button></div></div>
      </aside>

      <main className="main-area">
        <header className="topbar"><div className="breadcrumb">Workspace <span>/</span> <strong>Operations</strong></div><div className="top-actions"><span className="live-pill"><i /> LIVE</span><button className="button primary" onClick={() => setCreateOpen(true)}>＋ New work item</button></div></header>
        <section className="page-content">
          <div className="page-heading"><div><p className="eyebrow">MONDAY, OCTOBER 19, 2026 <span>·</span> GOOD MORNING</p><h1>Operations overview</h1><p className="muted">The right work, in the right hands, at the right time.</p></div><div className="heading-meta"><div className="avatar-stack"><span>JM</span><span>SP</span><span>CR</span><b>+4</b></div><small>TEAM WORKSPACE</small></div></div>
          <div className="stat-grid">
            <div className="stat-card"><div className="stat-top">Open work <span className="stat-icon blue">▦</span></div><strong>{metrics.open}</strong><small>not yet closed</small><div className="stat-rule blue-rule" /></div>
            <div className="stat-card"><div className="stat-top">Urgent <span className="stat-icon red">↗</span></div><strong>{metrics.urgent}</strong><small>need attention now</small><div className="stat-rule red-rule" /></div>
            <div className="stat-card"><div className="stat-top">In progress <span className="stat-icon violet">◷</span></div><strong>{metrics.inProgress}</strong><small>being worked on</small><div className="stat-rule violet-rule" /></div>
            <div className="stat-card"><div className="stat-top">Awaiting approval <span className="stat-icon amber">✓</span></div><strong>{metrics.awaitingApproval}</strong><small>ready for review</small><div className="stat-rule amber-rule" /></div>
          </div>

          <section className="work-panel">
            <div className="panel-heading"><div><h2>Work queue</h2><p>Stay ahead of what needs your attention.</p></div><div className="queue-count"><span /> {pagination.total} items</div></div>
            <div className="toolbar"><label className="search-box"><span>⌕</span><input value={filters.q} onChange={(event) => setFilter("q", event.target.value)} placeholder="Search work items…" /></label>
              <select aria-label="Filter status" value={filters.status} onChange={(event) => setFilter("status", event.target.value)}><option value="">All statuses</option>{Object.entries(statusLabels).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select>
              <select aria-label="Filter priority" value={filters.priority} onChange={(event) => setFilter("priority", event.target.value)}><option value="">All priorities</option>{["URGENT", "HIGH", "MEDIUM", "LOW"].map((value) => <option key={value} value={value}>{value[0] + value.slice(1).toLowerCase()}</option>)}</select>
              <select aria-label="Filter type" value={filters.type} onChange={(event) => setFilter("type", event.target.value)}><option value="">All types</option>{Object.entries(typeLabels).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select>
              <select aria-label="Filter team" value={filters.teamId} onChange={(event) => setFilter("teamId", event.target.value)}><option value="">All teams</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select>
              <select aria-label="Filter assignee" value={filters.assigneeId} onChange={(event) => setFilter("assigneeId", event.target.value)}><option value="">All assignees</option>{members.map((member) => <option key={`${member.teamId}-${member.id}`} value={member.id}>{member.name}</option>)}</select>
            </div>
            {error && <div className="notice error">{error}<button onClick={loadItems}>Retry</button></div>}
            <div className="table-wrap"><table><thead><tr><th>WORK ITEM</th><th>PRIORITY</th><th>STATUS</th><th>ASSIGNEE</th><th>DUE DATE</th><th /></tr></thead>
              <tbody>{loading ? <tr><td colSpan="6" className="table-message"><span className="spinner" /> Loading work queue…</td></tr> : items.length === 0 ? <tr><td colSpan="6" className="table-message empty-state"><span>◌</span><strong>Nothing in this queue</strong><small>Try a different filter or create a new work item.</small></td></tr> : items.map((item) => (
                <tr key={item.id} onClick={() => { setSelected(item); setDetail(null); }} className={selected?.id === item.id ? "selected-row" : ""}>
                  <td><div className="item-cell"><span className={`type-icon type-${item.type.toLowerCase()}`}>{item.type === "INCIDENT" ? "ϟ" : item.type === "PAYMENT_INVESTIGATION" ? "$" : item.type === "COMPLIANCE_REQUEST" ? "⌑" : item.type === "CUSTOMER_ISSUE" ? "◉" : "↗"}</span><div><strong>{item.title}</strong><small>{typeLabels[item.type]} <span>·</span> {item.team.name}</small></div></div></td>
                  <td><span className={`priority priority-${item.priority.toLowerCase()}`}><i /> {item.priority[0] + item.priority.slice(1).toLowerCase()}</span></td>
                  <td><span className={`status status-${item.status.toLowerCase().replaceAll("_", "-")}`}>{statusLabels[item.status]}</span></td>
                  <td>{item.assignee ? <span className="assignee"><span className="avatar mini">{item.assignee.name.split(" ").map((part) => part[0]).join("")}</span>{item.assignee.name.split(" ")[0]}</span> : <span className="unassigned">Unassigned</span>}</td>
                  <td className="due-date">{shortDate(item.dueDate)}</td><td><button className="row-more" aria-label={`Open ${item.title}`}>···</button></td>
                </tr>
              ))}</tbody></table></div>
            <footer className="table-footer"><span>Showing {items.length ? (pagination.page - 1) * pagination.pageSize + 1 : 0}–{Math.min(pagination.page * pagination.pageSize, pagination.total)} of {pagination.total} work items</span><div><button disabled={pagination.page <= 1 || loading} onClick={() => setPagination((current) => ({ ...current, page: current.page - 1 }))}>← Previous</button><span className="page-number">{pagination.page}</span><button disabled={pagination.page >= pagination.totalPages || loading} onClick={() => setPagination((current) => ({ ...current, page: current.page + 1 }))}>Next →</button></div></footer>
          </section>
          <footer className="app-footer"><span>Newtonite Operations <b>·</b> Internal workspace</span><span>SECURE TEAM ACCESS <i /> LAST SYNC JUST NOW</span></footer>
        </section>
      </main>

      {selected && <div className="drawer-backdrop" onClick={() => setSelected(null)}><aside className="detail-drawer" onClick={(event) => event.stopPropagation()}>
        <div className="drawer-top"><span className="eyebrow">WORK ITEM</span><button onClick={() => setSelected(null)} aria-label="Close details">×</button></div>
        {detailLoading || !detail ? <p className="muted drawer-loading">Loading item details…</p> : <><div className="drawer-title"><span className={`type-icon type-${detail.item.type.toLowerCase()}`}>ϟ</span><span className={`status status-${detail.item.status.toLowerCase().replaceAll("_", "-")}`}>{statusLabels[detail.item.status]}</span><span className={`priority priority-${detail.item.priority.toLowerCase()}`}><i /> {detail.item.priority[0] + detail.item.priority.slice(1).toLowerCase()}</span></div>
          <h2>{detail.item.title}</h2><p className="drawer-description">{detail.item.description}</p><div className="detail-facts"><div><small>TEAM</small><strong>{detail.item.team.name}</strong></div><div><small>ASSIGNEE</small><strong>{detail.item.assignee?.name || "Unassigned"}</strong></div><div><small>CREATED BY</small><strong>{detail.item.creator.name}</strong></div><div><small>DUE DATE</small><strong>{shortDate(detail.item.dueDate)}</strong></div><div><small>VERSION</small><strong>v{detail.item.version}</strong></div><div><small>TYPE</small><strong>{typeLabels[detail.item.type]}</strong></div></div>
          {["MEMBER", "LEAD", "ADMIN"].includes(teams.find((team) => team.id === detail.item.teamId)?.role) && <button className="button secondary wide drawer-action" onClick={() => setEditing(true)}>Edit work item</button>}
          {["MEMBER", "LEAD", "ADMIN"].includes(teams.find((team) => team.id === detail.item.teamId)?.role) && <label className="assignment-control">ASSIGNEE<select aria-label="Assign work item" value={detail.item.assigneeId || ""} onChange={(event) => runAction(`/items/${detail.item.id}/assignment`, { version: detail.item.version, assigneeId: event.target.value || null }, "Assignee updated.")}><option value="">Unassigned</option>{members.filter((member) => member.teamId === detail.item.teamId).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>}
          {detail.item.assigneeId === null && <button className="button primary wide drawer-action" onClick={() => runAction(`/items/${detail.item.id}/claim`, null, "You claimed this item.")}>Claim this item</button>}
          {detail.item.status !== "CLOSED" && <div className="workflow-actions">{detail.item.status === "OPEN" && <button className="button secondary" onClick={() => runAction(`/items/${detail.item.id}/status`, { status: "IN_PROGRESS", version: detail.item.version }, "Work started.")}>Start work</button>}
            {detail.item.status === "IN_PROGRESS" && <button className="button secondary" onClick={() => runAction(`/items/${detail.item.id}/status`, { status: "AWAITING_APPROVAL", version: detail.item.version }, "Sent for approval.")}>Request approval</button>}
            {detail.item.status === "AWAITING_APPROVAL" && ["LEAD", "ADMIN"].includes(teams.find((team) => team.id === detail.item.teamId)?.role) && <button className="button primary" onClick={() => runAction(`/items/${detail.item.id}/status`, { status: "RESOLVED", version: detail.item.version }, "Item approved and resolved.")}>Approve & resolve</button>}
            {detail.item.status === "RESOLVED" && <button className="button secondary" onClick={() => runAction(`/items/${detail.item.id}/status`, { status: "CLOSED", version: detail.item.version }, "Item closed.")}>Close item</button>}</div>}
          <section className="drawer-section"><h3>Activity <span>{detail.activities.length}</span></h3><div className="timeline">{detail.activities.map((activity) => <div className="timeline-entry" key={activity.id}><span className="timeline-dot" /><div><strong>{activity.actor.name}</strong> {activity.action.replaceAll("_", " ")}{activity.details?.from !== undefined && <span className="activity-change"> {activity.details.from || "Unassigned"} → {activity.details.to || "Unassigned"}</span>}<small>{new Date(activity.createdAt).toLocaleString()}</small></div></div>)}{detail.activities.length === 0 && <small>No activity recorded yet.</small>}</div></section>
          <section className="drawer-section"><h3>Comments <span>{detail.comments.length}</span></h3><div className="comments">{detail.comments.map((entry) => <article className="comment" key={entry.id}><strong>{entry.author.name}</strong><small>{new Date(entry.createdAt).toLocaleString()}</small><p>{entry.body}</p></article>)}</div><form className="comment-form" onSubmit={addComment}><input value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Write a comment…" aria-label="Write a comment" /><button className="button primary" disabled={!comment.trim()}>Send</button></form></section>
        </>}
      </aside></div>}

      {(createOpen || editing) && <div className="modal-backdrop" onClick={() => { setCreateOpen(false); setEditing(false); }}><section className="create-modal" onClick={(event) => event.stopPropagation()}><div className="drawer-top"><div><span className="eyebrow">{editing ? "UPDATE WORK" : "NEW WORK"}</span><h2>{editing ? "Edit work item" : "Create work item"}</h2></div><button onClick={() => { setCreateOpen(false); setEditing(false); }} aria-label="Close form">×</button></div><form onSubmit={editing ? updateItem : createItem} className="create-form">
        <label>Title<input name="title" required minLength="3" maxLength="160" placeholder="What needs to get done?" defaultValue={editing ? detail?.item.title : ""} /></label><label>Description<textarea name="description" required rows="4" placeholder="Add the important context…" defaultValue={editing ? detail?.item.description : ""} /></label><div className="form-row"><label>Type<select name="type" defaultValue={editing ? detail?.item.type : "GENERAL_TASK"}>{Object.entries(typeLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>Priority<select name="priority" defaultValue={editing ? detail?.item.priority : "MEDIUM"}>{["LOW", "MEDIUM", "HIGH", "URGENT"].map((value) => <option key={value} value={value}>{value[0] + value.slice(1).toLowerCase()}</option>)}</select></label></div>
        {editing ? <label>Due date<input name="dueDate" type="datetime-local" defaultValue={detail?.item.dueDate ? new Date(detail.item.dueDate).toISOString().slice(0, 16) : ""} /></label> : <label>Team<select name="teamId" required defaultValue={teams.find((team) => ["MEMBER", "LEAD", "ADMIN"].includes(team.role))?.id || ""}><option value="" disabled>Select a team</option>{teams.filter((team) => ["MEMBER", "LEAD", "ADMIN"].includes(team.role)).map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={() => { setCreateOpen(false); setEditing(false); }}>Cancel</button><button className="button primary" disabled={creating}>{editing ? "Save changes" : "Create item"}</button></div></form></section></div>}
      {toast && <div className={`toast ${toast.toLowerCase().includes("could") || toast.toLowerCase().includes("changed") ? "toast-error" : ""}`} role="status">{toast}</div>}
    </div>
  );
}

export default App;
