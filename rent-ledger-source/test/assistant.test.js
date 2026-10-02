// Stage 12: Rent Ledger AI. Basic (rule-based) mode, mocked AI providers,
// approval-gated actions, permissions and privacy of what reaches the model.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { setupEnv, startServer, seedOwnerWorld, tenantLogin } = require("./helpers");

setupEnv({ NOTIFY_MODE: "simulate" });
let ctx, W, tenantToken;
const today = () => require("../lib/dates").localDate("Asia/Kolkata");
const chat = (message, token = W.owner) => ctx.request("POST", "/api/assistant/chat", { token, body: { message } });

before(async () => {
  ctx = await startServer();
  W = await seedOwnerWorld(ctx);
  tenantToken = await tenantLogin(ctx, W);
  await ctx.request("PUT", `/api/tenants/${W.tenant.id}`, { token: W.owner, body: { email: "asha@example.com" } });
  const rent = await ctx.request("POST", "/api/ledger/charges", { token: W.owner, body: { kind: "rent", roomId: W.room.id, tenantId: W.tenant.id, amount: 12000, dueDate: "2026-01-05", month: 1, year: 2026 } });
  assert.equal(rent.status, 201);
});
after(() => ctx.close());

test("status is basic mode by default; tenants can't use the assistant", async () => {
  const s = (await ctx.request("GET", "/api/assistant/status", { token: W.owner })).json;
  assert.equal(s.mode, "basic");
  assert.equal(s.ai.configured, false);
  assert.match(s.dataSharing, /never sent/);
  assert.equal((await ctx.request("GET", "/api/assistant/status", { token: tenantToken })).status, 403);
  assert.equal((await chat("Who is overdue?", tenantToken)).status, 403);
});

test("basic mode answers from the ledger and offers help for anything else", async () => {
  const overdue = (await chat("Who is overdue?")).json;
  assert.equal(overdue.mode, "basic");
  assert.equal(overdue.results[0].tool, "overdue_tenants");
  assert.match(overdue.text, /1 tenant\(s\)/);
  assert.match(overdue.text, /12,000/);
  assert.deepEqual(overdue.results[0].table.rows[0].slice(0, 4), ["Asha", "Sunrise", "1A", "₹12,000"]);

  const bal = (await chat("What is Asha's balance?")).json;
  assert.equal(bal.results[0].tool, "tenant_balance");
  assert.match(bal.text, /outstanding ₹12,000/);
  assert.match(bal.results[0].links[0].href, /statement\?format=html/);

  const leases = (await chat("Which leases are expiring in 30 days?")).json;
  assert.equal(leases.results[0].tool, "lease_expiries");
  assert.equal(leases.results[0].input.days, 30);

  const coll = (await chat("Rent collection for January 2026")).json;
  assert.equal(coll.results[0].tool, "collection_summary");
  assert.equal(coll.results[0].input.month, "2026-01");
  assert.match(coll.text, /billed ₹12,000/);

  const hindi = (await chat("किसका किराया बकाया है?")).json;
  assert.equal(hindi.results[0].tool, "overdue_tenants");

  const help = (await chat("hello there")).json;
  assert.equal(help.results.length, 0);
  assert.match(help.text, /Try one of these/);

  const history = (await ctx.request("GET", "/api/assistant/history", { token: W.owner })).json;
  assert.equal(history.length, 12);
  assert.equal(history[0].role, "user");
  assert.equal(history[1].results[0].tool, "overdue_tenants");
  assert.equal((await ctx.request("DELETE", "/api/assistant/history", { token: W.owner })).status, 200);
  assert.equal((await ctx.request("GET", "/api/assistant/history", { token: W.owner })).json.length, 0);
});

test("reminders are only drafted; sending needs approval and happens exactly once", async () => {
  const out = (await chat("Draft reminders for overdue tenants")).json;
  const action = out.results[0].action;
  assert.equal(action.type, "send_reminders");
  assert.equal(action.status, "proposed");
  assert.equal(action.payload.messages.length, 1);
  assert.equal(action.payload.messages[0].channel, "inapp");
  assert.equal((await ctx.request("GET", "/api/outbox", { token: W.owner })).json.length, 0, "nothing queued before approval");

  const edited = await ctx.request("PUT", `/api/assistant/actions/${action.id}`, { token: W.owner, body: { messages: [{ index: 0, body: "Hi Asha, gentle reminder: ₹12,000 for January is overdue." }] } });
  assert.equal(edited.json.payload.messages[0].body, "Hi Asha, gentle reminder: ₹12,000 for January is overdue.");

  const approved = await ctx.request("POST", `/api/assistant/actions/${action.id}/approve`, { token: W.owner });
  assert.equal(approved.status, 200);
  assert.equal(approved.json.status, "executed");
  assert.equal(approved.json.result.queued, 1);
  assert.equal((await ctx.request("POST", `/api/assistant/actions/${action.id}/approve`, { token: W.owner })).status, 409, "can't approve twice");
  await new Promise((r) => setTimeout(r, 50));
  const notes = (await ctx.request("GET", "/api/notifications", { token: tenantToken })).json;
  const list = Array.isArray(notes) ? notes : notes.items;
  assert.equal(list.filter((n) => /gentle reminder/.test(n.body)).length, 1);
  const actions = (await ctx.request("GET", "/api/assistant/actions?status=executed", { token: W.owner })).json;
  assert.equal(actions.length, 1);
  const auditRows = (await ctx.request("GET", "/api/audit", { token: W.owner })).json;
  assert.ok(auditRows.some((a) => a.action === "assistant.action_approved"));
});

