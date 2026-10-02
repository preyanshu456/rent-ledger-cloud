// AI model providers for the assistant. Off unless configured:
//   AI_PROVIDER = anthropic | openai   (openai = any OpenAI-compatible chat API)
//   AI_API_KEY  (or ANTHROPIC_API_KEY for anthropic)
//   AI_MODEL    = the model name your provider gives you (required - no default)
//   AI_BASE_URL = optional, for OpenAI-compatible services or a proxy
// The owner must also switch AI on in Settings. The model only ever sees the
// question and the results of the read/prepare tools (names, room labels,
// dates, amounts) - never phone numbers, emails, ID numbers or documents.

class AiError extends Error {}

function aiConfig(env = process.env) {
  const provider = String(env.AI_PROVIDER || (env.ANTHROPIC_API_KEY ? "anthropic" : "")).trim().toLowerCase();
  const key = env.AI_API_KEY || (provider === "anthropic" ? env.ANTHROPIC_API_KEY : "") || "";
  const model = String(env.AI_MODEL || "").trim();
  const baseUrl = String(env.AI_BASE_URL || (provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1")).replace(/\/+$/, "");
  const supported = provider === "anthropic" || provider === "openai";
  return { provider, model, baseUrl, hasKey: Boolean(key), key, configured: supported && Boolean(key) && Boolean(model) };
}

function publicConfig(cfg = aiConfig()) {
  return { provider: cfg.provider || null, model: cfg.model || null, configured: cfg.configured };
}

async function postJson(fetchImpl, url, headers, body, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: controller.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) throw new AiError(`AI provider returned ${res.status}${json?.error?.message ? `: ${String(json.error.message).slice(0, 200)}` : ""}`);
    if (!json) throw new AiError("AI provider returned an unreadable response.");
    return json;
  } catch (err) {
    if (err instanceof AiError) throw err;
    throw new AiError(err.name === "AbortError" ? "AI provider timed out." : `AI provider unreachable: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// Runs a tool-using conversation. `callTool(name, input)` executes a tool and
// returns a JSON-serialisable result. Returns { text, toolCalls }.
async function runConversation({ cfg = aiConfig(), system, history, message, tools, callTool, fetchImpl = fetch, maxRounds = 5 }) {
  if (!cfg.configured) throw new AiError("AI is not configured.");
  const toolCalls = [];
  if (cfg.provider === "anthropic") {
    const messages = [...history.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: message }];
    const toolDefs = Object.entries(tools).map(([name, t]) => ({ name, description: t.description, input_schema: t.schema }));
    for (let round = 0; round < maxRounds; round++) {
      const out = await postJson(fetchImpl, `${cfg.baseUrl}/v1/messages`, { "x-api-key": cfg.key, "anthropic-version": "2023-06-01" },
        { model: cfg.model, max_tokens: 1200, system, messages, tools: toolDefs });
      const content = Array.isArray(out.content) ? out.content : [];
      const uses = content.filter((c) => c.type === "tool_use");
      const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
      if (!uses.length || out.stop_reason !== "tool_use") return { text: text || "(no answer)", toolCalls };
      messages.push({ role: "assistant", content });
      const results = [];
      for (const u of uses) {
        const result = await callTool(u.name, u.input || {});
        toolCalls.push({ name: u.name, input: u.input || {}, result });
        results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(result).slice(0, 20_000) });
      }
      messages.push({ role: "user", content: results });
    }
    throw new AiError("The AI needed too many steps for this question.");
  }

  // OpenAI-compatible chat completions.
  const messages = [{ role: "system", content: system }, ...history.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: message }];
  const toolDefs = Object.entries(tools).map(([name, t]) => ({ type: "function", function: { name, description: t.description, parameters: t.schema } }));
  for (let round = 0; round < maxRounds; round++) {
    const out = await postJson(fetchImpl, `${cfg.baseUrl}/chat/completions`, { authorization: `Bearer ${cfg.key}` },
      { model: cfg.model, messages, tools: toolDefs, max_tokens: 1200 });
    const msg = out.choices?.[0]?.message;
    if (!msg) throw new AiError("AI provider returned no message.");
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!calls.length) return { text: String(msg.content || "").trim() || "(no answer)", toolCalls };
    messages.push({ role: "assistant", content: msg.content || null, tool_calls: calls });
    for (const c of calls) {
      let input = {};
      try { input = JSON.parse(c.function?.arguments || "{}"); } catch { input = {}; }
      const result = await callTool(c.function?.name, input);
      toolCalls.push({ name: c.function?.name, input, result });
      messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(result).slice(0, 20_000) });
    }
  }
  throw new AiError("The AI needed too many steps for this question.");
}

module.exports = { aiConfig, publicConfig, runConversation, AiError };
