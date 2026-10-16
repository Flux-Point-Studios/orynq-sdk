import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { MidnightNetwork } from "@fluxpointstudios/orynq-sdk-anchors-midnight";

// True in a process that carries Claude Code's environment (CLAUDECODE or a CLAUDE_CODE_*
// variable): an agent session that starts a script or loads a key as it is. It is an accident
// guard, not a boundary: code running as deci can drop those variables.
export const agentDriven = (env: NodeJS.ProcessEnv = process.env) => Object.keys(env).some((name) => name === "CLAUDECODE" || name.startsWith("CLAUDE_CODE_"));

// The FPS mainnet keys by their public halves, as recorded when they were made: the relay's author
// key and the kind-2 salt key's id. Off mainnet an operator refuses a key file holding one of
// them wherever it lives, so a copy or a hard link is refused like the original.
export const MAINNET_AUTHOR_KEYS: readonly string[] = ["6a140f2346ec16bc587b506e3d447f05ddcc9bdd72778bee578767571b061f08"];
export const MAINNET_SALT_KEY_IDS: readonly string[] = ["448a1b1a6a289af3e432a9533af92250b92f8b7c91768f60b87a9de90df2ee41"];

// Refuses, off mainnet, a file inside ~/.secrets/orynq-midnight-mainnet, where the FPS mainnet
// keys and mnemonic live, however the path reaches it (a symlinked directory, ".."), before the
// file is opened.
export function refuseMainnetSecretsPath(network: MidnightNetwork, file: string): void {
  if (network === "mainnet") return;
  const real = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
  const inside = relative(real(join(homedir(), ".secrets", "orynq-midnight-mainnet")), real(file));
  if (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) {
    throw new Error(`${file} lies in the FPS mainnet secrets directory; a ${network} process never opens it`);
  }
}
