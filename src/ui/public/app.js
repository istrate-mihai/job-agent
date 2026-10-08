// Job Agent UI. Vanilla JS, no build step. All posting text is untrusted: rendered with textContent only.

// ── Helpers ──
const $ = (sel, root = document) => root.querySelector(sel);

/** h("div.row", { onclick }, child, "text") — tiny element builder; strings become text nodes (never HTML). */
function h(tag, attrs = {}, ...children) {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name || "div");
  if (classes.length) el.className = classes.join(" ");
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") for (const [prop, val] of Object.entries(v)) prop.startsWith("--") ? el.style.setProperty(prop, val) : (el.style[prop] = val);
    else if (k in el && k !== "list" && k !== "form") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(path) {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

async function post(path, payload) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-job-agent": "1" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

let toastTimer;
function toast(text, error = false) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.toggle("error", error);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), error ? 6000 : 3000);
}

const short = (id) => id.slice(0, 8);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const ago = (days) => (days === null || days === undefined ? "" : days <= 0 ? "today" : `${days}d ago`);
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");
const TIER = { tierA: "local", tierB: "relocation", remote: "remote" };
const tierLabel = (t) => TIER[t] ?? t ?? "";
const unique = (parts) => [...new Set(parts.filter(Boolean).map(String))].filter((v, i, a) => a.findIndex((x) => x.toLowerCase() === v.toLowerCase()) === i);
const wide = () => window.matchMedia("(min-width: 721px)").matches;
const fileUrl = (path) => `/file?path=${encodeURIComponent(path)}`;

async function copy(text, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    toast("Clipboard blocked: select the text and press Ctrl+C", true);
  }
}

/** Small modal form. fields: [{ name, label, type?, value?, options?, hint? }] → values object or null. */
function ask(title, fields, okLabel = "OK") {
  const dialog = $("#prompt-dialog");
  $("#prompt-title").textContent = title;
  $("#prompt-ok").textContent = okLabel;
  const box = $("#prompt-fields");
  box.replaceChildren(
    ...fields.map((f) => {
      const id = `f-${f.name}`;
      const input =
        f.type === "select"
          ? h("select", { id, name: f.name }, f.options.map((o) => h("option", { value: o.value, selected: o.value === f.value }, o.label)))
          : f.type === "textarea"
            ? h("textarea", { id, name: f.name, value: f.value ?? "" })
            : f.type === "checkbox"
              ? h("input", { id, name: f.name, type: "checkbox", checked: Boolean(f.value) })
              : h("input", { id, name: f.name, type: f.type ?? "text", value: f.value ?? "", placeholder: f.placeholder ?? "" });
      if (f.type === "checkbox") return h("label.check", { htmlFor: id }, input, f.label);
      return h("div.field", {}, h("label", { htmlFor: id }, f.label), input, f.hint ? h("span.hint", {}, f.hint) : null);
    }),
  );
  return new Promise((resolve) => {
    dialog.onclose = () => {
      if (dialog.returnValue !== "ok") return resolve(null);
      const out = {};
      for (const f of fields) {
        const el = box.querySelector(`[name="${f.name}"]`);
        out[f.name] = f.type === "checkbox" ? el.checked : el.value;
      }
      resolve(out);
    };
    dialog.returnValue = "";
    dialog.showModal();
    box.querySelector("input, textarea, select")?.focus();
  });
}

// ── Commands + console ──
const consoleEl = $("#console");
const consoleLog = $("#console-log");
let watchedJob = null;

$("#console-toggle").addEventListener("click", () => {
  const open = consoleEl.classList.toggle("open");
  $("#console-toggle").setAttribute("aria-expanded", String(open));
});

function openConsole() {
  consoleEl.classList.add("open");
  $("#console-toggle").setAttribute("aria-expanded", "true");
}

/** Runs a whitelisted command on the server; resolves with the finished job. */
async function run(command, params = {}, { showLog = false, quiet = false } = {}) {
  let jobId;
  try {
    ({ jobId } = await post("/api/run", { command, params }));
  } catch (err) {
    toast(err.message, true);
    throw err;
  }
  if (showLog) openConsole();
  return watch(jobId, quiet);
}

async function watch(jobId, quiet) {
  watchedJob = jobId;
  consoleLog.textContent = "";
  let from = 0;
  for (;;) {
    const job = await api(`/api/jobs/${jobId}?from=${from}`);
    if (watchedJob === jobId) {
      if (job.log.length) {
        const atBottom = consoleLog.scrollTop + consoleLog.clientHeight >= consoleLog.scrollHeight - 8;
        consoleLog.append(job.log.join("\n") + "\n");
        if (atBottom) consoleLog.scrollTop = consoleLog.scrollHeight;
      }
      $("#console-title").textContent = `${job.title} — ${job.status === "running" ? "running" : job.status === "queued" ? "waiting for previous command" : job.status}`;
      $("#console-dot").className = `dot ${job.status}`;
    }
    from = job.logLength;
    if (job.status === "done" || job.status === "failed") {
      if (job.status === "failed") {
        toast(`${job.title} failed — see output`, true);
        openConsole();
      } else if (!quiet) toast(`${job.title}: done`);
      refreshCounts();
      return job;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
}

document.querySelectorAll("[data-run]").forEach((btn) =>
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await run(btn.dataset.run, {}, { showLog: true });
      await render();
    } finally {
      btn.disabled = false;
    }
  }),
);

