import { useState } from "react";
import type { LocalComputerOfficePreview } from "@mivlet/protocol";
import "./OfficePreview.css";

export function OfficePreview({ office, truncated }: { office: LocalComputerOfficePreview; truncated: boolean }) {
  const [selected, setSelected] = useState(0);
  const section = office.sections[Math.min(selected, office.sections.length - 1)];
  if (!section) return <p>This file has no text to preview. Open it to view its full contents.</p>;
  const spreadsheet = office.kind === "spreadsheet";
  return <div className={`office-preview office-preview--${office.kind}`}>
    <p className="office-preview__notice">Content preview · Open the file for full formatting and editing.</p>
    {office.sections.length > 1 && <div className="office-preview__sections" role="group" aria-label={spreadsheet ? "Sheets" : "Slides"}>
      {office.sections.map((item, index) => <button type="button" key={index} aria-pressed={selected === index}
        onClick={() => setSelected(index)}>{item.name}</button>)}
    </div>}
    <section className="office-preview__page" aria-label={section.name}>
      {office.kind !== "document" && <h3>{section.name}</h3>}
      {section.blocks.map((block, index) => block.type === "paragraph"
        ? block.style === "title" || block.style === "heading"
          ? <h3 key={index} className={`office-preview__${block.style}`}>{block.text}</h3>
          : <p key={index}>{block.text || "\u00a0"}</p>
        : <PreviewTable key={index} rows={block.rows} spreadsheet={spreadsheet} name={`${section.name} table ${index + 1}`} />)}
    </section>
    {truncated && <p className="office-preview__notice">This content preview is truncated. Save or open the file to see all its contents.</p>}
  </div>;
}

function PreviewTable({ rows, spreadsheet, name }: { rows: readonly (readonly string[])[]; spreadsheet: boolean; name: string }) {
  const columns = Math.max(0, ...rows.map((row) => row.length));
  return <div className="office-preview__table" tabIndex={0} role="region" aria-label={name}>
          <table><caption className="sr-only">{name} contents</caption>
            {spreadsheet && <thead><tr><th aria-label="Row" />{Array.from({ length: columns }, (_, column) => <th scope="col" key={column}>{String.fromCharCode(65 + column)}</th>)}</tr></thead>}
            <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>
              {spreadsheet && <th scope="row">{rowIndex + 1}</th>}
              {Array.from({ length: spreadsheet ? columns : row.length }, (_, column) => <td key={column}>{row[column] ?? ""}</td>)}
            </tr>)}</tbody>
          </table>
        </div>;
}
