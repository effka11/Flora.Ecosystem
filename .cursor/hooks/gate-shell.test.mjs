import assert from "node:assert/strict";
import test from "node:test";
import { classifyShellCommand } from "./gate-shell.mjs";

const cases = [
  ["Get-Content local/.flora/dev-jwt.secret", "deny"],
  ['node -e "fs.readFileSync(\'local/.flora/dev-jwt.secret\')"', "deny"],
  ["python -c \"open(r'local\\\\SECRETS-ROTATION.local.md')\"", "deny"],
  ['pwsh -Command "Get-Content scripts/broadcast.env"', "deny"],
  [".\\scripts\\ensure-shared-dev-jwt.ps1", "deny"],
  ["Get-Content apps/Mobile/.env", "deny"],
  ["Get-Content apps/Mobile/.env.example", "allow"],
  ["type apps\\Web\\.env.example", "allow"],
  ["Get-Content apps/Mobile/.env.example local/.flora/dev-jwt.secret", "deny"],
  ["openssl x509 -in tmp/leaf.pem -noout", "deny"],
  ["cargo test pem_roundtrip --lib", "allow"],
  ["cargo test -p flora-shared --lib", "allow"],
  ["npm run typecheck", "allow"],
  ["curl https://example.com", "ask"],
  ["git push origin HEAD", "ask"],
  ["gh pr view 1", "allow"],
  ["gh pr create --title x", "ask"],
];

for (const [command, expected] of cases) {
  test(`shell: ${expected} ← ${command}`, () => {
    assert.equal(classifyShellCommand(command), expected);
  });
}