// ── State ──
const state = {
  view: "review",
  items: [], // current list (rows the keyboard moves through)
  index: -1,
  detailId: null,
  reviewAll: false,
  appsFilter: "active",
  thresholds: { tailor: 70, review: 50 },
};

async function refreshCounts() {
  try {
    const o = await api("/api/overview");
    state.thresholds = o.thresholds;
    const c = o.counts;
    const set = (k, v) => document.querySelectorAll(`[data-count="${k}"]`).forEach((el) => (el.textContent = v ? String(v) : ""));
    set("toReview", c.toReview);
    set("active", c.approved + c.tailored + c.applied + c.responded);
    set("followUpsDue", c.followUpsDue);
    set("setupIssues", o.cv === "ok" ? "" : "!");
    const pct = Math.min(100, Math.round((o.tokens.used / o.tokens.budget) * 100));
    $("#tokens").replaceChildren(
      h("div", {}, `LLM tokens today: ${o.tokens.used.toLocaleString()} of ${o.tokens.budget.toLocaleString()}`),
      h("div.meter", {}, h("span", { style: { width: `${pct}%` } })),
      ...(o.cv === "ok" ? [] : [h("div", { style: { color: "var(--warn)", marginTop: "6px" } }, o.cv === "missing" ? "No CV data: run npm run setup" : "Your CV is still the example (Alex Popescu): edit data/master-cv.json")]),
      ...(o.agentEnabled ? [] : [h("div", { style: { color: "var(--warn)" } }, "Agent paused in config (agent.enabled: false)")]),
    );
  } catch (err) {
    $("#tokens").textContent = `Database unreachable: ${err.message}. Click “Start database”.`;
  }
}

// ── Gauge (the score against its tolerance zones) ──
function gauge(score, recommendation, large = false) {
  const { review, tailor } = state.thresholds;
  const g = h(
    `div.gauge${large ? ".large" : ""}`,
    { title: `${score}/100 · maybe from ${review}, apply from ${tailor}` },
    h(`div.gauge-value.${recommendation}`, {}, String(score), h("small", {}, recommendation)),
    h("div.gauge-track", { style: { "--review": `${review}%`, "--tailor": `${tailor}%` } }, h("span.gauge-mark", { style: { left: `${Math.max(0, Math.min(100, score))}%` } })),
  );
  if (large) {
    g.append(h("div.gauge-scale", {}, h("span", { style: { left: "0%", transform: "none" } }, "0"), h("span", { style: { left: `${review}%` } }, String(review)), h("span", { style: { left: `${tailor}%` } }, String(tailor)), h("span", { style: { left: "100%", transform: "translateX(-100%)" } }, "100")));
  }
  return g;
}

// ── Layout helpers ──
const main = $("#main");
const detail = $("#detail");

function showDetail(node) {
  detail.replaceChildren(node);
  detail.hidden = false;
  document.querySelector(".app").classList.remove("no-detail");
}
function hideDetail() {
  detail.hidden = true;
  detail.replaceChildren();
  state.detailId = null;
  document.querySelector(".app").classList.add("no-detail");
  document.querySelectorAll(".row.selected").forEach((r) => r.classList.remove("selected"));
}

function head(title, sub, ...extra) {
  return h("div.view-head", {}, h("h1", {}, title), sub ? h("span.sub", {}, sub) : null, h("span.spacer"), ...extra);
}

function select(index, { open = true } = {}) {
  const rows = main.querySelectorAll(".row[data-index]");
  if (rows.length === 0) return;
  state.index = Math.max(0, Math.min(index, rows.length - 1));
  rows.forEach((r) => r.classList.toggle("selected", Number(r.dataset.index) === state.index));
  const row = rows[state.index];
  row.scrollIntoView({ block: "nearest" });
  if (open) {
    const item = state.items[state.index];
    if (item) openPosting(item.id);
  }
}

function rowButton(item, index, ...content) {
  return h("button.row", { "data-index": index, onclick: () => select(index) }, ...content);
}

// ── Review ──
async function viewReview() {
  const items = await api(`/api/review${state.reviewAll ? "?all=1" : ""}`);
  state.items = items;
  const toggle = h("button.chip-toggle", { "aria-pressed": String(state.reviewAll), onclick: () => ((state.reviewAll = !state.reviewAll), render()) }, "Show skips");
  const keys = h("div.keys", {}, h("span", {}, h("kbd", {}, "J"), " ", h("kbd", {}, "K"), " move"), h("span", {}, h("kbd", {}, "A"), " approve"), h("span", {}, h("kbd", {}, "S"), " skip"), h("span", {}, h("kbd", {}, "⇧"), "+A/S with reason"), h("span", {}, h("kbd", {}, "O"), " open posting"));
  main.replaceChildren(head("Review", plural(items.length, "posting"), keys), h("div.filters", {}, toggle));
  if (items.length === 0) {
    main.append(h("div.empty", {}, h("p", {}, "Nothing waiting for a decision."), h("button.primary", { onclick: () => run("daily", {}, { showLog: true }).then(render) }, "Run daily pipeline")));
    hideDetail();
    return;
  }
  main.append(
    h(
      "div.list",
      {},
      items.map((it, i) =>
        rowButton(
          it,
          i,
          gauge(it.score, it.recommendation),
          h(
            "div.who",
            {},
            h("div.company", {}, it.company),
            h("div.title", {}, it.title),
            h("div.meta", {}, unique([tierLabel(it.tier), it.location, it.workMode === "unknown" ? "" : it.workMode, ago(it.ageDays), it.stack]).join(" · ")),
          ),
          h(
            "div.side",
            {},
            it.duplicateOf ? h("span.tag.info", {}, `duplicate (${it.duplicateOf.status})`) : null,
            it.titleOnly ? h("span.tag.warn", {}, "title only") : null,
            it.gaps.length ? h("span", {}, plural(it.gaps.length, "gap")) : null,
          ),
        ),
      ),
    ),
  );
  select(Math.min(Math.max(state.index, 0), items.length - 1), { open: wide() });
}

