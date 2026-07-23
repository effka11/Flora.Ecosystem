import { spawnSync } from "node:child_process";
import process from "node:process";

const platform = (process.env.EAS_BUILD_PLATFORM ?? "").toLowerCase();
if (!platform) process.exit(0);

const command =
  platform === "ios"
    ? ["bash", ["Scripts/build-fscp-mobile-ios.sh"]]
    : platform === "android"
      ? ["bash", ["Scripts/build-fscp-mobile-android.sh"]]
      : null;

if (!command) process.exit(0);
const result = spawnSync(command[0], command[1], {
  cwd: new URL("..", import.meta.url),
  stdio: "inherit",
  shell: false,
});
process.exit(result.status ?? 1);
