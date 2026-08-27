import { describe, expect, it } from "vitest";
import { safeDownloadFileName } from "./browser-download";

describe("safeDownloadFileName", () => {
  it("keeps a bounded normal name", () => {
    expect(safeDownloadFileName("Quarterly report.pdf")).toBe("Quarterly report.pdf");
  });

  it("removes path and control authority and supplies a fallback", () => {
    expect(safeDownloadFileName("../private\\report?.pdf")).toBe("..-private-report-.pdf");
    expect(safeDownloadFileName("...   ")).toBe("download.bin");
    expect(safeDownloadFileName("a".repeat(200))).toHaveLength(120);
  });
});