async function decide(decision, withReason) {
  const item = state.items[state.index];
  if (!item) return;
  let reason = "";
  if (withReason) {
    const r = await ask(`${decision === "approve" ? "Approve" : "Skip"} ${item.company}`, [{ name: "reason", label: "Reason", value: item.duplicateOf ? "duplicate" : "" }], decision === "approve" ? "Approve" : "Skip");
    if (!r) return;
    reason = r.reason;
  }
  // Optimistic: drop the row now, so the next posting is one keypress away
  const keep = state.index;
  state.items.splice(keep, 1);
  main.querySelectorAll(".row[data-index]")[keep]?.remove();
  main.querySelectorAll(".row[data-index]").forEach((r, i) => (r.dataset.index = String(i)));
  if (state.items.length) select(keep);
  else hideDetail();
  const job = await run("decide", { id: item.id, decision, reason }, { quiet: true });
  if (job.status === "done") toast(`${decision === "approve" ? "Approved" : "Skipped"}: ${item.company}`);
  else render();
}

// ── Applications ──
const STATUS_ORDER = ["approved", "tailored", "applied", "responded", "interview", "offer", "rejected"];
const STATUS_LABEL = { approved: "Approved, not tailored", tailored: "Tailored, ready to apply", applied: "Applied", responded: "Responded", interview: "Interview", offer: "Offer", rejected: "Rejected" };
const FILTERS = { active: ["approved", "tailored", "applied", "responded", "interview", "offer"], todo: ["approved", "tailored"], waiting: ["applied"], all: STATUS_ORDER };

async function viewApps() {
  const rows = await api("/api/board");
  const shown = rows.filter((r) => FILTERS[state.appsFilter].includes(r.status));
  shown.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || (b.score ?? 0) - (a.score ?? 0));
  state.items = shown;
  const chip = (key, label) => h("button.chip-toggle", { "aria-pressed": String(state.appsFilter === key), onclick: () => ((state.appsFilter = key), (state.index = 0), render()) }, label);
  const due = rows.filter((r) => r.followUpDue).length;
  main.replaceChildren(
    head("Applications", `${rows.filter((r) => r.status === "applied").length} waiting for an answer${due ? `, ${due} due a follow-up` : ""}`),
    h("div.filters", {}, chip("active", "In progress"), chip("todo", "To do"), chip("waiting", "Waiting"), chip("all", "All, incl. rejected")),
  );
  if (shown.length === 0) {
    main.append(h("div.empty", {}, h("p", {}, "No applications in this filter. Approve postings in Review, then tailor them here.")));
    hideDetail();
    return;
  }
  let index = 0;
  for (const status of STATUS_ORDER) {
    const group = shown.filter((r) => r.status === status);
    if (!group.length) continue;
    main.append(h("h2.group-title", {}, STATUS_LABEL[status], h("span.count", {}, String(group.length))));
    main.append(
      h(
        "div.list",
        {},
        group.map((r) => {
          const i = index++;
          return rowButton(
            r,
            i,
            r.score !== null ? gauge(r.score, r.score >= state.thresholds.tailor ? "apply" : r.score >= state.thresholds.review ? "maybe" : "skip") : h("span.sub", {}, "added by hand"),
            h("div.who", {}, h("div.company", {}, r.company), h("div.title", {}, r.title), h("div.meta", {}, [r.location, r.days !== null ? `${status} ${ago(r.days)}` : ""].filter(Boolean).join(" · "))),
            h(
              "div.side",
              {},
              r.followUpDue ? h("span.tag.warn", {}, "follow up") : null,
              (r.status === "tailored" || r.status === "applied") && !r.contacted ? h("span.tag", {}, "no recruiter contacted") : null,
              r.warningCount ? h("span.tag.warn", {}, plural(r.warningCount, "warning")) : null,
            ),
          );
        }),
      ),
    );
  }
  select(Math.min(Math.max(state.index, 0), shown.length - 1), { open: wide() });
}

