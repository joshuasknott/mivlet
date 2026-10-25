export const scenarioOrder = [
  "plan",
  "research",
  "create",
  "build",
  "design",
  "review",
];

export const scenarios = [
  {
    id: "research",
    label: "Research a topic",
    eyebrow: "Research",
    prompt: "Pull together the latest thinking on local-first AI workspaces.",
    response:
      "I found the clearest patterns and grouped them into a short briefing with sources to review.",
    file: "Workspace research.md",
    fileMeta: "8 sources · 4 min read",
    agent: "Sage",
    agentRole: "Analysis & data",
    accent: "#ffad32",
    stage: "yellow",
    activity: ["Scanned 8 sources", "Grouped key patterns", "Briefing ready"],
  },
  {
    id: "plan",
    label: "Plan a project",
    eyebrow: "Plan",
    prompt: "Turn these notes into a launch plan with clear next steps.",
    response:
      "Your launch plan is ready to review. I've organised it with a clear sequence, next steps and supporting notes.",
    file: "Launch plan.md",
    fileMeta: "Plan, timeline and next steps",
    agent: "Nova",
    agentRole: "Research & planning",
    accent: "#7656ff",
    stage: "lavender",
    activity: [
      "Gathered key points",
      "Analysed your notes",
      "Launch plan created",
    ],
  },
  {
    id: "create",
    label: "Explore an idea",
    eyebrow: "Create",
    prompt: "Shape this rough idea into a clear story we can share.",
    response:
      "I shaped the idea into a first draft with a crisp narrative, examples and a few directions to explore next.",
    file: "First draft.md",
    fileMeta: "Story, examples and directions",
    agent: "Kit",
    agentRole: "Writing & content",
    accent: "#2d9ee9",
    stage: "blue",
    activity: [
      "Mapped the story",
      "Drafted three directions",
      "First draft ready",
    ],
  },
  {
    id: "build",
    label: "Check technical readiness",
    eyebrow: "Build",
    prompt: "Turn this feature brief into a technical readiness checklist.",
    response:
      "I mapped the dependencies, edge cases and rollout checks into a practical readiness list for the team.",
    file: "Readiness checklist.md",
    fileMeta: "Dependencies, risks and rollout checks",
    agent: "Otto",
    agentRole: "Engineering & delivery",
    accent: "#fa7d76",
    stage: "blue",
    activity: [
      "Mapped dependencies",
      "Flagged edge cases",
      "Readiness checklist created",
    ],
  },
  {
    id: "design",
    label: "Shape a visual direction",
    eyebrow: "Design",
    prompt: "Turn these product notes into a visual direction for launch.",
    response:
      "I pulled the strongest themes into a visual direction with a clear mood, palette and references to explore.",
    file: "Visual direction.md",
    fileMeta: "Mood, palette and reference notes",
    agent: "Fern",
    agentRole: "Visual direction",
    accent: "#44bd9e",
    stage: "yellow",
    activity: [
      "Found the visual themes",
      "Grouped reference cues",
      "Direction ready to share",
    ],
  },
  {
    id: "review",
    label: "Review the release checklist",
    eyebrow: "Review",
    prompt:
      "Review this release checklist and call out anything we may have missed.",
    response:
      "I reviewed the checklist, highlighted the two missing handoffs and added a final set of launch-day checks.",
    file: "Release review.md",
    fileMeta: "Findings, handoffs and final checks",
    agent: "Pip",
    agentRole: "Quality & review",
    accent: "#e981b5",
    stage: "lavender",
    activity: [
      "Read the release plan",
      "Found two missing handoffs",
      "Review ready to share",
    ],
  },
];

export function getScenario(scenario = "plan") {
  return scenarios.find((item) => item.id === scenario) ?? scenarios[1];
}
