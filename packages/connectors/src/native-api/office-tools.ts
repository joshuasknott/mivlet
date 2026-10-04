import type { BackendTool } from "@mivlet/protocol";

const boundedText = (maxLength: number) => ({
  type: "string",
  minLength: 1,
  maxLength,
});

const cellRange = {
  type: "string",
  pattern: "^[A-Z]{1,2}[1-9][0-9]{0,3}:[A-Z]{1,2}[1-9][0-9]{0,3}$",
};

const textCell = {
  oneOf: [
    { type: "string", maxLength: 2_000 },
    { type: "number", minimum: -1_000_000_000_000, maximum: 1_000_000_000_000 },
    { type: "boolean" },
    {
      type: "object",
      properties: {
        formula: {
          type: "string",
          enum: ["sum", "average", "min", "max", "count"],
        },
        range: cellRange,
      },
      required: ["formula", "range"],
      additionalProperties: false,
    },
  ],
};

export const OFFICE_TOOLS: Record<string, BackendTool> = {
  "create-presentation": {
    name: "create-presentation",
    description:
      "Create passive editable 16:9 PPTX: light/dark, 1–30 slides, short text/bullets. Optional workspace PNG/JPEG with read-file digest/alt. Max 8 images, 4 MB each, 4096/side, 4M pixels, 16 MB normalized total; less text on image slides. New path; publish validated output with computer-artifact.",
    defaultMode: "full-access",
    defaultRisk: "high",
    parameters: JSON.stringify({
      type: "object",
      properties: {
        path: {
          type: "string",
          pattern: "^[A-Za-z0-9][A-Za-z0-9 _./-]{0,240}\\.pptx$",
        },
        title: boundedText(160),
        theme: { type: "string", enum: ["light", "dark"] },
        slides: {
          type: "array",
          minItems: 1,
          maxItems: 30,
          items: {
            type: "object",
            properties: {
              title: boundedText(120),
              body: boundedText(600),
              image: {
                type: "object",
                properties: {
                  path: { type: "string", minLength: 1, maxLength: 512 },
                  sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
                  alt: boundedText(240),
                },
                required: ["path", "sha256", "alt"],
                additionalProperties: false,
              },
              bullets: {
                type: "array",
                maxItems: 5,
                items: boundedText(120),
              },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "title", "slides"],
      additionalProperties: false,
    }),
  },
  "create-spreadsheet": {
    name: "create-spreadsheet",
    description:
      "Create passive XLSX cells, verified aggregate formulas and editable column/line charts. Charts use same-sheet vertical ranges of 2–24 cells, 1–3 numeric series; max 2/sheet, 8/file. New workspace path only. Publish validated output with computer-artifact.",
    defaultMode: "full-access",
    defaultRisk: "high",
    parameters: JSON.stringify({
      type: "object",
      properties: {
        path: {
          type: "string",
          pattern: "^[A-Za-z0-9][A-Za-z0-9 _./-]{0,240}\\.xlsx$",
        },
        sheets: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              name: boundedText(31),
              rows: {
                type: "array",
                minItems: 1,
                maxItems: 2_000,
                items: {
                  type: "array",
                  minItems: 1,
                  maxItems: 52,
                  items: textCell,
                },
              },
              charts: {
                type: "array",
                maxItems: 2,
                items: {
                  type: "object",
                  properties: {
                    title: boundedText(120),
                    type: { type: "string", enum: ["column", "line"] },
                    categories: cellRange,
                    series: {
                      type: "array",
                      minItems: 1,
                      maxItems: 3,
                      items: {
                        type: "object",
                        properties: {
                          name: boundedText(80),
                          values: cellRange,
                        },
                        required: ["name", "values"],
                        additionalProperties: false,
                      },
                    },
                  },
                  required: ["title", "type", "categories", "series"],
                  additionalProperties: false,
                },
              },
            },
            required: ["name", "rows"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "sheets"],
      additionalProperties: false,
    }),
  },
  "create-document": {
    name: "create-document",
    description:
      "Create passive DOCX headings, paragraphs, bullets and tables at a new private workspace path. Read or publish with computer-artifact after validation succeeds.",
    defaultMode: "full-access",
    defaultRisk: "high",
    parameters: JSON.stringify({
      type: "object",
      properties: {
        path: {
          type: "string",
          pattern: "^[A-Za-z0-9][A-Za-z0-9 _./-]{0,240}\\.docx$",
        },
        title: boundedText(160),
        blocks: {
          type: "array",
          minItems: 1,
          maxItems: 500,
          items: {
            oneOf: [
              {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["paragraph", "bullet"] },
                  text: boundedText(8_000),
                },
                required: ["type", "text"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["heading"] },
                  text: boundedText(500),
                  level: { type: "integer", minimum: 1, maximum: 3 },
                },
                required: ["type", "text", "level"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["table"] },
                  rows: {
                    type: "array",
                    minItems: 1,
                    maxItems: 200,
                    items: {
                      type: "array",
                      minItems: 1,
                      maxItems: 12,
                      items: boundedText(2_000),
                    },
                  },
                },
                required: ["type", "rows"],
                additionalProperties: false,
              },
            ],
          },
        },
      },
      required: ["path", "title", "blocks"],
      additionalProperties: false,
    }),
  },
};