// ── Posting detail (shared by every list) ──
async function openPosting(id) {
  state.detailId = id;
  let d;
  try {
    d = await api(`/api/postings/${id}`);
  } catch (err) {
    showDetail(h("div", {}, h("p", {}, err.message)));
    return;
  }
  if (state.detailId !== id) return; // user moved on
  const p = d.posting;
  const s = d.score;
  const refresh = async () => {
    await render();
    if (state.detailId) openPosting(state.detailId);
  };
  const act = (label, cls, fn) => h(`button.${cls}`, { onclick: fn }, label);

  const actions = [];
  const titleOnly = p.description.trim().length < 300;
  if (p.status === "scored" || p.status === "skipped") {
    actions.push(act("Approve", "primary", () => runAndRefresh("decide", { id, decision: "approve" }, refresh)));
    if (p.status === "scored") actions.push(act("Skip", "btn", () => runAndRefresh("decide", { id, decision: "skip" }, refresh)));
  }
  if (p.status === "approved" || p.status === "tailored") {
    actions.push(
      act(p.status === "approved" ? "Tailor CV + letter" : "Re-tailor", p.status === "approved" ? "primary" : "btn", async () => {
        let allowTitleOnly = false;
        if (titleOnly) {
          const r = await ask("No job description yet", [{ name: "allow", type: "checkbox", label: "Tailor from the title only (weaker CV; better: paste the description below)" }], "Tailor");
          if (!r?.allow) return;
          allowTitleOnly = true;
        }
        runAndRefresh("tailor", { id, allowTitleOnly }, refresh, true);
      }),
    );
  }
  if (p.status === "approved" || p.status === "tailored") {
    actions.push(
      act("Mark applied", p.status === "tailored" ? "primary" : "btn", async () => {
        const r = await ask(`Applied to ${p.company}`, [{ name: "note", label: "Where did you apply?", placeholder: "LinkedIn Easy Apply, careers site, email…" }], "Mark applied");
        if (r) runAndRefresh("track", { id, status: "applied", note: r.note }, refresh);
      }),
    );
  }
  const move = (status, label, cls = "btn") =>
    act(label, cls, async () => {
      const r = await ask(`${label}: ${p.company}`, [{ name: "note", label: "Note (optional)" }], label);
      if (r) runAndRefresh("track", { id, status, note: r.note }, refresh);
    });
  if (p.status === "applied") actions.push(move("responded", "They responded", "btn-pass btn"), move("interview", "Interview", "btn-pass btn"), move("rejected", "Rejected", "danger"));
  if (p.status === "responded") actions.push(move("interview", "Interview", "btn-pass btn"), move("rejected", "Rejected", "danger"));
  if (p.status === "interview") actions.push(move("offer", "Offer", "btn-pass btn"), move("rejected", "Rejected", "danger"));
  if (["approved", "tailored"].includes(p.status)) actions.push(act("Skip", "ghost", () => runAndRefresh("decide", { id, decision: "skip", reason: "skipped from applications" }, refresh)));
  actions.push(h("a.btn", { href: p.url, target: "_blank", rel: "noopener noreferrer", style: { textDecoration: "none", color: "inherit" } }, "Open posting"));
  if (d.tailoring?.outputDir) actions.push(act("Open folder", "ghost", () => post("/api/open", { path: d.tailoring.outputDir }).catch((e) => toast(e.message, true))));

  const node = h(
    "div",
    {},
    h("button.ghost.close", { onclick: hideDetail, "aria-label": "Close details" }, "Close"),
    h("h2", {}, p.company),
    h("p.dsub", {}, p.title),
    s ? gauge(s.total, s.recommendation, true) : null,
    h("div.actions", {}, actions),
    h(
      "dl.kv",
      {},
      h("dt", {}, "Status"),
      h("dd", {}, p.status),
      h("dt", {}, "Location"),
      h("dd", {}, unique([p.locationText, p.workMode === "unknown" ? "" : p.workMode, tierLabel(p.locationTier)]).join(" · ")),
      h("dt", {}, "Source"),
      h("dd", {}, `${p.source} · id ${short(p.id)}`),
      p.postedAt ? [h("dt", {}, "Posted"), h("dd", {}, fmtDate(p.postedAt))] : null,
      s ? [h("dt", {}, "Stack"), h("dd", {}, s.primaryStack)] : null,
    ),
  );

  if (s) {
    node.append(h("h3", {}, "Fit"));
    if (s.reasoning) node.append(h("p", {}, s.reasoning));
    if (s.matchedSkills.length) node.append(h("div.tags", { style: { marginBottom: "6px" } }, s.matchedSkills.map((m) => h("span.tag.pass", {}, m))));
    if (s.mustHaveGaps.length) node.append(h("div.tags", { style: { marginBottom: "6px" } }, s.mustHaveGaps.map((g) => h("span.tag.fail", {}, g))));
    if (s.components.penalties.length) node.append(h("div.tags", {}, s.components.penalties.map((x) => h("span.tag.warn", {}, x))));
    const flags = p.flags.filter((f) => /^(lang-required|eligibility-check|years-required|remote-scope-unclear)/.test(f));
    if (flags.length) node.append(h("div.tags", { style: { marginTop: "6px" } }, flags.map((f) => h("span.tag.warn", {}, f.replace(/:/, ": ")))));
  }

  if (titleOnly && !["applied", "responded", "interview", "offer", "rejected"].includes(p.status)) {
    const ta = h("textarea", { id: "desc-input", placeholder: "Paste the full job description from the posting page…" });
    node.append(
      h("h3", {}, "Job description missing"),
      h("p", {}, "The score is a guess from the title. Paste the real description to rescore it and tailor properly."),
      ta,
      h("div.actions", {}, act("Save + rescore", "primary", () => runAndRefresh("describe", { id, description: ta.value }, refresh, true))),
    );
  }

  if (d.files.length) {
    node.append(
      h("h3", {}, "Files"),
      h(
        "div.files",
        {},
        d.files.map((f) => h("div.file", {}, h("a", { href: fileUrl(f.path), target: "_blank", rel: "noopener" }, f.name))),
      ),
    );
  }
  if (d.tailoring) {
    if (d.tailoring.warnings.length) node.append(h("h3", {}, "Check before sending"), h("div.tags", {}, d.tailoring.warnings.map((w) => h("span.tag.warn", {}, w))));
    node.append(
      h("h3", {}, "Cover letter"),
      h("pre.doc", {}, d.tailoring.coverNote),
      h("div.actions", {}, act("Copy letter", "btn", () => copy(d.tailoring.coverNote, "Cover letter copied")), act("Copy summary", "ghost", () => copy(d.tailoring.summary, "Summary copied"))),
    );
  }
  if (d.diff) node.append(h("h3", {}, "diff.md"), h("pre.doc", {}, d.diff));

  if (["tailored", "applied", "responded", "interview"].includes(p.status)) node.append(outreachSection(p, d, refresh));

  if (d.events.length || d.decisions.length) {
    const timeline = [
      ...d.decisions.map((x) => ({ at: x.createdAt, text: `${x.decision}${x.reason ? ` — ${x.reason}` : ""}` })),
      ...d.events.map((x) => ({ at: x.createdAt, text: `${x.fromStatus} → ${x.toStatus}${x.note ? ` — ${x.note}` : ""}` })),
    ].sort((a, b) => new Date(a.at) - new Date(b.at));
    node.append(h("h3", {}, "History"), h("ul.timeline", {}, timeline.map((t) => h("li", {}, h("time", {}, fmtDate(t.at)), h("span", {}, t.text)))));
  }
  if (!titleOnly) node.append(h("h3", {}, "Posting text"), h("pre.doc", {}, p.description));
  showDetail(node);
}

