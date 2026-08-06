/**
 * Cursor beforeShellExecution gate — lethal-triad hardening.
 * Deny when command text contains secret-path markers; ask on risky egress.
 */

export function normalizeCommand(command) {
  return String(command ?? "")
    .toLowerCase()
    .replace(/\\/g, "/");
}

/** Strip `.env*.example` path tokens so they do not trip the `.env` matcher. */
export function stripEnvExamples(normalized) {
  return normalized.replace(/(?:^|[\s/"'])\.env[^/\s"']*\.example(?=[\s/"']|$)/g, " ");
}

export function hasEnvSecretMarker(normalized) {
  const withoutExamples = stripEnvExamples(normalized);
  // Path segment or bare token starting with .env (e.g. /.env, /.env.local, `.env`)
  return /(?:^|[\s/"'])\.env(?![\w.-]*\.example\b)/.test(withoutExamples) || /\/\.env(?![\w.-]*\.example\b)/.test(withoutExamples);
}

export function hasPemPathMarker(normalized) {
  // Path-like *.pem only — not the substring "pem" inside words (pem_roundtrip).
  return /(?:^|[\s/"'])[^/\s"']*\.pem(?:[\s/"']|$)/.test(normalized) || /\/[^/\s"']+\.pem(?:[\s/"']|$)/.test(normalized);
}

const SECRET_SUBSTRINGS = [
  "local/.flora/",
  "secrets-rotation",
  ".secret",
  "broadcast.env",
  "backend/secrets/",
  "ensure-shared-dev-jwt",
  "credentials.json",
  "service-account",
];

export function hasSecretMarker(normalized) {
  for (const marker of SECRET_SUBSTRINGS) {
    if (normalized.includes(marker)) return true;
  }
  if (hasPemPathMarker(normalized)) return true;
  if (hasEnvSecretMarker(normalized)) return true;
  return false;
}

const GH_ALLOWLIST = [
  /^gh\s+pr\s+view(?:\s|$)/,
  /^gh\s+pr\s+list(?:\s|$)/,
  /^gh\s+pr\s+checks(?:\s|$)/,
  /^gh\s+pr\s+diff(?:\s|$)/,
  /^gh\s+issue\s+view(?:\s|$)/,
  /^gh\s+issue\s+list(?:\s|$)/,
  /^gh\s+run\s+view(?:\s|$)/,
  /^gh\s+run\s+list(?:\s|$)/,
  /^gh\s+status(?:\s|$)/,
  /^gh\s+auth\s+status(?:\s|$)/,
];

export function isGhAllowlisted(normalized) {
  const trimmed = normalized.trim();
  return GH_ALLOWLIST.some((re) => re.test(trimmed));
}

export function needsEgressAsk(normalized) {
  if (/\bcurl\b/.test(normalized)) return true;
  if (/\bwget\b/.test(normalized)) return true;
  if (/\binvoke-webrequest\b/.test(normalized)) return true;
  if (/\binvoke-restmethod\b/.test(normalized)) return true;
  if (/(?:^|[\s|;|&])iwr(?:\s|$)/.test(normalized)) return true;
  if (/\bgit\s+push\b/.test(normalized)) return true;
  if (/\bgit\s+send-email\b/.test(normalized)) return true;
  if (/(?:^|[\s|;|&])gh\s+/.test(normalized) && !isGhAllowlisted(normalized)) {
    return true;
  }
  return false;
}

/**
 * @returns {"allow" | "deny" | "ask"}
 */
export function classifyShellCommand(command) {
  const normalized = normalizeCommand(command);
  if (hasSecretMarker(normalized)) return "deny";
  if (needsEgressAsk(normalized)) return "ask";
  return "allow";
}

export function shellDecision(command) {
  const permission = classifyShellCommand(command);
  if (permission === "deny") {
    return {
      permission: "deny",
      user_message:
        "Blocked: command references a secret path (Local/.flora, .env, SECRETS, etc.). Run secret scripts in your own terminal, not via Agent.",
      agent_message:
        "Shell command denied by Flora lethal-triad gate: secret-path marker in argv. Do not read or dump Local/ secrets; ask the user to run Scripts/ensure-shared-dev-jwt.ps1 themselves if needed.",
    };
  }
  if (permission === "ask") {
    return {
      permission: "ask",
      user_message:
        "This shell command may exfiltrate data (network / git push / non-readonly gh). Approve only if intentional.",
      agent_message:
        "Egress-sensitive shell command requires user approval (curl/wget/IWR/git push/gh).",
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
    const decision = shellDecision(input.command ?? "");
    console.log(JSON.stringify(decision));
  } catch (err) {
    const preview = err?.preview ? ` preview=${JSON.stringify(err.preview)}` : "";
    console.log(
      JSON.stringify({
        permission: "deny",
        user_message: `gate-shell: invalid JSON on stdin${preview}`,
        agent_message: "Shell gate failed to parse hook input; denying closed.",
      }),
    );
  }
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  /gate-shell\.mjs$/i.test(String(process.argv[1]).replace(/\\/g, "/"));

if (isDirectRun) {
  main().catch((err) => {
    console.log(
      JSON.stringify({
        permission: "deny",
        user_message: `gate-shell error: ${err?.message ?? err}`,
        agent_message: "Shell gate crashed; failClosed deny.",
      }),
    );
  });
}
