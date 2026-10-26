import { existsSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { MidnightNetwork } from "@fluxpointstudios/orynq-sdk-anchors-midnight";

// An accident guard, not a boundary against code that can change its own environment.
export const agentDriven = (env: NodeJS.ProcessEnv = process.env) =>
  Object.keys(env).some(
    (name) => name === "CLAUDECODE" || name.startsWith("CLAUDE_CODE_") || name === "CODEX_THREAD_ID" || name === "CODEX_SESSION_ID" || name === "CODEX_CI" || name.startsWith("CODEX_MANAGED_BY_"),
  );

// The FPS mainnet keys by their public halves, as recorded when they were made: the relay's author
// key and the kind-2 salt key's id. Off mainnet an operator refuses a key file holding one of
// them wherever it lives, so a copy or a hard link is refused like the original.
export const MAINNET_AUTHOR_KEYS: readonly string[] = ["6a140f2346ec16bc587b506e3d447f05ddcc9bdd72778bee578767571b061f08"];
export const MAINNET_BATCH_AUTHOR_KEYS: readonly string[] = ["067513ff2f976554098feecb3555197255b71f26a48ad6b1828ade967b746a39"];
export const RETIRED_AUTHOR_KEYS: readonly string[] = ["6a140f2346ec16bc587b506e3d447f05ddcc9bdd72778bee578767571b061f08"];
export const MAINNET_SALT_KEY_IDS: readonly string[] = ["448a1b1a6a289af3e432a9533af92250b92f8b7c91768f60b87a9de90df2ee41"];

// Refuses, off mainnet, a file inside ~/.secrets/orynq-midnight-mainnet, where the FPS mainnet
// keys and mnemonic live, however the path reaches it (a symlinked directory, ".."), before the
// file is opened.
export function refuseMainnetSecretsPath(network: MidnightNetwork, file: string): void {
  if (network === "mainnet") return;
  const real = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
  // homedir() follows HOME; userInfo() uses the operating system account record instead.
  // Keep both roots protected so moving HOME cannot redirect the mainnet secrets guard.
  const homes = new Set([homedir(), userInfo().homedir]);
  for (const home of homes) {
    const inside = relative(real(join(home, ".secrets", "orynq-midnight-mainnet")), real(file));
    if (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) {
      throw new Error(`${file} lies in the FPS mainnet secrets directory; a ${network} process never opens it`);
    }
  }
}
