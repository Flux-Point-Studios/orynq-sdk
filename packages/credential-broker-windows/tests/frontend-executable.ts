import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const manifest = fileURLToPath(new URL("../native/Cargo.toml", import.meta.url));
const executable = fileURLToPath(new URL("../native/target/debug/orynq-pipe-frontend.exe", import.meta.url));
let built = false;

/** Builds the sidecar on first use, so importing this helper needs no cargo off Windows. */
export function frontendExecutable(): string {
  if (!built) {
    execFileSync("cargo", ["build", "--locked", "--quiet", "--manifest-path", manifest], { stdio: "inherit" });
    built = true;
  }
  return executable;
}
