import assert from "node:assert/strict";
import test from "node:test";
import { classifyShellCommand } from "./gate-shell.mjs";

const cases = [
  ["Get-Content Local/.flora/dev-jwt.secret", "deny"],
  ['node -e "fs.readFileSync(\'Local/.flora/dev-jwt.secret\')"', "deny"],
  ["python -c \"open(r'Local\\\\SECRETS-ROTATION.local.md')\"", "deny"],
  ['pwsh -Command "Get-Content Scripts/broadcast.env"', "deny"],
  [".\\Scripts\\ensure-shared-dev-jwt.ps1", "deny"],
  ["Get-Content Apps/Mobile/.env", "deny"],
  ["Get-Content Apps/Mobile/.env.example", "allow"],
  ["type Apps\\Web\\.env.example", "allow"],
  ["Get-Content Apps/Mobile/.env.example Local/.flora/dev-jwt.secret", "deny"],
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
