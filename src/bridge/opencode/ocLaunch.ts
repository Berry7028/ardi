// How Ardi launches opencode: one `opencode serve` per chat's bridge, on a
// random localhost port, in Ardi's shared working folder so its sessions are
// stored beside pi's.

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { PiCheck } from "../protocol";
import { spawnable, type Spawnable } from "../runtime/spawnable";
import { WORK_DIR } from "../launch";

// The user's opencode path (`~` expanded), or the `opencode` on PATH.
export function opencodeCommand(opencodePath?: string): string {
  const trimmed = opencodePath?.trim();
  const path = trimmed && /^~(?=[\\/]|$)/.test(trimmed) ? join(homedir(), trimmed.slice(1)) : trimmed;
  if (!path) return process.env.ARDI_OPENCODE_BIN || "opencode";
  if (!existsSync(path)) throw new Error(`OpenCode not found at ${path}. Fix the path in Settings.`);
  if (!statSync(path).isFile()) throw new Error(`${path} is not a file. Fix the path in Settings.`);
  return path;
}

// `opencode serve`, from which the port is read off its output.
export function buildServeSpec(opencodePath?: string): Spawnable & { cwd: string } {
  return { ...spawnable(opencodeCommand(opencodePath), ["serve", "--port", "0", "--hostname", "127.0.0.1"]), cwd: WORK_DIR };
}

// Runs `opencode --version`, for the settings view.
export function checkOpenCode(opencodePath?: string): Promise<PiCheck> {
  let command = opencodePath ?? "";
  let run: Spawnable;
  try {
    command = opencodeCommand(opencodePath);
    run = spawnable(command, ["--version"]);
  } catch (error) {
    return Promise.resolve({ command, error: (error as Error).message });
  }
  return new Promise((done) => {
    execFile(run.command, run.args, { timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => {
      done(error ? { command, error: stderr.trim() || error.message } : { command, version: stdout.trim() });
    });
  });
}
