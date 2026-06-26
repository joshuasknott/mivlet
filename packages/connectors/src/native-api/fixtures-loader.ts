/**
 * Test-only helper: read recorded fixture files from disk.
 *
 * Kept in a separate module from transport.ts so the Node `fs`/`url` imports
 * never enter the desktop browser bundle (rollup bundles transport.ts for the
 * app; this loader is imported only by *.test.ts files).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Read a recorded fixture file (utf-8) from the native-api fixtures directory. */
export function readFixture(name: string): string {
  const filePath = resolve(here, "fixtures", name);
  return readFileSync(filePath, "utf-8");
}