function outreachSection(p, d, refresh) {
  const wrap = h("div", {}, h("h3", {}, "Recruiter outreach"));
  wrap.append(
    h("p", {}, "Find the person:"),
    h("div.tags", { style: { marginBottom: "10px" } }, d.searchLinks.slice(0, 4).map((l) => h("a.tag.info", { href: l.url, target: "_blank", rel: "noopener noreferrer" }, l.label.replace(/^LinkedIn — /, "")))),
  );
  const drafts = d.outreach.filter((o) => o.kind !== "followup");
  const latest = {};
  for (const o of drafts) if (!latest[o.kind]) latest[o.kind] = o;
  const kinds = [
    ["connect", "Connection note"],
    ["message", "LinkedIn message"],
    ["email", "Email"],
  ];
  if (Object.keys(latest).length) {
    wrap.append(
      h(
        "div.stack",
        {},
        kinds
          .filter(([k]) => latest[k])
          .map(([k, label]) => {
            const o = latest[k];
            const text = o.subject ? `${o.subject}\n\n${o.body}` : o.body;
            return h(
              "article.msg",
              {},
              h(
                "header",
                {},
                h("strong", {}, `${label}${o.recipientName ? ` to ${o.recipientName}` : ""}`),
                h("span.tag" + (o.status === "replied" ? ".pass" : o.status === "sent" ? ".info" : ""), {}, o.status === "drafted" ? "draft" : o.status),
              ),
              o.subject ? h("div", {}, h("strong", {}, "Subject: "), o.subject) : null,
              h("div.body", {}, o.body),
              h(
                "div.actions",
                {},
                h("button.btn", { onclick: () => copy(o.subject ? o.body : text, `${label} copied`) }, "Copy"),
                o.subject ? h("button.ghost", { onclick: () => copy(o.subject, "Subject copied") }, "Copy subject") : null,
                o.gmailDraftId ? h("span.tag.info", {}, "in Gmail drafts") : null,
                o.status === "drafted" ? h("button.ghost", { onclick: () => runAndRefresh("outreach-mark", { id: p.id, action: "sent", kind: k }, refresh) }, "I sent it") : null,
                o.status === "sent" ? h("button.ghost", { onclick: () => runAndRefresh("outreach-mark", { id: p.id, action: "replied" }, refresh) }, "They replied") : null,
              ),
            );
          }),
      ),
    );
  }
  wrap.append(
    h(
      "div.actions",
      {},
      h(
        "button." + (drafts.length ? "btn" : "primary"),
        {
          onclick: async () => {
            const r = await ask(`Draft outreach — ${p.company}`, [
              { name: "role", label: "Writing to", type: "select", value: "recruiter", options: [{ value: "recruiter", label: "Recruiter / talent acquisition" }, { value: "hiring-manager", label: "Hiring manager / team lead" }, { value: "engineer", label: "Engineer on the team" }] },
              { name: "to", label: "Their name", placeholder: "Ana Pop", hint: "Leave empty for a neutral greeting" },
              { name: "email", label: "Their email (optional)", type: "email", hint: "Creates a Gmail draft with your tailored CV attached" },
            ], "Draft messages");
            if (r) runAndRefresh("outreach", { id: p.id, ...r }, refresh, true);
          },
        },
        drafts.length ? "Draft again" : "Draft messages",
      ),
    ),
  );
  return wrap;
}

async function runAndRefresh(command, params, refresh, showLog = false) {
  const job = await run(command, params, { showLog }).catch(() => null);
  if (job?.status === "done") await refresh();
}

