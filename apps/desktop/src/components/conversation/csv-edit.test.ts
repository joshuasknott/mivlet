import { describe, expect, it } from "vitest";
import { parseCsv, serializeCsv, updateCsvCell } from "./csv-edit";

describe("csv editing", () => {
  it("round trips quoted commas, escaped quotes and multiline fields", () => {
    const document = parseCsv('Name,Note\r\nAlice,"hello, world"\r\nBob,"say ""hi"""\r\n');
    expect(document.rows[1][1].value).toBe("hello, world");
    expect(document.rows[2][1].value).toBe('say "hi"');
    expect(serializeCsv(document)).toContain('Alice,"hello, world"');
    expect(serializeCsv(document)).toContain('Bob,"say ""hi"""');
  });

  it("updates one selected cell while retaining formulas as text", () => {
    const updated = updateCsvCell('Label,Formula\r\nTotal,=SUM(A1:A2)\r\n', 1, 0, "Subtotal");
    expect(updated).toContain("Subtotal,=SUM(A1:A2)");
    expect(parseCsv(updated).rows[1][1].value).toBe("=SUM(A1:A2)");
  });

  it("quotes a changed cell when CSV syntax requires it", () => {
    const updated = updateCsvCell("A,B\n1,2", 0, 1, "two, now");
    expect(updated).toContain('A,"two, now"');
  });

  it("preserves untouched bytes and rejects malformed quote suffixes", () => {
    const source = 'A,"quoted, value"\r\n1,"keep"\n';
    expect(updateCsvCell(source, 1, 0, "2")).toBe('A,"quoted, value"\r\n2,"keep"\n');
    expect(() => parseCsv('A,"bad"suffix\n')).toThrow(/after a closing quote/);
    expect(() => parseCsv('A,un"quoted\n')).toThrow(/unquoted quote/);
  });

  it("requires an existing cell instead of silently growing a sparse row", () => {
    expect(() => updateCsvCell("A,B\n1,2", 3, 0, "x")).toThrow(/no longer available/);
  });
});
