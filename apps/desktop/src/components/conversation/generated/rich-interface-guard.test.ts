import { describe, expect, it } from "vitest";
import {
  decodeRichState,
  encodeRichState,
  validateRichInterface,
} from "./rich-interface-guard";
const components = new Set([
  "Stack",
  "TextContent",
  "Input",
  "Slider",
  "Choice",
  "Photo",
  "Card",
  "Button",
  "Table",
]);
describe("provider-neutral rich interface boundary", () => {
  it("accepts local bill arithmetic, quiz feedback and image artifact references", () => {
    const examples = [
      '$bill = 80\n$people = 4\nroot = Stack([input, result])\ninput = Input("people", "People", $people, "number")\nresult = TextContent("Each: " + @Round($bill / $people, 2))',
      '$answer = ""\nroot = Stack([choice, feedback])\nchoice = Choice("answer", "Capital of France", ["Paris", "Rome"], $answer)\nfeedback = TextContent($answer == "Paris" ? "Correct" : "Try again")',
      `root = Stack([photo])\nphoto = Photo("artifact-${"a".repeat(64)}", "Pier", "Photo from a published file")`,
    ];
    for (const code of examples)
      expect(validateRichInterface(code, components).error).toBeUndefined();
  });
  it.each([
    'root = Query("read-file", {})',
    'root = Stack([x])\nx = Mutation("send-mail", {})',
    'root = Button("Send", Action([@Run(tool)]))',
    'root = Button("Open", Action([@OpenUrl("https://example.com")]))',
    "root = TextContent(window.localStorage)",
    'root = TextContent({__proto__: "bad"})',
    "root = Stack([a])\na = Stack([root])",
    'root = TextContent("ok"); fetch("bad")',
    'root = TextContent(@Each([1], "i", TextContent(i)))',
  ])(
    "refuses authority, executable source and unbounded iteration: %s",
    (source) => {
      expect(validateRichInterface(source, components).error).toBeTruthy();
    },
  );
  it("bounds incomplete/deep/cyclic expansion before interpreting", () => {
    expect(
      validateRichInterface("x".repeat(48001), components).error,
    ).toBeTruthy();
    expect(
      validateRichInterface(
        `root = Stack(${"[".repeat(20)}0${"]".repeat(20)})`,
        components,
      ).error,
    ).toBeTruthy();
    expect(
      validateRichInterface("root = Stack([later])", components).error,
    ).toMatch(/Unresolved/);
    expect(
      validateRichInterface("root = Stack([later])", components, true).error,
    ).toBeUndefined();
    expect(
      validateRichInterface('root = TextContent("unfinished', components).error,
    ).toMatch(/Incomplete/);
  });
  it("round-trips upstream reactive state through the existing bounded native field", () => {
    const state = {
      $people: 3,
      $answer: "Paris",
      form: { answer: { value: "Paris", componentType: "Choice" } },
    };
    expect(decodeRichState(encodeRichState(state))).toEqual(state);
    expect(() => encodeRichState({ $value: Infinity })).toThrow();
    expect(() => encodeRichState({ x: "x".repeat(8001) })).toThrow();
    expect(() => decodeRichState('{"__proto__":{"bad":true}}')).toThrow();
    expect(() => encodeRichState({ date: new Date() })).toThrow();
    expect(() => encodeRichState({ first: "界".repeat(1500), second: "界".repeat(1500) })).toThrow(/storage limit/);
  });
});