test("expense and maintenance proposals: approve creates, reject doesn't; managers follow permissions", async () => {
  const exp = (await chat("Add expense ₹2,500 for plumbing repair at Sunrise")).json;
  const a = exp.results[0].action;
  assert.equal(a.type, "create_expense");
  assert.equal(a.payload.amountPaise, 250000);
  assert.equal(a.payload.category, "repairs");
  assert.equal((await ctx.request("GET", "/api/expenses", { token: W.owner })).json.items?.length ?? (await ctx.request("GET", "/api/expenses", { token: W.owner })).json.length, 0);
  await ctx.request("PUT", `/api/assistant/actions/${a.id}`, { token: W.owner, body: { amount: 2600, vendor: "Ravi Plumbing" } });
  const done = (await ctx.request("POST", `/api/assistant/actions/${a.id}/approve`, { token: W.owner })).json;
  assert.equal(done.status, "executed");
  const expenses = (await ctx.request("GET", "/api/expenses", { token: W.owner })).json;
  const rows = Array.isArray(expenses) ? expenses : expenses.items;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 2600);
  assert.equal(rows[0].vendor, "Ravi Plumbing");

  const mt = (await chat("Create maintenance task at Sunrise room 1A: fix the leaking tap")).json;
  const m = mt.results[0].action;
  assert.equal(m.type, "create_maintenance");
  assert.equal(m.payload.title, "fix the leaking tap");
  assert.equal(m.payload.roomLabel, "1A");
  const rejected = (await ctx.request("POST", `/api/assistant/actions/${m.id}/reject`, { token: W.owner })).json;
  assert.equal(rejected.status, "rejected");
  const reqs = (await ctx.request("GET", "/api/maintenance", { token: W.owner })).json;
  assert.equal((Array.isArray(reqs) ? reqs : reqs.items).length, 0);

  // A manager can use the assistant and approve operational proposals.
  const invite = (await ctx.request("POST", "/api/team/invites", { token: W.owner, body: { name: "Meera", contact: "meera@example.com" } })).json;
  const manager = (await ctx.request("POST", "/api/auth/signup", { ip: ctx.freshIp(), body: { name: "Meera", contact: "meera@example.com", password: "manager-pass-1", role: "manager", inviteCode: invite.code } })).json.token;
  const mt2 = (await chat("Create maintenance task at Sunrise: replace corridor bulb", manager)).json;
  const ok = await ctx.request("POST", `/api/assistant/actions/${mt2.results[0].action.id}/approve`, { token: manager });
  assert.equal(ok.json.status, "executed");
  assert.ok(ok.json.result.maintenanceRequestId);
});

test("the assistant has no tool that changes money records", () => {
  const { TOOLS } = require("../services/assistant/tools");
  const names = Object.keys(TOOLS);
  for (const n of names) assert.doesNotMatch(n, /payment|waive|void|reverse|refund|adjust|delete/i, n);
  const prepares = names.filter((n) => TOOLS[n].prepare);
  assert.deepEqual(prepares.sort(), ["draft_overdue_reminders", "prepare_expense", "prepare_maintenance_task"]);
});

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body), raw: init.body });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { ok: true, status: 200, text: async () => JSON.stringify(next) };
  };
  fn.calls = calls;
  return fn;
}

