import type { BackendTool } from "@mivlet/protocol";

const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const block = (type: string, properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object", properties: { type: { type: "string", enum: [type] }, ...properties },
  required: ["type", ...required], additionalProperties: false,
});

export const PDF_TOOLS: Record<string, BackendTool> = {
  "create-pdf": {
    name: "create-pdf", defaultMode: "full-access", defaultRisk: "high",
    description: "Create passive A4 PDF: wrapped text, pagination, headings/bullets, repeated table headers, vector bars. Max 200 blocks, 50 pages, 100 KB text, 8 MB output. Embedded fonts support precomposed LTR; unsupported glyphs/scripts or overfull rows/charts fail. New workspace path only; verify with read-file, publish with computer-artifact after validation. No code/links/remote assets/host automation.",
    parameters: JSON.stringify({
      type: "object", properties: {
        path: { type: "string", maxLength: 240, pattern: "^[A-Za-z0-9][A-Za-z0-9 _./-]*\\.pdf$" },
        title: text(160), subtitle: text(300),
        blocks: { type: "array", minItems: 1, maxItems: 200, items: { oneOf: [
          block("paragraph", { text: text(8000) }), block("bullet", { text: text(8000) }),
          block("heading", { text: text(500), level: { type: "integer", minimum: 1, maximum: 3 } }),
          block("page-break", {}),
          block("table", { rows: { type: "array", minItems: 1, maxItems: 200, items: { type: "array", minItems: 1, maxItems: 8, items: text(2000) } } }),
          block("bar-chart", {
            title: text(100), unit: text(32),
            labels: { type: "array", minItems: 1, maxItems: 20, items: text(100) },
            values: { type: "array", minItems: 1, maxItems: 20, items: { type: "number", minimum: -1e12, maximum: 1e12 } },
          }, ["title", "labels", "values"]),
        ] } },
      }, required: ["path", "title", "blocks"], additionalProperties: false,
    }),
  },
};
