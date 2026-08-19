#!/usr/bin/env node
/**
 * Run the Django API and the web app together, with prefixed interleaved output.
 * Ctrl+C stops both.
 *
 *   npm run dev
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backend = join(root, "backend");
const frontend = join(root, "frontend");
const isWindows = process.platform === "win32";
const venvPython = isWindows
  ? join(backend, ".venv", "Scripts", "python.exe")
  : join(backend, ".venv", "bin", "python");
const npm = isWindows ? "npm.cmd" : "npm";

if (!existsSync(venvPython)) {
  console.error("\nBackend virtualenv not found. Run:  npm run setup\n");
  process.exit(1);
}
if (!existsSync(join(backend, "artifacts", "models.joblib"))) {
  console.warn(
    "\n\x1b[33mModels are not trained — predictions will be unavailable.\x1b[0m\nRun:  npm run train\n"
  );
}
if (!existsSync(join(backend, "echosense.sqlite3"))) {
  console.warn("\n\x1b[33mNo database found.\x1b[0m\nRun:  npm run seed\n");
}

const children = [];
let shuttingDown = false;

function start(label, color, command, args, cwd) {
  // Node 20+ refuses to spawn .cmd/.bat without a shell on Windows.
  const needsShell = isWindows && /\.(cmd|bat)$/i.test(command);
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: needsShell });
  const prefix = `\x1b[${color}m[${label}]\x1b[0m `;
  const write = (stream) => (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim()) stream.write(prefix + line + "\n");
    }
  };
  child.stdout.on("data", write(process.stdout));
  child.stderr.on("data", write(process.stdout));
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.log(`${prefix}exited with code ${code} — stopping the other process.`);
      shutdown(code ?? 1);
    }
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill(isWindows ? undefined : "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 400);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("\x1b[1mEchoSense AI — development\x1b[0m");
console.log("  API  http://127.0.0.1:8000/api/health   (Django + DRF)");
console.log("  Web  http://localhost:5173\n");

const viteJs = join(frontend, "node_modules", "vite", "bin", "vite.js");

start("api", "36", venvPython, ["manage.py", "runserver", "8000"], backend);
if (existsSync(viteJs)) {
  start("web", "35", process.execPath, [viteJs], frontend);
} else {
  start("web", "35", npm, ["run", "dev"], frontend);
}

