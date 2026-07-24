import { describe, expect, it } from "vitest";
import { parseComposerText } from "./parse";

describe("parseComposerText", () => {
  it("recognizes stop with natural-language parity", () => {
    expect(parseComposerText("/stop")).toEqual({ status: "command", request: { name: "stop", args: "" } });
    expect(parseComposerText("Stop current work")).toEqual({ status: "command", request: { name: "stop", args: "" } });
    expect(parseComposerText("cancel current work")).toEqual({ status: "command", request: { name: "stop", args: "" } });
  });
  it("recognizes conservative natural-language forms for every state command", () => {
    expect(parseComposerText("Remember that I prefer concise updates")).toEqual({ status: "command", request: { name: "remember", args: "I prefer concise updates" } });
    expect(parseComposerText("Set a goal to ship onboarding")).toEqual({ status: "command", request: { name: "goal", args: "ship onboarding" } });
    expect(parseComposerText("Create a plan to migrate the store")).toEqual({ status: "command", request: { name: "plan", args: "migrate the store" } });
    expect(parseComposerText("Remind me every day at 09:00")).toEqual({ status: "command", request: { name: "schedule", args: "every day at 09:00" } });
  });

  it("does not hijack conversational uses of command words", () => {
    expect(parseComposerText("Remember when we shipped onboarding?")).toEqual({ status: "prompt", text: "Remember when we shipped onboarding?" });
    expect(parseComposerText("Plan a launch with me")).toEqual({ status: "prompt", text: "Plan a launch with me" });
    expect(parseComposerText("Schedule options for the launch")).toEqual({ status: "prompt", text: "Schedule options for the launch" });
  });
  it("recognizes each Fable-owned command with trailing args", () => {
    expect(parseComposerText("/remember the prod endpoint is example.com")).toEqual({
      status: "command",
      request: { name: "remember", args: "the prod endpoint is example.com" }
    });
    expect(parseComposerText("/goal ship the v2 onboarding flow")).toEqual({
      status: "command",
      request: { name: "goal", args: "ship the v2 onboarding flow" }
    });
    expect(parseComposerText("/plan break the migration into reviewable steps")).toEqual({
      status: "command",
      request: { name: "plan", args: "break the migration into reviewable steps" }
    });
    expect(parseComposerText("/mission Launch readiness\n- Prepare the brief\n- Review the risks")).toEqual({
      status: "command",
      request: {
        name: "mission",
        args: "Launch readiness\n- Prepare the brief\n- Review the risks"
      }
    });
    expect(parseComposerText("/schedule every day at 09:00")).toEqual({
      status: "command",
      request: { name: "schedule", args: "every day at 09:00" }
    });
  });

  it("recognizes a bare command token with no arguments", () => {
    expect(parseComposerText("/goal")).toEqual({
      status: "command",
      request: { name: "goal", args: "" }
    });
    expect(parseComposerText("/goal ")).toEqual({
      status: "command",
      request: { name: "goal", args: "" }
    });
  });

  it("trims surrounding whitespace and collapses the arg delimiter", () => {
    expect(parseComposerText("   /remember    prefers dark mode   ")).toEqual({
      status: "command",
      request: { name: "remember", args: "prefers dark mode" }
    });
  });

  it("treats ordinary text as a prompt", () => {
    expect(parseComposerText("What is the onboarding flow?")).toEqual({
      status: "prompt",
      text: "What is the onboarding flow?"
    });
  });

  it("treats a slash that is not the first token as a prompt", () => {
    // A slash mid-sentence is prose, not a command.
    expect(parseComposerText("see /docs for more")).toEqual({
      status: "prompt",
      text: "see /docs for more"
    });
  });

  it("reserves unknown slash tokens as unknown-command (passthrough seam)", () => {
    expect(parseComposerText("/foo do something")).toEqual({
      status: "unknown-command",
      token: "/foo",
      text: "/foo do something"
    });
  });

  it("does not match a known command prefix that is part of a longer word", () => {
    // "/goalkeeper" is not the /goal command.
    expect(parseComposerText("/goalkeeper advice")).toEqual({
      status: "unknown-command",
      token: "/goalkeeper",
      text: "/goalkeeper advice"
    });
  });

  it("treats an empty string as an empty prompt", () => {
    expect(parseComposerText("")).toEqual({ status: "prompt", text: "" });
    expect(parseComposerText("   ")).toEqual({ status: "prompt", text: "   " });
  });
});
