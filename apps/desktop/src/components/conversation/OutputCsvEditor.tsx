import { useMemo, useState } from "react";
import { parseCsv, updateCsvCell, type CsvDocument } from "./csv-edit";
import "./output-csv-editor.css";

const PAGE_SIZE = 50;

export function OutputCsvEditor({
  content,
  selectedCell,
  onCellFocus,
  onCellChange,
  onError,
}: {
  content: string;
  selectedCell: { row: number; column: number } | null;
  onCellFocus: (row: number, column: number, value: string) => void;
  onCellChange: (content: string, row: number, column: number, value: string) => void;
  onError: (message: string) => void;
}) {
  const [page, setPage] = useState(0);
  const document = useMemo<CsvDocument | null>(() => {
    try {
      return parseCsv(content);
    } catch {
      return null;
    }
  }, [content]);
  if (!document) {
    return <p role="alert" className="output-editor__error">This CSV could not be parsed safely for cell editing.</p>;
  }
  const pageCount = Math.max(1, Math.ceil(document.rows.length / PAGE_SIZE));
  const pageIndex = Math.min(page, pageCount - 1);
  const pageStart = pageIndex * PAGE_SIZE;
  return (
    <div className="output-editor__csv-wrap" role="region" aria-label="CSV table">
      <table className="output-editor__csv">
        <tbody>
          {document.rows.slice(pageStart, pageStart + PAGE_SIZE).map((row, pageRowIndex) => {
            const rowIndex = pageStart + pageRowIndex;
            return (
              <tr key={rowIndex}>
                {row.map((cell, columnIndex) => (
                  <td key={columnIndex}>
                    <input
                      className={selectedCell?.row === rowIndex && selectedCell.column === columnIndex ? "output-editor__csv-cell--selected" : undefined}
                      aria-label={`Cell R${rowIndex + 1}C${columnIndex + 1}`}
                      value={cell.value}
                      onFocus={() => onCellFocus(rowIndex, columnIndex, cell.value)}
                      onChange={(event) => {
                        try {
                          onCellChange(updateCsvCell(content, rowIndex, columnIndex, event.target.value), rowIndex, columnIndex, event.target.value);
                        } catch (failure) {
                          onError(failure instanceof Error ? failure.message : "This CSV cell could not be edited.");
                        }
                      }}
                    />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {pageCount > 1 ? (
        <div className="output-editor__csv-pages" role="navigation" aria-label="CSV pages">
          <button type="button" onClick={() => setPage(Math.max(0, pageIndex - 1))} disabled={pageIndex === 0}>Previous rows</button>
          <span>Rows {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, document.rows.length)} of {document.rows.length}</span>
          <button type="button" onClick={() => setPage(Math.min(pageCount - 1, pageIndex + 1))} disabled={pageIndex === pageCount - 1}>Next rows</button>
        </div>
      ) : null}
    </div>
  );
}
