/**
 * Cursor beforeMCPExecution gate — ask on network/exfil-capable MCP servers/tools.
 */

const ASK_TOKENS = [
  "github",
  "playwright",
  "browser",
  "fetch",
  "slack",
  "email",
  "smtp",
  "webhook",
];

export function classifyMcp({ server = "", tool_name = "", url = "", command = "" } = {}) {
  const haystack = [server, tool_name, url, command].join(" ").toLowerCase();
  if (ASK_TOKENS.some((t) => haystack.includes(t))) return "ask";
  return "allow";
}

export function mcpDecision(input = {}) {
  const permission = classifyMcp(input);
  if (permission === "ask") {
    return {
      permission: "ask",
      user_message:
        "MCP tool may reach the network or external services (github/playwright/fetch/…). Approve only if intentional.",
      agent_message:
        "Egress-sensitive MCP call requires user approval (lethal-triad gate).",
    };
  }
  return { permission: "allow" };
}

function parseHookInput(raw) {
  const text = String(raw ?? "")
    .replace(/^\uFEFF/, "")
    .trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    const err = new Error("invalid_json");
    err.preview = text.slice(0, 160);
    throw err;
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const raw = await readStdin();
  try {
    const input = parseHookInput(raw);
    const decision = mcpDecision({
      server: input.server ?? "",
      tool_name: input.tool_name ?? "",
      url: input.url ?? "",
      command: input.command ?? "",
    });
    console.log(JSON.stringify(decision));
  } catch (err) {
    const preview = err?.preview ? ` preview=${JSON.stringify(err.preview)}` : "";
    console.log(
      JSON.stringify({
        permission: "deny",
        user_message: `gate-mcp: invalid JSON on stdin${preview}`,
        agent_message: "MCP gate failed to parse hook input; denying closed.",
      }),
    );
  }
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  /gate-mcp\.mjs$/i.test(String(process.argv[1]).replace(/\\/g, "/"));

if (isDirectRun) {
  main().catch((err) => {
    console.log(
      JSON.stringify({
        permission: "deny",
        user_message: `gate-mcp error: ${err?.message ?? err}`,
        agent_message: "MCP gate crashed; failClosed deny.",
      }),
    );
  });
}
