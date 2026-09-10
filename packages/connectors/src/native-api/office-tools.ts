import type { BackendTool } from "@fable/protocol";

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
        range: {
          type: "string",
          pattern: "^[A-Z]{1,2}[1-9][0-9]{0,3}:[A-Z]{1,2}[1-9][0-9]{0,3}$",
        },
      },
      required: ["formula", "range"],
      additionalProperties: false,
    },
  ],
};

export const OFFICE_TOOLS: Record<string, BackendTool> = {
  "create-spreadsheet": {
    name: "create-spreadsheet",
    description:
      "Create one genuine macro-free XLSX in this agent's private Mivlet workspace from bounded cells and safe same-sheet aggregate formulas. Formula cells use a declarative operation and A1 range; Mivlet calculates and stores the verified cached result. Read the file back or publish it with computer-artifact only after this tool reports validation success.",
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
              name: { type: "string", minLength: 1, maxLength: 31 },
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
      "Create one genuine macro-free DOCX in this agent's private Mivlet workspace from bounded headings, paragraphs, bullets and tables. Mivlet produces passive Office XML and validates the package before returning success. Read the file back or publish it with computer-artifact only after this tool reports validation success.",
    defaultMode: "full-access",
    defaultRisk: "high",
    parameters: JSON.stringify({
      type: "object",
      properties: {
        path: {
          type: "string",
          pattern: "^[A-Za-z0-9][A-Za-z0-9 _./-]{0,240}\\.docx$",
        },
        title: { type: "string", minLength: 1, maxLength: 160 },
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
                  text: { type: "string", minLength: 1, maxLength: 8_000 },
                },
                required: ["type", "text"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["heading"] },
                  text: { type: "string", minLength: 1, maxLength: 500 },
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
                      items: { type: "string", minLength: 1, maxLength: 2_000 },
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
