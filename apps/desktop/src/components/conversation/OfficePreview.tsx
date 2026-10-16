import { useState } from "react";
import type { LocalComputerOfficePreview } from "@mivlet/protocol";
import "./OfficePreview.css";

export interface OfficeCellSelection {
  section: string;
  sourceEntry?: string;
  sectionIndex?: number;
  row: number;
  column: number;
  value: string;
}

export interface OfficeParagraphSelection {
  section: string;
  sectionIndex?: number;
  sourceEntry?: string;
  paragraph: number;
  value: string;
}

export type OfficeSelection = OfficeCellSelection | OfficeParagraphSelection;
export type OfficeSelectionAction = "quote" | "explain" | "refine" | "memory";

export function OfficePreview({
  office,
  truncated,
  notice = "Working draft · Edit plain DOCX paragraphs and existing text, numeric or boolean XLSX cells. Formulas and rich Office structures remain protected. Export creates a separate file.",
  onRequestRevision,
  onRequestAgentRevision,
  onSelectionAction,
  onEditCell,
  onEditParagraph,
}: {
  office: LocalComputerOfficePreview;
  truncated: boolean;
  notice?: string;
  onRequestRevision?: (selection: OfficeCellSelection) => void;
  onRequestAgentRevision?: (selection: OfficeParagraphSelection) => void;
  onSelectionAction?: (
    selection: OfficeSelection,
    action: OfficeSelectionAction,
  ) => Promise<void>;
  onEditCell?: (
    selection: OfficeCellSelection,
    replacement: string,
  ) => Promise<void>;
  onEditParagraph?: (
    selection: OfficeParagraphSelection,
    replacement: string,
  ) => Promise<void>;
}) {
  const [selected, setSelected] = useState(0);
  const [cellSelection, setCellSelection] =
    useState<OfficeCellSelection | null>(null);
  const [cellSourceEntry, setCellSourceEntry] = useState<string | undefined>();
  const [editValue, setEditValue] = useState("");
  const [editingCell, setEditingCell] = useState(false);
  const [editState, setEditState] = useState<"idle" | "saving" | "error">(
    "idle",
  );
  const [editError, setEditError] = useState("");
  const [paragraphSelection, setParagraphSelection] =
    useState<OfficeParagraphSelection | null>(null);
  const [paragraphValue, setParagraphValue] = useState("");
  const [paragraphState, setParagraphState] = useState<"idle" | "saving">(
    "idle",
  );
  const [paragraphError, setParagraphError] = useState("");
  const [selectionAction, setSelectionAction] = useState<OfficeSelectionAction | null>(null);
  const [selectionActionError, setSelectionActionError] = useState("");
  const section =
    office.sections[Math.min(selected, office.sections.length - 1)];
  if (!section)
    return (
      <p>
        This file has no text to preview. Open it to view its full contents.
      </p>
    );
  const spreadsheet = office.kind === "spreadsheet";
  const runSelectionAction = async (
    selection: OfficeSelection,
    action: OfficeSelectionAction,
  ) => {
    if (!onSelectionAction) return;
    setSelectionAction(action);
    setSelectionActionError("");
    try {
      await onSelectionAction(selection, action);
    } catch (failure) {
      setSelectionActionError(
        failure instanceof Error ? failure.message : "This selection action could not be completed.",
      );
    } finally {
      setSelectionAction(null);
    }
  };
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
              onClick={() => {
                setSelected(index);
                setCellSelection(null);
                setCellSourceEntry(undefined);
                setEditingCell(false);
              }}
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
            <div key={index} className="office-preview__paragraph">
              {block.style === "title" || block.style === "heading" ? (
                <h3 className={`office-preview__${block.style}`}>
                  {block.text}
                </h3>
              ) : (
                <p>{block.text || "\u00a0"}</p>
              )}
              {onEditParagraph && selected === 0 ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                    const paragraph = section.blocks
                      .slice(0, index)
                      .filter((item) => item.type === "paragraph").length;
                    const next = {
                      section: section.name,
                      sectionIndex: selected,
                      sourceEntry: section.sourceEntry,
                      paragraph,
                      value: block.text,
                    };
                    setParagraphSelection(next);
                    setParagraphValue(block.text);
                    setParagraphError("");
                    }}
                  >
                  {paragraphSelection?.section === section.name &&
                    paragraphSelection.paragraph ===
                      section.blocks
                        .slice(0, index)
                        .filter((item) => item.type === "paragraph").length
                      ? "Editing paragraph"
                      : "Edit paragraph"}
                  </button>
                  {paragraphSelection?.section === section.name &&
                  paragraphSelection.paragraph ===
                    section.blocks
                      .slice(0, index)
                      .filter((item) => item.type === "paragraph").length &&
                  onSelectionAction ? (
                    <OfficeSelectionActions
                      disabled={selectionAction !== null}
                      pending={selectionAction}
                      onAction={(action) => void runSelectionAction(paragraphSelection, action)}
                    />
                  ) : null}
                  {onRequestAgentRevision ? (
                    <button
                      type="button"
                      onClick={() => {
                        const paragraph = section.blocks
                          .slice(0, index)
                          .filter((item) => item.type === "paragraph").length;
                        onRequestAgentRevision({
                          section: section.name,
                          sectionIndex: selected,
                          sourceEntry: section.sourceEntry,
                          paragraph,
                          value: block.text,
                        });
                      }}
                    >
                      Request agent change
                    </button>
                  ) : null}
                </>
              ) : null}
              {paragraphSelection?.section === section.name &&
              paragraphSelection.paragraph ===
                section.blocks
                  .slice(0, index)
                  .filter((item) => item.type === "paragraph").length ? (
                <div className="office-preview__paragraph-editor">
                  <input
                    value={paragraphValue}
                    aria-label="Replacement paragraph text"
                    onChange={(event) => setParagraphValue(event.target.value)}
                    disabled={paragraphState === "saving"}
                  />
                  <button
                    type="button"
                    disabled={paragraphState === "saving"}
                    onClick={() => {
                      if (!onEditParagraph) return;
                      setParagraphState("saving");
                      setParagraphError("");
                      void onEditParagraph(paragraphSelection, paragraphValue)
                        .then(() => {
                          setParagraphState("idle");
                          setParagraphSelection(null);
                        })
                        .catch((failure: unknown) => {
                          setParagraphState("idle");
                          setParagraphError(
                            failure instanceof Error
                              ? failure.message
                              : "The paragraph could not be saved.",
                          );
                        });
                    }}
                  >
                    {paragraphState === "saving" ? "Saving…" : "Save edited copy"}
                  </button>
                  {paragraphError ? <span role="alert">{paragraphError}</span> : null}
                </div>
              ) : null}
            </div>
          ) : block.type === "chart" ? (
            <PreviewChart key={index} chart={block} />
          ) : block.type === "image" ? (
            <PreviewImage key={index} image={block} />
          ) : (
            <PreviewTable
              key={index}
              rows={block.rows}
              spreadsheet={spreadsheet}
              name={`${section.name} table ${index + 1}`}
              sectionName={section.name}
              selected={cellSelection}
              onCellSelect={(selection) => {
                setCellSourceEntry(section.sourceEntry);
                setCellSelection(selection);
                setEditValue(selection.value);
                setEditingCell(false);
                setEditState("idle");
                setEditError("");
              }}
            />
          ),
        )}
      </section>
      {cellSelection && (onRequestRevision || onSelectionAction || onEditCell) ? (
        <div className="office-preview__selection" role="status">
          <span>
            Selected cell {String.fromCharCode(65 + cellSelection.column)}
            {cellSelection.row + 1}: {cellSelection.value || "(empty)"}
          </span>
          {onRequestRevision ? (
            <button
              type="button"
              onClick={() => onRequestRevision({ ...cellSelection, sourceEntry: cellSourceEntry, sectionIndex: selected })}
            >
              Request agent change
            </button>
          ) : null}
          {onSelectionAction ? (
            <OfficeSelectionActions
              disabled={selectionAction !== null}
              pending={selectionAction}
              onAction={(action) => void runSelectionAction({ ...cellSelection, sourceEntry: cellSourceEntry, sectionIndex: selected }, action)}
            />
          ) : null}
          {onEditCell && cellSourceEntry ? (
            editingCell ? (
              <>
                <input
                  value={editValue}
                  aria-label="Replacement cell value"
                  onChange={(event) => setEditValue(event.target.value)}
                  disabled={editState === "saving"}
                />
                <button
                  type="button"
                  disabled={editState === "saving"}
                  onClick={() => {
                    setEditState("saving");
                    setEditError("");
                      void onEditCell(
                        cellSourceEntry
                          ? { ...cellSelection, sourceEntry: cellSourceEntry }
                          : cellSelection,
                        editValue,
                      )
                      .then(() => {
                        setEditState("idle");
                        setEditingCell(false);
                      })
                      .catch((failure: unknown) => {
                        setEditState("error");
                        setEditError(
                          failure instanceof Error
                            ? failure.message
                            : "The Office revision could not be saved.",
                        );
                      });
                  }}
                >
                  {editState === "saving" ? "Saving…" : "Save edited copy"}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingCell(false)}
                  disabled={editState === "saving"}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setEditingCell(true)}
              >
                Edit cell
              </button>
            )
          ) : null}
          {editError ? <span role="alert">{editError}</span> : null}
          {selectionActionError ? <span role="alert">{selectionActionError}</span> : null}
        </div>
      ) : null}
      {truncated && (
        <p className="office-preview__notice">
          This content preview is truncated. Save or open the file to see all
          its contents.
        </p>
      )}
    </div>
  );
}

