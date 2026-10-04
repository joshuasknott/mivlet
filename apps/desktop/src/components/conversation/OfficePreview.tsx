import { useState } from "react";
import type { LocalComputerOfficePreview } from "@mivlet/protocol";
import "./OfficePreview.css";

export function OfficePreview({
  office,
  truncated,
  notice = "Content preview · Open the file for full formatting and editing.",
}: {
  office: LocalComputerOfficePreview;
  truncated: boolean;
  notice?: string;
}) {
  const [selected, setSelected] = useState(0);
  const section =
    office.sections[Math.min(selected, office.sections.length - 1)];
  if (!section)
    return (
      <p>
        This file has no text to preview. Open it to view its full contents.
      </p>
    );
  const spreadsheet = office.kind === "spreadsheet";
  return (
    <div className={`office-preview office-preview--${office.kind}`}>
      <p className="office-preview__notice">{notice}</p>
      {office.sections.length > 1 && (
        <div
          className="office-preview__sections"
          role="group"
          aria-label={spreadsheet ? "Sheets" : "Slides"}
        >
          {office.sections.map((item, index) => (
            <button
              type="button"
              key={index}
              aria-pressed={selected === index}
              onClick={() => setSelected(index)}
            >
              {item.name}
            </button>
          ))}
        </div>
      )}
      <section className="office-preview__page" aria-label={section.name}>
        {office.kind !== "document" && <h3>{section.name}</h3>}
        {section.blocks.map((block, index) =>
          block.type === "paragraph" ? (
            block.style === "title" || block.style === "heading" ? (
              <h3 key={index} className={`office-preview__${block.style}`}>
                {block.text}
              </h3>
            ) : (
              <p key={index}>{block.text || "\u00a0"}</p>
            )
          ) : block.type === "chart" ? (
            <PreviewChart key={index} chart={block} />
          ) : (
            <PreviewTable
              key={index}
              rows={block.rows}
              spreadsheet={spreadsheet}
              name={`${section.name} table ${index + 1}`}
            />
          ),
        )}
      </section>
      {truncated && (
        <p className="office-preview__notice">
          This content preview is truncated. Save or open the file to see all
          its contents.
        </p>
      )}
    </div>
  );
}

type Chart = Extract<
  LocalComputerOfficePreview["sections"][number]["blocks"][number],
  { type: "chart" }
>;
const chartColors = ["#2563eb", "#b45309", "#047857"];

function PreviewChart({ chart }: { chart: Chart }) {
  const { categories, series } = chart;
  if (
    categories.length < 2 ||
    categories.length > 24 ||
    !series.length ||
    series.length > 3 ||
    series.some(
      (item) =>
        item.values.length !== categories.length ||
        item.values.some(
          (value) => !Number.isFinite(value) || Math.abs(value) > 1e12,
        ),
    )
  )
    return <p>Open the file to view this chart.</p>;
  const values = series.flatMap((item) => [...item.values]);
  const min = Math.min(0, ...values),
    max = Math.max(0, ...values);
  const span = max - min || 1;
  const y = (value: number) => 20 + ((max - value) / span) * 190;
  const step = 500 / categories.length;
  const x = (index: number) => 70 + (index + 0.5) * step;
  const zero = y(0);
  return (
    <figure className="office-preview__chart">
      <figcaption>{chart.title}</figcaption>
      <div
        className="office-preview__plot"
        tabIndex={0}
        role="region"
        aria-label={`${chart.title} plot`}
      >
        <svg
          viewBox="0 0 600 245"
          role="img"
          aria-label={`${chart.title}, ${chart.kind} chart`}
        >
          <text x="4" y="20">
            {max.toLocaleString(undefined, { notation: "compact" })}
          </text>
          <text x="4" y="210">
            {min.toLocaleString(undefined, { notation: "compact" })}
          </text>
          <line x1="70" x2="570" y1={zero} y2={zero} stroke="currentColor" />
          {series.map((item, index) =>
            chart.kind === "line" ? (
              <g key={index} fill={chartColors[index]}>
                <polyline
                  fill="none"
                  stroke={chartColors[index]}
                  strokeWidth="2.5"
                  points={item.values
                    .map((value, point) => `${x(point)},${y(value)}`)
                    .join(" ")}
                />
                {item.values.map((value, point) => (
                  <circle key={point} cx={x(point)} cy={y(value)} r="3">
                    <title>{`${categories[point]} · ${item.name}: ${value}`}</title>
                  </circle>
                ))}
              </g>
            ) : (
              <g key={index} fill={chartColors[index]}>
                {item.values.map((value, point) => (
                  <rect
                    key={point}
                    x={
                      70 +
                      point * step +
                      step * 0.1 +
                      (index * step * 0.8) / series.length
                    }
                    y={Math.min(zero, y(value))}
                    width={(step * 0.8) / series.length}
                    height={Math.abs(y(value) - zero)}
                  >
                    <title>{`${categories[point]} · ${item.name}: ${value}`}</title>
                  </rect>
                ))}
              </g>
            ),
          )}
          {categories.map((_, index) => (
            <text key={index} x={x(index)} y="235" textAnchor="middle">
              {index + 1}
            </text>
          ))}
        </svg>
      </div>
      <p className="office-preview__legend">
        {series.map((item, index) => (
          <span key={index}>
            <i style={{ background: chartColors[index] }} aria-hidden="true" />
            {item.name}
          </span>
        ))}
      </p>
      <p className="office-preview__notice">
        Cached worksheet values · Category numbers match the data below. Open
        the file to edit and recalculate.
      </p>
      <details>
        <summary>Chart data</summary>
        <PreviewTable
          spreadsheet={false}
          name={`${chart.title} data`}
          rows={[
            ["#", "Category", ...series.map((item) => item.name)],
            ...categories.map((label, index) => [
              String(index + 1),
              label,
              ...series.map((item) => String(item.values[index])),
            ]),
          ]}
        />
      </details>
    </figure>
  );
}

function PreviewTable({
  rows,
  spreadsheet,
  name,
}: {
  rows: readonly (readonly string[])[];
  spreadsheet: boolean;
  name: string;
}) {
  const columns = Math.max(0, ...rows.map((row) => row.length));
  return (
    <div
      className="office-preview__table"
      tabIndex={0}
      role="region"
      aria-label={name}
    >
      <table>
        <caption className="sr-only">{name} contents</caption>
        {spreadsheet && (
          <thead>
            <tr>
              <th aria-label="Row" />
              {Array.from({ length: columns }, (_, column) => (
                <th scope="col" key={column}>
                  {String.fromCharCode(65 + column)}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {spreadsheet && <th scope="row">{rowIndex + 1}</th>}
              {Array.from(
                { length: spreadsheet ? columns : row.length },
                (_, column) => (
                  <td key={column}>{row[column] ?? ""}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
