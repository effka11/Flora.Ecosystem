import fs from "node:fs";
import path from "node:path";

const txtPath = path.join(__dirname, "../lib/fscp/recoveryWordlistEnV1.txt");
const outPath = path.join(__dirname, "../lib/fscp/recoveryWordlistEnV1.ts");
const words = fs.readFileSync(txtPath, "utf8").trim().split(/\r?\n/);
const body = `export const RECOVERY_WORDLIST_EN_V1: readonly string[] = ${JSON.stringify(words)} as const;
export const RECOVERY_WORDLIST_ID = "flora-recovery-en-v1";
export const RECOVERY_WORDS_COUNT = 12;
`;
fs.writeFileSync(outPath, body);
console.log(`Wrote ${words.length} words to ${outPath}`);
