import { readFile, rm } from "node:fs/promises";
import pptxgen from "pptxgenjs";

const output = "/tmp/fable-document-tools-smoke.pptx";
const presentation = new pptxgen();
presentation.layout = "LAYOUT_WIDE";
const slide = presentation.addSlide();
slide.addText("Fable slide tooling", { x: 1, y: 1, w: 6, h: 1 });
await presentation.writeFile({ fileName: output });
const bytes = await readFile(output);
if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
  throw new Error("PptxGenJS did not create an OOXML package");
}
await rm(output);