// ── Outreach view ──
async function viewOutreach() {
  const { queue, recent } = await api("/api/outreach");
  state.items = queue;
  main.replaceChildren(head("Outreach", queue.length ? `${plural(queue.length, "application")} with nobody contacted yet` : "Everyone tailored or applied has been contacted"));
  if (queue.length) {
    main.append(
      h(
        "div.list",
        {},
        queue.map((q, i) =>
          rowButton(
            q,
            i,
            q.score !== null ? gauge(q.score, q.score >= state.thresholds.tailor ? "apply" : q.score >= state.thresholds.review ? "maybe" : "skip") : h("span"),
            h("div.who", {}, h("div.company", {}, q.company), h("div.title", {}, q.title), h("div.meta", {}, q.status)),
            h("div.side", {}, "Select, then Draft messages"),
          ),
        ),
      ),
    );
  }
  if (recent.length) {
    main.append(h("h2.group-title", {}, "Recent messages", h("span.count", {}, String(recent.length))));
    const label = { connect: "Connection note", message: "LinkedIn message", email: "Email", followup: "Follow-up" };
    main.append(
      h(
        "div.stack",
        {},
        recent.slice(0, 30).map((o) =>
          h(
            "article.msg",
            {},
            h("header", {}, h("strong", {}, `${o.company} · ${label[o.kind]}${o.recipientName ? ` to ${o.recipientName}` : ""}`), h("span.tag" + (o.status === "replied" ? ".pass" : o.status === "sent" ? ".info" : ""), {}, o.status === "drafted" ? "draft" : `${o.status} ${fmtDate(o.sentAt)}`)),
            o.body.startsWith("(") ? null : h("div.body", {}, o.subject ? `${o.subject}\n\n${o.body}` : o.body),
            h("div.actions", {}, h("button.ghost", { onclick: () => openPosting(o.postingId) }, "Open application"), o.body.startsWith("(") ? null : h("button.ghost", { onclick: () => copy(o.body) }, "Copy")),
          ),
        ),
      ),
    );
  }
  if (queue.length) select(Math.min(Math.max(state.index, 0), queue.length - 1), { open: wide() });
  else if (!state.detailId) hideDetail();
}

// ── Follow-ups ──
async function viewFollowups() {
  const items = await api("/api/followups");
  state.items = [];
  main.replaceChildren(head("Follow-ups", items.length ? `${plural(items.length, "application")} silent for 7+ days` : "Nothing due"));
  if (!items.length) {
    main.append(h("div.empty", {}, h("p", {}, "No follow-ups due. Applications show up here 7 days after you apply, at most twice.")));
    return;
  }
  main.append(
    h(
      "div.stack",
      {},
      items.map((f) =>
        h(
          "article.msg",
          {},
          h("header", {}, h("strong", {}, `${f.company} — ${f.title}`), h("span.tag.warn", {}, `applied ${f.days}d ago · follow-up ${f.followUps + 1} of 2`)),
          h("div", {}, f.contactEmail ? `Send to ${f.contactEmail}` : f.contact ? `Send on LinkedIn to ${f.contact}` : "No contact yet: find the recruiter first"),
          f.searchLinks.length ? h("div.tags", {}, f.searchLinks.map((l) => h("a.tag.info", { href: l.url, target: "_blank", rel: "noopener noreferrer" }, l.label))) : null,
          h("div", {}, h("strong", {}, "Subject: "), f.message.subject),
          h("div.body", {}, f.message.body),
          h(
            "div.actions",
            {},
            h("button.btn", { onclick: () => copy(f.message.body, "Follow-up copied") }, "Copy message"),
            h("button.ghost", { onclick: () => copy(f.message.subject, "Subject copied") }, "Copy subject"),
            h("button.primary", { onclick: () => runAndRefresh("followup-sent", { id: f.id }, render) }, "I sent it"),
            h("button.danger", { onclick: () => runAndRefresh("track", { id: f.id, status: "rejected", note: "no response" }, render) }, "Give up: no response"),
            h("button.ghost", { onclick: () => openPosting(f.id) }, "Open application"),
          ),
        ),
      ),
    ),
  );
}

// ── Stats ──
async function viewStats() {
  const groups = await api("/api/stats");
  state.items = [];
  hideDetail();
  main.replaceChildren(head("Stats", "Reply rate of applications you sent. Under 10 per row, differences are noise."));
  if (!groups.length) {
    main.append(h("div.empty", {}, h("p", {}, "No applications tracked yet. Mark one as applied to start measuring.")));
    return;
  }
  for (const g of groups) {
    main.append(
      h(
        "table.stats",
        {},
        h("caption", {}, g.label),
        h("thead", {}, h("tr", {}, ["", "Applied", "Replied", "Interview", "Rejected", "Silent", "Reply rate"].map((c) => h("th", { scope: "col" }, c)))),
        h(
          "tbody",
          {},
          g.rows.map((r) => {
            const pos = r.applied ? (r.responded / r.applied) * 100 : 0;
            const neg = r.applied ? (r.rejected / r.applied) * 100 : 0;
            return h(
              "tr",
              {},
              h("td", {}, tierLabel(r.bucket) || "?"),
              [r.applied, r.responded, r.interview, r.rejected, r.silent].map((n) => h("td", {}, String(n))),
              h("td", {}, `${Math.round(pos + neg)}%`, h("span.ratebar", { title: `${Math.round(pos)}% positive, ${Math.round(neg)}% rejected` }, h("span.pos", { style: { width: `${pos}%` } }), h("span.neg", { style: { width: `${neg}%` } }))),
            );
          }),
        ),
      ),
    );
  }
}