function OfficeSelectionActions({
  disabled,
  pending,
  onAction,
}: {
  disabled: boolean;
  pending: OfficeSelectionAction | null;
  onAction: (action: OfficeSelectionAction) => void;
}) {
  return (
    <span className="office-preview__selection-actions" role="toolbar" aria-label="Selected Office content actions">
      <button type="button" disabled={disabled} onClick={() => onAction("quote")}>Quote / ask</button>
      <button type="button" disabled={disabled} onClick={() => onAction("explain")}>Explain</button>
      <button type="button" disabled={disabled} onClick={() => onAction("refine")}>{pending === "refine" ? "Requesting…" : "Rewrite / refine"}</button>
      <button type="button" disabled={disabled} onClick={() => onAction("memory")}>Save to memory</button>
    </span>
  );
}

type OfficeImage = Extract<
  LocalComputerOfficePreview["sections"][number]["blocks"][number],
  { type: "image" }
>;

function PreviewImage({ image }: { image: OfficeImage }) {
  const valid =
    image.dataUrl.length <= 1_500_000 &&
    /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image.dataUrl) &&
    Number.isInteger(image.width) &&
    Number.isInteger(image.height) &&
    image.width > 0 &&
    image.height > 0 &&
    image.width <= 512 &&
    image.height <= 512;
  if (!valid) return <p>Open the file to view this image.</p>;
  return (
    <figure className="office-preview__image">
      <img
        src={image.dataUrl}
        alt={image.alt}
        width={image.width}
        height={image.height}
        loading="lazy"
        decoding="async"
      />
    </figure>
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
  sectionName = name,
  selected,
  onCellSelect,
}: {
  rows: readonly (readonly string[])[];
  spreadsheet: boolean;
  name: string;
  sectionName?: string;
  selected?: OfficeCellSelection | null;
  onCellSelect?: (selection: OfficeCellSelection) => void;
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
                  <td key={column}>
                    {onCellSelect ? (
                      <button
                        type="button"
                        className="office-preview__cell"
                        aria-label={`Select ${sectionName} row ${rowIndex + 1} column ${column + 1}`}
                        aria-pressed={
                          selected?.section === sectionName &&
                          selected?.row === rowIndex &&
                          selected?.column === column
                        }
                        onClick={() =>
                          onCellSelect({
                            section: sectionName,
                            row: rowIndex,
                            column,
                            value: row[column] ?? "",
                          })
                        }
                      >
                        {row[column] ?? ""}
                      </button>
                    ) : (
                      (row[column] ?? "")
                    )}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
