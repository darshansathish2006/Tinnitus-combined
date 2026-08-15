#!/usr/bin/env node
/**
 * Task runner. Resolves the backend virtualenv interpreter on both Windows and
 * POSIX so the same commands work everywhere.
 *
 *   node scripts/run.mjs api      # start the Django dev server
 *   node scripts/run.mjs migrate  # apply database migrations
 *   node scripts/run.mjs train    # fit the predictive ensemble
 *   node scripts/run.mjs seed     # rebuild the demo cohort (drops existing data)
 *   node scripts/run.mjs verify   # Django checks + clinical checks + typecheck
 *   node scripts/run.mjs smoke    # browser smoke tests on a throwaway database
 *   node scripts/run.mjs verify:all          # verify + smoke
 *   node scripts/run.mjs manage <args...>    # any other manage.py command
 */

import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backend = join(root, "backend");
const frontend = join(root, "frontend");

const isWindows = process.platform === "win32";

/**
 * Candidate virtualenv locations, most conventional first.
 *
 * `npm run setup` creates `.venv`, but a developer who ran `python -m venv venv`
 * by hand has an equally valid environment — hardcoding one name made every task
 * fail with "run npm run setup" for someone who had already set up.
 */
const VENV_DIRS = [".venv", "venv", "env"];

function interpreterIn(dir) {
  return isWindows
    ? join(backend, dir, "Scripts", "python.exe")
    : join(backend, dir, "bin", "python");
}

let cachedPython = null;

function python() {
  if (cachedPython) return cachedPython;
  for (const dir of VENV_DIRS) {
    const candidate = interpreterIn(dir);
    if (existsSync(candidate)) {
      cachedPython = candidate;
      return candidate;
    }
  }
  console.error(
    `\nNo backend virtualenv found. Looked for:\n` +
      VENV_DIRS.map((d) => `  ${interpreterIn(d)}`).join("\n") +
      `\n\nRun:  npm run setup\n`
  );
  process.exit(1);
}

function run(command, args, cwd, env) {
  return new Promise((resolvePromise, reject) => {
    // Node 20+ refuses to spawn .cmd/.bat without a shell on Windows, so npm
    // needs shell:true there while the venv python must not have it.
    const needsShell = isWindows && /\.(cmd|bat)$/i.test(command);
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: needsShell,
      env: env ? { ...process.env, ...env } : process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`exit ${code}`))));
  });
}

/**
 * Run the browser smoke tests against a disposable database.
 *
 * Smoke tests sign in, open every screen and export a CSV, and each of those
 * writes audit rows. Pointed at the demo database that leaves it dirty after
 * every run — the demo cohort has to stay byte-identical so a demo is
 * reproducible. So the suite gets its own SQLite file, seeded from scratch and
 * deleted afterwards; `--keep-db` leaves it in place for debugging a failure.
 */
async function smoke(args) {
  const keep = args.includes("--keep-db");
  const dbName = "echosense.smoke.sqlite3";
  const dbPath = join(backend, dbName);
  const env = { ECHOSENSE_DATABASE_URL: `sqlite:///${dbName}` };

  const cleanup = () => {
    if (keep) return;
    // WAL leaves two sidecar files next to the database.
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  };

  cleanup();
  try {
    console.log(`\n[smoke] seeding throwaway database ${dbName}\n`);
    await run(python(), ["manage.py", "migrate", "--no-input"], backend, env);
    await run(python(), ["manage.py", "seed_demo", "--reset"], backend, env);
    await run(npm, ["run", "test:e2e", "--", ...args.filter((a) => a !== "--keep-db")], frontend, env);
  } finally {
    cleanup();
    if (!keep) console.log(`\n[smoke] removed ${dbName} — demo data untouched\n`);
  }
}

const npm = isWindows ? "npm.cmd" : "npm";
const task = process.argv[2];
const passthrough = process.argv.slice(3);

try {
  switch (task) {
    case "api":
      await run(python(), ["manage.py", "runserver", "8000", ...passthrough], backend);
      break;
    case "migrate":
      await run(python(), ["manage.py", "migrate", ...passthrough], backend);
      break;
    case "train":
      await run(python(), ["manage.py", "train_models", ...passthrough], backend);
      break;
    case "seed":
      await run(python(), ["manage.py", "migrate"], backend);
      await run(python(), ["manage.py", "seed_demo", "--reset", ...passthrough], backend);
      break;
    case "manage":
      await run(python(), ["manage.py", ...passthrough], backend);
      break;
    case "verify":
      await run(python(), ["manage.py", "check"], backend);
      await run(process.execPath, ["scripts/verify-procedures.mjs"], frontend);
      await run(npm, ["run", "typecheck"], frontend);
      break;
    case "smoke":
      await smoke(passthrough);
      break;
    case "verify:all":
      await run(python(), ["manage.py", "check"], backend);
      await run(process.execPath, ["scripts/verify-procedures.mjs"], frontend);
      await run(npm, ["run", "typecheck"], frontend);
      await run(npm, ["run", "build"], frontend);
      await smoke(passthrough);
      break;
    default:
      console.error(
        "Usage: node scripts/run.mjs <api|migrate|train|seed|verify|smoke|verify:all|manage>"
      );
      process.exit(1);
  }
} catch (error) {
  console.error(`\n${task} failed: ${error.message}`);
  process.exit(1);
}