// ── Add a job ──
function viewAdd() {
  state.items = [];
  hideDetail();
  const f = (name, label, attrs = {}, hint) => h("div.field", {}, h("label", { htmlFor: `add-${name}` }, label), h("input", { id: `add-${name}`, name, type: "text", ...attrs }), hint ? h("span.hint", {}, hint) : null);
  const form = h(
    "form.form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(e.target).entries());
        const job = await run("add", data, { showLog: true }).catch(() => null);
        if (job?.status === "done") {
          e.target.reset();
          toast(`Added ${data.company}`);
        }
      },
    },
    h("div.field-row", {}, f("company", "Company", { required: true }), f("title", "Job title", { required: true })),
    h(
      "div.field-row",
      {},
      f("location", "Location", { placeholder: "Brașov" }),
      h("div.field", {}, h("label", { htmlFor: "add-mode" }, "Work mode"), h("select", { id: "add-mode", name: "mode" }, ["unknown", "hybrid", "onsite", "remote"].map((m) => h("option", { value: m }, m)))),
    ),
    f("url", "Link", { type: "url", placeholder: "https://… or mailto:hr@company.ro" }),
    h("div.field", {}, h("label", { htmlFor: "add-description" }, "Job description"), h("textarea", { id: "add-description", name: "description", placeholder: "Paste the full posting. With it, the job is scored right away." })),
    f("applied", "Already applied? Where", { placeholder: "Leave empty if not applied yet" }, "Filled in: the job goes straight to Applied for tracking."),
    h("div.actions", {}, h("button.primary", { type: "submit" }, "Add job")),
  );
  main.replaceChildren(head("Add a job", "Found outside the pipeline: recruiter email, referral, Facebook group"), form);
}

// ── Run history ──
async function viewRuns() {
  const jobs = await api("/api/jobs");
  state.items = [];
  hideDetail();
  main.replaceChildren(head("Run history", "Commands started from this window since the UI started"));
  if (!jobs.length) {
    main.append(h("div.empty", {}, h("p", {}, "No commands run yet.")));
    return;
  }
  main.append(
    h(
      "div.list",
      {},
      jobs.map((j) =>
        h(
          "button.row",
          {
            onclick: () => {
              openConsole();
              watch(j.id, true);
            },
          },
          h("span", {}, h("span.dot." + j.status, { style: { display: "inline-block", marginRight: "8px" } }), j.status),
          h("div.who", {}, h("div.company", {}, j.title), h("div.meta", {}, j.startedAt ? new Date(j.startedAt).toLocaleTimeString() : "waiting")),
          h("div.side", {}, j.endedAt && j.startedAt ? `${Math.round((j.endedAt - j.startedAt) / 1000)}s` : ""),
        ),
      ),
    ),
  );
}


