import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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

const whoami = (...args: string[]) =>
  execFileSync(`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\whoami.exe`, args, { encoding: "utf8" });

/** The SID of this test's account, which owns every pipe a sidecar it spawns creates. */
export const ownSid = (): string => whoami("/user", "/fo", "csv", "/nh").trim().split(",")[1]!.replaceAll('"', "");

export const pipeName = (): string => `\\\\.\\pipe\\orynq-broker-test-${randomBytes(6).toString("hex")}`;
