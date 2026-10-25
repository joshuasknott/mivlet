export const exampleDocuments = {
  plan: [
    [
      "Outline",
      "Introduce the idea, explain who it helps, and give people one clear way to try it.",
    ],
    [
      "Next steps",
      "Agree on the scope. Prepare a small demo. Share it with a few people and collect their feedback.",
    ],
    [
      "Open questions",
      "What would make the first experience useful? What can we simplify before sharing?",
    ],
  ],
  research: [
    [
      "The big picture",
      "Local-first workspaces bring saved context closer to the person doing the work. Connected models can still help when they are needed.",
    ],
    [
      "Patterns worth exploring",
      "Provider choice, visible actions, and a clear boundary between private files and shared context.",
    ],
    [
      "Questions for the next pass",
      "How easy is it to review what an agent changed? What happens when a connection is unavailable?",
    ],
  ],
  create: [
    [
      "The story",
      "Make room for ideas by keeping the tools, context and conversation in one calm place.",
    ],
    [
      "Three directions",
      "Lead with a useful outcome. Show one simple conversation. Let the product’s personality come through in the details.",
    ],
    [
      "Where to go next",
      "Choose the clearest direction, make a small version, and put it in front of someone who will use it.",
    ],
  ],
  build: [
    [
      "Dependencies",
      "Confirm the supported Windows version, provider connection and local workspace folder before starting the first-run check.",
    ],
    [
      "Edge cases",
      "Test a disconnected provider, an empty project and a cancelled task. Each should leave the workspace usable with a clear next step.",
    ],
    [
      "Rollout checks",
      "Build the release, walk through setup on a clean machine, and verify the recovery path before sharing the installer.",
    ],
  ],
  design: [
    [
      "The feeling",
      "A quiet workspace with a little personality. Let useful conversations lead, with expressive agents close at hand.",
    ],
    [
      "Palette and type",
      "Warm ivory, deep ink and lavender anchor the page. Peach and sky blue give product moments their own space.",
    ],
    [
      "Reference notes",
      "Use generous backgrounds around focused product details. Keep navigation clear, icons familiar and motion connected to the work.",
    ],
  ],
  review: [
    [
      "Two missing handoffs",
      "Assign an owner for the setup guide and confirm who will collect feedback after launch. Both need a named person and a due date.",
    ],
    [
      "Final checks",
      "Verify the download link, setup instructions, provider connection and first saved result. Recheck the mobile marketing page.",
    ],
    [
      "Ready to share",
      "Close the two handoffs, run through the checklist once more, then share the release with the first group of users.",
    ],
  ],
};
export function ExampleDocument({ scenario }) {
  return (
    <article className="example-document">
      {(exampleDocuments[scenario] ?? exampleDocuments.plan).map(
        ([title, body]) => (
          <section key={title}>
            <h3>{title}</h3>
            <p>{body}</p>
          </section>
        ),
      )}
    </article>
  );
}
