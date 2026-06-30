#!/usr/bin/env bun
// CLI entry for the license audit. Logic lives in src/lib/licenses.ts.
//
//   bun run scripts/licenses.ts audit     # fail on any non-allowlisted license
//   bun run scripts/licenses.ts notices   # regenerate the NOTICES file
//   bun run scripts/licenses.ts --check   # audit + verify NOTICES has no drift

import { formatError, run } from "../src/lib/licenses.ts";

try {
  process.exit(run(process.argv[2] ?? "audit"));
} catch (e) {
  // Surface a clean message plus its cause (e.g. a corrupt manifest or version
  // mismatch) instead of a raw stack trace, and exit non-zero so CI still fails.
  console.error(formatError(e));
  process.exit(1);
}
