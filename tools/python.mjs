// Runs a Python 3 script with the platform's usual launcher (`py` on Windows, `python3` elsewhere; override with
// PYTHON=...). Used by `npm run fetch` and tools/build_assets.mjs.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PYTHON = process.env.PYTHON || (process.platform === "win32" ? "py" : "python3");

export function runPython(args) {
  const r = spawnSync(PYTHON, args, { stdio: "inherit" });
  if (r.error) throw new Error(`could not start ${PYTHON} (set PYTHON=... to your Python 3): ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${PYTHON} ${args.join(" ")} failed (exit ${r.status})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runPython(process.argv.slice(2));
