import assert from "node:assert/strict";
import test from "node:test";
import { validateCargoAuditReport } from "./cargo-audit.mjs";

const clean = () => ({
  vulnerabilities: { found: false, count: 0, list: [] },
  warnings: {},
});

test("a clean report retains visible informational warnings", () => {
  assert.equal(
    validateCargoAuditReport({
      ...clean(),
      warnings: { unmaintained: [{}], unsound: [{}, {}] },
    }),
    3,
  );
});

test("the former notification advisories and every new vulnerability fail", () => {
  for (const id of ["RUSTSEC-2026-0194", "RUSTSEC-2026-0195", "RUSTSEC-NEW"]) {
    const report = {
      ...clean(),
      vulnerabilities: {
        found: true,
        count: 1,
        list: [
          {
            advisory: { id },
            package: { name: "quick-xml", version: "0.37.5" },
          },
        ],
      },
    };
    assert.throws(() => validateCargoAuditReport(report), new RegExp(id));
  }
});

test("missing and inconsistent reports fail closed", () => {
  for (const report of [
    null,
    {},
    { vulnerabilities: {} },
    { ...clean(), vulnerabilities: { found: false, count: 1, list: [] } },
    { ...clean(), vulnerabilities: { found: true, count: 0, list: [] } },
    { ...clean(), warnings: { unmaintained: null } },
  ]) {
    assert.throws(() => validateCargoAuditReport(report), /incomplete/);
  }
});