test("AI mode (mocked Anthropic API): tools run locally, contact details never sent, proposals still need approval", async () => {
  Object.assign(process.env, { AI_PROVIDER: "anthropic", AI_API_KEY: "test-key", AI_MODEL: "test-model" });
  try {
    let s = (await ctx.request("GET", "/api/assistant/status", { token: W.owner })).json;
    assert.equal(s.mode, "basic", "configured but not switched on by the owner");
    await ctx.request("PUT", "/api/org", { token: W.owner, body: { settings: { assistant: { aiEnabled: true } } } });
    s = (await ctx.request("GET", "/api/assistant/status", { token: W.owner })).json;
    assert.equal(s.mode, "ai");
    assert.equal(s.ai.provider, "anthropic");
    assert.equal(s.ai.key, undefined, "the key is never returned");

    const assistant = require("../services/assistant");
    const owner = ctx.db.get("SELECT * FROM users WHERE id = ?", W.ownerUser.id);
    const sctx = { orgId: owner.org_id, userId: owner.id, role: owner.role };
    const f = fakeFetch([
      { content: [{ type: "tool_use", id: "tu_1", name: "overdue_tenants", input: {} }], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "Asha has ₹12,000 overdue since 5 January." }], stop_reason: "end_turn" },
    ]);
    const out = await assistant.chat(ctx.db, sctx, owner, "Who hasn't paid?", today(), { fetchImpl: f });
    assert.equal(out.mode, "ai");
    assert.equal(out.text, "Asha has ₹12,000 overdue since 5 January.");
    assert.equal(out.results[0].tool, "overdue_tenants");
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].url, "https://api.anthropic.com/v1/messages");
    assert.equal(f.calls[0].headers["x-api-key"], "test-key");
    assert.equal(f.calls[0].body.model, "test-model");
    assert.ok(f.calls[0].body.tools.some((t) => t.name === "overdue_tenants"));
    assert.match(f.calls[0].body.system, /Never estimate or invent figures/);
    const toolResult = f.calls[1].body.messages.at(-1).content[0];
    assert.equal(toolResult.type, "tool_result");
    assert.match(toolResult.content, /12,000/);
    for (const c of f.calls) {
      assert.doesNotMatch(c.raw, /9876543210|asha@example\.com/, "no phone numbers or emails reach the AI provider");
    }

    // A prepare tool called by the model still only creates a proposal.
    const before = ctx.db.get("SELECT COUNT(*) AS n FROM outbox").n;
    const f2 = fakeFetch([
      { content: [{ type: "tool_use", id: "tu_2", name: "draft_overdue_reminders", input: {} }], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "I've drafted a reminder for Asha. Approve it to send." }], stop_reason: "end_turn" },
    ]);
    const out2 = await assistant.chat(ctx.db, sctx, owner, "Remind everyone who is late", today(), { fetchImpl: f2 });
    assert.equal(out2.results[0].action.status, "proposed");
    assert.equal(out2.results[0].action.payload.messages.length, 1);
    assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM outbox").n, before, "nothing queued by the model");
    assert.match(f2.calls[1].raw, /waiting for the owner's approval/);

    // Provider down: answer falls back to basic mode, clearly labelled.
    const f3 = fakeFetch([new Error("connect ECONNREFUSED")]);
    const out3 = await assistant.chat(ctx.db, sctx, owner, "Who is overdue?", today(), { fetchImpl: f3 });
    assert.equal(out3.mode, "basic");
    assert.match(out3.notice, /basic mode/);
    assert.equal(out3.results[0].tool, "overdue_tenants");

    // A manager's AI session only gets tools their role allows.
    const toolsForManager = Object.keys(assistant.toolsFor({ role: "manager" }));
    assert.ok(toolsForManager.includes("draft_overdue_reminders"));
    assert.equal(Object.keys(assistant.toolsFor({ role: "tenant" })).length, 0);
  } finally {
    Object.assign(process.env, { AI_PROVIDER: "", AI_API_KEY: "", AI_MODEL: "" });
  }
});

test("AI mode (mocked OpenAI-compatible API)", async () => {
  Object.assign(process.env, { AI_PROVIDER: "openai", AI_API_KEY: "sk-test", AI_MODEL: "test-model", AI_BASE_URL: "https://llm.example.com/v1" });
  try {
    const assistant = require("../services/assistant");
    const owner = ctx.db.get("SELECT * FROM users WHERE id = ?", W.ownerUser.id);
    const sctx = { orgId: owner.org_id, userId: owner.id, role: owner.role };
    const f = fakeFetch([
      { choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "collection_summary", arguments: "{\"month\":\"2026-01\"}" } }] } }] },
      { choices: [{ message: { content: "January: ₹12,000 billed, nothing collected yet." } }] },
    ]);
    const out = await assistant.chat(ctx.db, sctx, owner, "How was January?", today(), { fetchImpl: f });
    assert.equal(out.mode, "ai");
    assert.equal(f.calls[0].url, "https://llm.example.com/v1/chat/completions");
    assert.equal(f.calls[0].headers.authorization, "Bearer sk-test");
    assert.equal(f.calls[1].body.messages.at(-1).role, "tool");
    assert.equal(out.results[0].input.month, "2026-01");
    assert.match(out.results[0].summary, /billed ₹12,000/);
  } finally {
    Object.assign(process.env, { AI_PROVIDER: "", AI_API_KEY: "", AI_MODEL: "", AI_BASE_URL: "" });
  }
});

test("chat input is validated and rate limited", async () => {
  assert.equal((await chat("")).status, 400);
  assert.equal((await chat("x".repeat(1001))).status, 400);
  ctx.limits.assistantPerUser.clear();
  const owner = W.ownerUser.id;
  for (let i = 0; i < 60; i++) ctx.limits.assistantPerUser.hit(owner);
  const limited = await chat("Who is overdue?");
  assert.equal(limited.status, 429);
  ctx.limits.assistantPerUser.clear();
});
