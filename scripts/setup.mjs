#!/usr/bin/env node
/**
 * One-command setup: creates the backend virtualenv, installs both dependency
 * sets, trains the models and seeds the demo cohort.
 *
 *   npm run setup
 *
 * Takes roughly three to five minutes on a first run, most of it installing
 * SciPy and scikit-learn wheels.
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

function run(command, args, cwd, label) {
  console.log(`\n\x1b[36m▸ ${label}\x1b[0m`);
  return new Promise((resolvePromise, reject) => {
    // Node 20+ refuses to spawn .cmd/.bat without a shell on Windows.
    const needsShell = isWindows && /\.(cmd|bat)$/i.test(command);
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: needsShell });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`${label} failed (exit ${code})`))));
  });
}

/** Find a usable Python 3. On Windows the launcher `py` is the reliable route. */
async function findPython() {
  const candidates = isWindows ? ["py", "python", "python3"] : ["python3", "python"];
  for (const candidate of candidates) {
    const ok = await new Promise((r) => {
      const child = spawn(candidate, ["-c", "import sys; assert sys.version_info >= (3, 11)"], {
        stdio: "ignore",
        shell: false,
      });
      child.on("error", () => r(false));
      child.on("exit", (code) => r(code === 0));
    });
    if (ok) return candidate;
  }
  throw new Error("Python 3.11 or newer is required but was not found on PATH.");
}

try {
  console.log("\x1b[1mEchoSense AI — setup\x1b[0m");

  if (!existsSync(venvPython)) {
    const py = await findPython();
    await run(py, ["-m", "venv", ".venv"], backend, "Creating Python virtualenv");
  } else {
    console.log("\n\x1b[36m▸ Virtualenv already present — skipping\x1b[0m");
  }

  await run(venvPython, ["-m", "pip", "install", "--upgrade", "pip", "--quiet"], backend, "Upgrading pip");
  await run(
    venvPython,
    ["-m", "pip", "install", "-r", "requirements.txt", "--quiet"],
    backend,
    "Installing backend dependencies (Django, DRF, numpy, scipy, scikit-learn)"
  );
  await run(npm, ["install", "--no-fund", "--no-audit"], frontend, "Installing frontend dependencies");
  await run(venvPython, ["manage.py", "migrate"], backend, "Creating the database schema");
  await run(venvPython, ["manage.py", "train_models"], backend, "Training the predictive ensemble");
  await run(venvPython, ["manage.py", "seed_demo", "--reset"], backend, "Seeding the demonstration cohort");

  console.log(`
\x1b[32m\x1b[1mSetup complete.\x1b[0m

Start both servers with:

  \x1b[1mnpm run dev\x1b[0m

Then open \x1b[36mhttp://localhost:5173\x1b[0m and sign in as:

  Clinician   dr.mehta@echosense.health
  Patient     priya.sundaram@example.com
  Password    echosense2026
`);
} catch (error) {
  console.error(`\n\x1b[31m${error.message}\x1b[0m\n`);
  process.exit(1);
}
