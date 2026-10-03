import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import {
  classifyAdvisories,
  loadPatchedPackage,
  verifyDependencyPatches,
} from "./dependency-patches.mjs";

const patches = verifyDependencyPatches();

for (const patch of patches) {
  for (const directory of patch.directories) {
    if (patch.package === "braces") {
      const braces = loadPatchedPackage(directory);
      test(`braces rejects excessive brace, parenthesis and mixed nesting: ${directory}`, () => {
        for (const [open, close] of [
          ["{", "}"],
          ["(", ")"],
          ["{(", ")}"],
        ]) {
          const pattern =
            open.repeat(4000 / open.length) +
            "a" +
            close.repeat(4000 / close.length);
          for (const operation of [
            braces,
            braces.parse,
            braces.compile,
            braces.expand,
            braces.stringify,
          ]) {
            assert.throws(() => operation(pattern), {
              name: "SyntaxError",
              message: /maximum depth/,
            });
          }
        }
      });
      test(`braces preserves ordinary patterns, escapes and depth boundary: ${directory}`, () => {
        assert.equal(
          braces.compile("src/{a,{b,c}}/*.ts"),
          "src/(a|(b|c))/*.ts",
        );
        assert.deepEqual(braces.expand("file-{1..3}"), [
          "file-1",
          "file-2",
          "file-3",
        ]);
        assert.deepEqual(braces.expand("a/{b,c}/d"), ["a/b/d", "a/c/d"]);
        assert.equal(braces.compile("\\{".repeat(101)), "{".repeat(101));
        assert.doesNotThrow(() =>
          braces.compile("{".repeat(100) + "a" + "}".repeat(100)),
        );
        assert.throws(
          () => braces.parse("{".repeat(101) + "a" + "}".repeat(101)),
          /maximum depth/,
        );
      });
      test(`braces bounds caller-provided ASTs: ${directory}`, () => {
        for (const operation of [
          braces.compile,
          braces.expand,
          braces.stringify,
        ]) {
          let ast = { type: "text", value: "a", nodes: [] };
          for (let i = 0; i < 4000; i++) {
            const parent = { type: "root", nodes: [ast] };
            ast.parent = parent;
            ast = parent;
          }
          assert.throws(() => operation(ast), {
            name: "SyntaxError",
            message: /maximum depth/,
          });
        }
      });
    } else {
      const CachePolicy = loadPatchedPackage(directory);
      const request = {
        url: "https://registry.example/package",
        method: "GET",
        headers: { host: "registry.example" },
      };
      const staleRequest = {
        ...request,
        headers: { ...request.headers, "cache-control": "max-stale=999999" },
      };
      test(`cache rejects max-stale and stale-while-revalidate for restricted entries: ${directory}`, () => {
        for (const headers of [
          {
            "set-cookie": "session=other-user",
            "cache-control": "max-age=600, stale-while-revalidate=600",
          },
          {
            "cache-control":
              "proxy-revalidate, max-age=600, stale-while-revalidate=600",
          },
          {
            "cache-control":
              "no-cache, max-age=600, stale-while-revalidate=600",
          },
          {
            "cache-control": "private, max-age=600, stale-while-revalidate=600",
          },
          {
            "cache-control":
              "no-store, max-age=600, stale-while-revalidate=600",
          },
          {
            vary: "*",
            "cache-control": "max-age=600, stale-while-revalidate=600",
          },
        ]) {
          const policy = new CachePolicy(request, { status: 200, headers });
          policy.now = () => Date.now() + 1000;
          for (const candidate of [
            request,
            staleRequest,
            {
              ...staleRequest,
              headers: { ...request.headers, "cache-control": "max-stale" },
            },
          ]) {
            assert.equal(policy.satisfiesWithoutRevalidation(candidate), false);
            const result = policy.evaluateRequest(candidate);
            assert.equal(result.response, undefined);
            assert.equal(result.revalidation.synchronous, true);
          }
        }
      });
      test(`cache preserves fresh public entries and ordinary stale opt-in: ${directory}`, () => {
        const fresh = new CachePolicy(request, {
          status: 200,
          headers: {
            "cache-control": "public, max-age=600",
            "set-cookie": "session=public",
          },
        });
        assert.equal(fresh.satisfiesWithoutRevalidation(request), true);
        const stale = new CachePolicy(request, {
          status: 200,
          headers: { "cache-control": "max-age=1" },
        });
        stale.now = () => Date.now() + 3000;
        assert.equal(stale.satisfiesWithoutRevalidation(request), false);
        assert.equal(stale.satisfiesWithoutRevalidation(staleRequest), true);
      });
    }
  }
}

test("patch verification rejects missing/tampered sources and expired review", () => {
  const fixture = mkdtempSync(join(tmpdir(), "mivlet-patch-test-"));
  try {
    const sourceRoot = new URL("../../", import.meta.url);
    cpSync(
      new URL("scripts/audit/pnpm-patches.json", sourceRoot),
      join(fixture, "scripts/audit/pnpm-patches.json"),
      { recursive: true },
    );
    assert.throws(() => verifyDependencyPatches(fixture), /ENOENT/);
    cpSync(
      new URL("node_modules/.pnpm/lock.yaml", sourceRoot),
      join(fixture, "node_modules/.pnpm/lock.yaml"),
      { recursive: true },
    );
    for (const patch of patches) {
      cpSync(
        patch.directories[0],
        join(
          fixture,
          `node_modules/.pnpm/${basename(dirname(dirname(patch.directories[0])))}/node_modules/${patch.package}`,
        ),
        { recursive: true },
      );
    }
    assert.doesNotThrow(() => verifyDependencyPatches(fixture));
    const file = join(
      fixture,
      `node_modules/.pnpm/${basename(dirname(dirname(patches[0].directories[0])))}/node_modules/braces/lib/parse.js`,
    );
    writeFileSync(file, readFileSync(file, "utf8") + "\n// tampered\n");
    assert.throws(
      () => verifyDependencyPatches(fixture),
      /Missing or changed patch/,
    );
    assert.throws(
      () =>
        verifyDependencyPatches(fixture, Date.parse("2026-11-01T00:00:00Z")),
      /expired/,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("audit permits only exact patched advisories and versions", () => {
  const advisories = patches.map((patch) => ({
    github_advisory_id: patch.advisory,
    module_name: patch.package,
    findings: [{ version: patch.version }],
  }));
  const report = {
    advisories: { ...advisories },
    metadata: { vulnerabilities: {} },
    muted: [],
  };
  assert.equal(classifyAdvisories(report, patches).unreviewed.length, 0);
  report.advisories.new = {
    github_advisory_id: "GHSA-new-finding",
    module_name: "braces",
    findings: [{ version: "3.0.3" }],
  };
  assert.equal(classifyAdvisories(report, patches).unreviewed.length, 1);
  report.advisories.new = {
    ...advisories[0],
    findings: [{ version: "0.0.0" }],
  };
  assert.equal(classifyAdvisories(report, patches).unreviewed.length, 1);
  delete report.advisories[0];
  assert.throws(
    () => classifyAdvisories(report, patches),
    /no longer reported/,
  );
  assert.throws(() => classifyAdvisories({}, patches), /invalid/);
  assert.throws(
    () => classifyAdvisories({ ...report, muted: [{}] }, patches),
    /muted/,
  );
});