// ── Setup: CV import, Gmail, database, keys ──
async function viewSetup() {
  const st = await api("/api/setup");
  state.items = [];
  hideDetail();
  const section = (title, statusTag, ...body) => h("section.msg", {}, h("header", {}, h("strong", {}, title), statusTag), ...body);
  const tag = (cls, text) => h(`span.tag.${cls}`, {}, text);

  // CV
  const fileInput = h("input", { type: "file", accept: ".pdf,.docx,.txt,.md", id: "cv-file" });
  const importBtn = h("button.primary", {
    onclick: async () => {
      const file = fileInput.files?.[0];
      if (!file) return toast("Choose your CV file first", true);
      if (file.size > 10_000_000) return toast("File is larger than 10 MB", true);
      importBtn.disabled = true;
      try {
        const data = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
          r.onerror = () => reject(new Error("Could not read the file"));
          r.readAsDataURL(file);
        });
        const { jobId } = await post("/api/cv/upload", { name: file.name, data });
        openConsole();
        const job = await watch(jobId, false);
        if (job.status === "done") toast("CV imported: review the warnings in the output, then render the base CV");
        render();
      } catch (err) {
        toast(err.message, true);
      } finally {
        importBtn.disabled = false;
      }
    },
  }, "Import with AI");
  const cv = st.cv;
  const cvTag = cv.state === "ok" ? tag("pass", "ready") : cv.state === "example" ? tag("warn", "example data") : cv.state === "invalid" ? tag("fail", "has errors") : tag("fail", "missing");
  const anyKey = st.llm.some((k) => k.set);
  const cvSection = section(
    "Your CV",
    cvTag,
    cv.counts ? h("div", {}, `${cv.name}: ${cv.counts.jobs} jobs, ${cv.counts.projects} projects, ${cv.counts.bullets} bullets, ${cv.counts.skills} skills`) : null,
    cv.state === "example" ? h("div", {}, "This is the fictional example (Alex Popescu). Import your own CV so tailoring uses your real experience.") : null,
    cv.problems ? h("pre.doc", {}, cv.problems.join("\n")) : null,
    h("div", {}, "Import your existing CV (PDF, Word or text). The AI restructures it into data/master-cv.json and flags anything that doesn't match your original; your previous data is backed up first."),
    anyKey ? null : h("div", { style: { color: "var(--warn)" } }, "Needs an LLM API key in .env (Groq or Gemini, both free)."),
    h("div.actions", {}, fileInput, importBtn),
    h(
      "div.actions",
      {},
      h("button.btn", { onclick: () => run("validate-cv", {}, { showLog: true }).then(render) }, "Check CV data"),
      h("button.btn", { onclick: () => run("cv-base", {}, { showLog: true }).then(render) }, "Render base CV"),
      st.baseCvPath ? h("a.btn", { href: fileUrl(st.baseCvPath), target: "_blank", rel: "noopener", style: { textDecoration: "none", color: "inherit" } }, "Open base CV PDF") : null,
    ),
    h("div.hint", { style: { color: "var(--ink-3)", fontSize: "13px" } }, "Edit details by hand in data/master-cv.json; give each summary seed (backend, frontend, ai…) its own angle for sharper tailoring."),
  );

  // Gmail
  const g = st.gmail;
  const gmailTag = g.token ? tag("pass", "connected") : g.credentials ? tag("warn", "not authorized") : tag("info", "optional");
  const gmailSection = section(
    "Gmail job alerts",
    gmailTag,
    h("div", {}, "Reads LinkedIn, eJobs, BestJobs and Indeed alert emails from your Gmail and turns them into postings. Outreach emails can also become Gmail drafts."),
    g.credentials
      ? null
      : h(
          "ol",
          { style: { margin: "0", paddingLeft: "20px", display: "grid", gap: "4px" } },
          h("li", {}, h("a", { href: "https://console.cloud.google.com/projectcreate", target: "_blank", rel: "noopener noreferrer" }, "Create a Google Cloud project"), " (name: job-agent)"),
          h("li", {}, h("a", { href: "https://console.cloud.google.com/apis/library/gmail.googleapis.com", target: "_blank", rel: "noopener noreferrer" }, "Enable the Gmail API")),
          h("li", {}, h("a", { href: "https://console.cloud.google.com/auth/overview", target: "_blank", rel: "noopener noreferrer" }, "Set up the consent screen"), ": app name job-agent, Audience External"),
          h("li", {}, h("a", { href: "https://console.cloud.google.com/auth/audience", target: "_blank", rel: "noopener noreferrer" }, "Add your Gmail as a test user")),
          h("li", {}, h("a", { href: "https://console.cloud.google.com/auth/clients", target: "_blank", rel: "noopener noreferrer" }, "Create an OAuth client"), ": type Desktop app, then Download JSON"),
          h("li", {}, "Click Connect Gmail: the downloaded file is found in your Downloads folder, and Google's consent screen opens. “Google hasn't verified this app” is expected: Continue."),
        ),
    h(
      "div.actions",
      {},
      h("button." + (g.token ? "btn" : "primary"), { onclick: () => run("gmail-setup", { reconnect: g.token }, { showLog: true }).then(render) }, g.token ? "Reconnect / switch account" : "Connect Gmail"),
      g.token ? h("button.ghost", { onclick: () => run("gmail-check", {}, { showLog: true }) }, "Check alert senders") : null,
    ),
    g.token ? h("div", { style: { color: "var(--ink-3)", fontSize: "13px" } }, "Token expires every 7 days while the Google app is in Testing mode: publish it once (Google Cloud → Audience → Publish app) to stop that.") : null,
  );

  // Database + keys + search
  const db = st.database;
  const dbSection = section(
    "Database",
    db.up ? tag("pass", "running") : tag("fail", "stopped"),
    h("div", {}, db.mode === "embedded" ? "Built-in PostgreSQL (data in .pgdata/ inside the app folder)." : db.mode === "docker" ? "Docker container “db”." : "Your own PostgreSQL (DATABASE_URL)."),
    db.up ? null : h("div.actions", {}, h("button.primary", { onclick: () => run("db-up", {}, { showLog: true }).then(render) }, "Start database")),
  );
  const keysSection = section(
    "AI providers",
    anyKey ? tag("pass", "configured") : tag("fail", "no key"),
    h("div.tags", {}, st.llm.map((k) => h(`span.tag.${k.set ? "pass" : ""}`, {}, `${k.name}${k.set ? "" : " (not set)"}`))),
    h("div", { style: { color: "var(--ink-3)", fontSize: "13px" } }, "Keys live in .env. Free keys: console.groq.com/keys and aistudio.google.com/apikey. Restart the app after editing."),
  );
  const searchSection = section(
    "Where you search",
    null,
    h("div", {}, `Home: ${st.home.join(", ") || "not set"} · Relocation: ${st.relocation.join(", ") || "none"}`),
    h("div", { style: { color: "var(--ink-3)", fontSize: "13px" } }, "Change in config/search-config.yaml or re-run npm run setup."),
  );

  main.replaceChildren(head("Setup", "One-time configuration; everything here can be redone safely"), h("div.stack", {}, cvSection, gmailSection, keysSection, dbSection, searchSection));
}

// ── Router ──
const VIEWS = { review: viewReview, apps: viewApps, outreach: viewOutreach, followups: viewFollowups, stats: viewStats, add: viewAdd, runs: viewRuns, setup: viewSetup };

async function render() {
  document.querySelectorAll(".nav a").forEach((a) => (a.dataset.view === state.view ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  try {
    await VIEWS[state.view]();
  } catch (err) {
    main.replaceChildren(head("Can't load this view"), h("div.empty", {}, h("p", {}, err.message), h("button.primary", { onclick: () => run("db-up", {}, { showLog: true }).then(render) }, "Start database")));
  }
}

function route() {
  const view = location.hash.slice(1) || "review";
  if (!VIEWS[view]) return;
  if (view !== state.view) {
    state.index = 0;
    hideDetail();
  }
  state.view = view;
  render();
  main.focus({ preventScroll: true });
}
window.addEventListener("hashchange", route);

// ── Keyboard ──
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select, dialog") || e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === "j" || e.key === "ArrowDown") select(state.index + 1);
  else if (key === "k" || e.key === "ArrowUp") select(state.index - 1);
  else if (e.key === "Escape") hideDetail();
  else if (key === "o") {
    const item = state.items[state.index];
    if (item?.url) window.open(item.url, "_blank", "noopener");
  } else if (state.view === "review" && key === "a") decide("approve", e.shiftKey);
  else if (state.view === "review" && key === "s") decide("skip", e.shiftKey);
  else if (key === "r") render();
  else if (/^[1-8]$/.test(e.key)) location.hash = Object.keys(VIEWS)[Number(e.key) - 1];
  else return;
  e.preventDefault();
});

refreshCounts();
setInterval(refreshCounts, 60_000);
route();
