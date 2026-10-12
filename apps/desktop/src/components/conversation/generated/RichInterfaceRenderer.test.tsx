import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { richInterfaceLibrary, richPromptOptions } from "./rich-catalogue";
import RichInterfaceRenderer from "./RichInterfaceRenderer";
import { richExamples } from "./rich-examples.test-fixtures";
import { validateRichInterface } from "./rich-interface-guard";
import catalogueInstructions from "../../../lib/rich-interface-instructions.json";
import { createParser } from "@openuidev/lang-core";

const preview = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/computer-artifacts", () => ({
  previewComputerArtifact: preview,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const owner = { workspaceId: "workspace", agentId: "agent", generation: 4 };
function mount(code: string, saved = "{}", disabled = false) {
  const change = vi.fn(),
    review = vi.fn();
  render(
    <RichInterfaceRenderer
      code={code}
      streaming={false}
      owner={owner}
      interaction={{ state: { openuiState: saved }, disabled, change, review }}
    />,
  );
  return { change, review };
}
describe("rich production interface", () => {
  it("registers both chart schemas independently in the upstream parser", () => {
    const parser = createParser(richInterfaceLibrary.toJSONSchema());
    const result = parser.parse(richExamples.charts);
    expect(result.meta.errors).toEqual([]);
    expect(JSON.stringify(result.root)).toContain("BarChart");
    expect(JSON.stringify(result.root)).toContain("LineChart");
  });
  it("refuses credential collection even when the provider ignores its instructions", async () => {
    mount('$value = ""\nroot = Input("value", "API key", $value, "text")');
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /cannot request secrets/,
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
  it("uses the same generated instructions and catalogue for every provider", () => {
    expect(catalogueInstructions.instructions).toBe(
      richInterfaceLibrary.prompt(richPromptOptions),
    );
    const names = new Set(Object.keys(richInterfaceLibrary.components));
    for (const source of Object.values(richExamples))
      expect(validateRichInterface(source, names).error).toBeUndefined();
  });
  it("updates bill totals locally and restores saved state", async () => {
    const { change, review } = mount(richExamples.bill, '{"$people":2}');
    expect(await screen.findByText("Each person pays £44")).toBeVisible();
    fireEvent.change(screen.getByLabelText("People"), {
      target: { value: "4" },
    });
    expect(await screen.findByText("Each person pays £22")).toBeVisible();
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith(
        "openuiState",
        expect.stringContaining('"$people":4'),
      ),
    );
    expect(review).not.toHaveBeenCalled();
  });
  it("checks a quiz without dispatching a model request", async () => {
    const { review } = mount(richExamples.quiz);
    fireEvent.change(await screen.findByLabelText("Capital of France"), {
      target: { value: "Paris" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check answer" }));
    expect(await screen.findByText(/Correct — Paris/)).toBeVisible();
    expect(review).not.toHaveBeenCalled();
  });
  it("changes comparisons and filters the existing production table", async () => {
    mount(richExamples.comparison);
    fireEvent.change(await screen.findByLabelText("Budget in pounds"), {
      target: { value: "60" },
    });
    expect(await screen.findByText(/Choose the day trip/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Filter Options"), {
      target: { value: "hotel" },
    });
    expect(screen.queryByText("Day trip")).not.toBeInTheDocument();
    expect(screen.getByText("Seaside stay")).toBeVisible();
  });
  it("loads only a native-owned published image and handles unavailable media", async () => {
    preview.mockResolvedValue({
      imageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
    });
    mount(richExamples.itinerary);
    expect(
      await screen.findByRole("img", { name: "Published itinerary image" }),
    ).toBeVisible();
    expect(preview).toHaveBeenCalledWith({
      workspaceId: owner.workspaceId,
      agentId: owner.agentId,
      artifactId: `artifact-${"a".repeat(64)}`,
      expectedGeneration: 4,
    });
  });
  it("keeps tool authority out of the renderer and stages deliberate follow-ups", async () => {
    const { review } = mount(
      'root = Button("Refine this", Action([@ToAssistant("Refine the current comparison")]))',
    );
    fireEvent.click(await screen.findByRole("button", { name: "Refine this" }));
    expect(review).toHaveBeenCalled();
    cleanup();
    mount('root = Button("Send", Action([@Run(secret)]))');
    expect(await screen.findByRole("alert")).toHaveTextContent(/Unsupported/);
    expect(
      screen.queryByRole("button", { name: "Send" }),
    ).not.toBeInTheDocument();
  });
});
