interface CsvCell {
  value: string;
  quoted: boolean;
  rawStart: number;
  rawEnd: number;
}

export interface CsvDocument {
  rows: CsvCell[][];
}

const MAX_CSV_CHARACTERS = 1_048_576;
const MAX_CSV_ROWS = 10_000;
const MAX_CSV_COLUMNS = 256;

/** Parse bounded RFC 4180-style CSV without evaluating formula-looking values. */
export function parseCsv(content: string): CsvDocument {
  if (content.length > MAX_CSV_CHARACTERS) throw new Error("This CSV is too large to edit safely.");
  const rows: CsvCell[][] = [];
  let row: CsvCell[] = [];
  let value = "";
  let quoted = false;
  let inQuotes = false;
  let closedQuote = false;
  let tokenStart = 0;
  const pushCell = (end: number) => {
    row.push({ value, quoted, rawStart: tokenStart, rawEnd: end });
    value = "";
    quoted = false;
    closedQuote = false;
  };
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (inQuotes) {
      if (character === '"') {
        if (content[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else value += character;
      continue;
    }
    if (closedQuote) {
      if (character === ",") {
        pushCell(index);
        tokenStart = index + 1;
        continue;
      }
      if (character === "\n" || character === "\r") {
        pushCell(index);
        rows.push(row);
        if (rows.length > MAX_CSV_ROWS) throw new Error("This CSV has too many rows to edit safely.");
        row = [];
        if (character === "\r" && content[index + 1] === "\n") index += 1;
        tokenStart = index + 1;
        continue;
      }
      throw new Error("This CSV contains characters after a closing quote.");
    }
    if (character === '"' && value.length === 0) {
      quoted = true;
      inQuotes = true;
    } else if (character === '"') {
      throw new Error("This CSV contains an unquoted quote.");
    } else if (character === ",") {
      pushCell(index);
      tokenStart = index + 1;
    } else if (character === "\n" || character === "\r") {
      pushCell(index);
      rows.push(row);
      if (rows.length > MAX_CSV_ROWS) throw new Error("This CSV has too many rows to edit safely.");
      row = [];
      if (character === "\r" && content[index + 1] === "\n") index += 1;
      tokenStart = index + 1;
    } else value += character;
  }
  if (inQuotes) throw new Error("This CSV contains an unterminated quoted field.");
  if (value.length || quoted || row.length || tokenStart < content.length) pushCell(content.length);
  if (row.length) rows.push(row);
  for (const cells of rows) {
    if (cells.length > MAX_CSV_COLUMNS) throw new Error("This CSV has too many columns to edit safely.");
  }
  return { rows };
}

function serializeCell(cell: Pick<CsvCell, "value" | "quoted">): string {
  const needsQuotes = cell.quoted || /[",\r\n]/.test(cell.value);
  return needsQuotes ? `"${cell.value.replaceAll('"', '""')}"` : cell.value;
}

export function serializeCsv(document: CsvDocument): string {
  return document.rows.map((row) => row.map(serializeCell).join(",")).join("\r\n");
}

export function updateCsvCell(content: string, row: number, column: number, value: string): string {
  const document = parseCsv(content);
  if (!Number.isInteger(row) || !Number.isInteger(column) || row < 0 || column < 0) {
    throw new Error("The selected CSV cell is invalid.");
  }
  const existing = document.rows[row]?.[column];
  if (!existing) throw new Error("The selected CSV cell is no longer available.");
  existing.value = value;
  const replacement = serializeCell(existing);
  return `${content.slice(0, existing.rawStart)}${replacement}${content.slice(existing.rawEnd)}`;
}