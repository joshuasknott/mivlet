# Onboarding design QA

## Source visual truth

`C:\Users\Joshua Knott\.codex\generated_images\01a057ee-ae04-7861-9ab7-3628497f0143\exec-c61340a3-75ee-4ba0-8574-879306b2d746.png`

The selected source is a three-panel desktop onboarding mockup. The requested
implementation overrides are black primary buttons, underlined secondary
actions, no top-left product mark, and no visible Chief of Staff setup.

## Rendered implementation evidence

Desktop viewport: 1440 x 1000.

- `C:\Users\Joshua Knott\.codex\visualizations\2026\08\31\01a057ee-ae04-7861-9ab7-3628497f0143\fable-onboarding-implementation\account-desktop-v2.png`
- `C:\Users\Joshua Knott\.codex\visualizations\2026\08\31\01a057ee-ae04-7861-9ab7-3628497f0143\fable-onboarding-implementation\provider-desktop-v2.png`
- `C:\Users\Joshua Knott\.codex\visualizations\2026\08\31\01a057ee-ae04-7861-9ab7-3628497f0143\fable-onboarding-implementation\connectors-desktop.png`

Mobile viewport: 390 x 844.

- `C:\Users\Joshua Knott\.codex\visualizations\2026\08\31\01a057ee-ae04-7861-9ab7-3628497f0143\fable-onboarding-implementation\account-mobile-v2.png`
- `C:\Users\Joshua Knott\.codex\visualizations\2026\08\31\01a057ee-ae04-7861-9ab7-3628497f0143\fable-onboarding-implementation\provider-mobile-v2.png`
- `C:\Users\Joshua Knott\.codex\visualizations\2026\08\31\01a057ee-ae04-7861-9ab7-3628497f0143\fable-onboarding-implementation\connectors-mobile.png`

## Comparison result

The source and all three desktop implementation captures were opened together
in one comparison pass. The implementation preserves the source hierarchy:
three quiet progress dots, one centered heading and supporting line, icon-led
choices, one dominant full-width action, and a low-emphasis secondary action.
The account footer remains anchored low in the frame.

The requested deviations are present and intentional: primary actions are
black instead of purple, secondary actions are visibly underlined, and the
top-left decorative mark is absent. The implementation uses the existing
provider and connector icon components, so brand marks remain sharp and
consistent with the rest of Fable.

No P0, P1, or P2 visual mismatches remain. At 390 x 844, headings wrap without
collision, all four provider controls remain on one row, the custom API-key
path sits clearly underneath, primary actions remain full width, legal copy
stays readable, and nothing clips or overflows.

## Interaction and accessibility checks

- Account actions use Google as the primary route and email as the secondary
  route. Each route handles sign in or account creation, without a redundant
  third sign-in prompt.
- Provider controls are icon-only visually and retain accessible names,
  selected state, keyboard focus, and at least 52 px mobile touch targets.
- Anthropic uses its official monochrome mark and Gemini uses its official
  multicolour mark. The fifth provider tile is replaced by an underlined
  custom API-key action.
- Subscription is primary when supported; API key is secondary. Providers
  without subscription support reveal API-key setup directly.
- Back is available on provider and connector stages. A live run confirmed
  connector Back returns to provider selection without immediately advancing.
- Connector controls call the existing OAuth boundary and report unavailable
  preview behavior truthfully. Skip and Enter Fable both finish the optional
  connector stage.
- A live browser run confirmed the Chief of Staff first appears in the main
  conversation workspace after onboarding completes.
- Reduced-motion behavior and focus-visible rings are retained.

## QA history

1. Initial implementation capture: structure and visual hierarchy matched the
   selected source; intentional black-button and no-mark overrides confirmed.
2. Mobile pass: verified 390 x 844 layout and completed the full account to
   provider to connectors to workspace journey.
3. Final comparison: no blocking or substantive fidelity issues remained.
4. Refinement pass: removed the duplicate sign-in crossover, added reversible
   navigation, reduced the provider row to four branded marks, and rechecked
   the account and provider screens at 1440 x 1000 and 390 x 844. Browser
   console inspection reported zero errors and zero warnings.

final result: passed

---

# Connector marketplace design QA

## Source visual truth

`C:\Users\Joshua Knott\.codex\attachments\10a5b0b4-2086-44c6-b1b4-e94984d04105\image-2.png`

The selected 1487 x 1058 source establishes the quiet Fable marketplace
direction: a compact left-sidebar entry, top-right search, Installed first,
Recommended instead of Popular, and grouped two-column connector rows. The
separate Plugins and Skills control comes from the companion source
`image-1.png` in the same attachment folder.

## Rendered implementation evidence

In-app browser capture, 1092 x 1270:

- `C:\Users\Joshua Knott\Projects\fable\output\design-qa\connectors-marketplace-iab.png`
- Side-by-side comparison input:
  `C:\Users\Joshua Knott\Projects\fable\output\design-qa\connectors-marketplace-comparison.png`

The browser window is narrower than the source frame, so the implementation
correctly uses its responsive one-column directory rather than squeezing and
truncating a two-column grid. At wider desktop widths it returns to the source's
two-column organisation.

## Comparison result

The source and browser-rendered implementation were placed together in the
same comparison image. The implementation preserves the selected direction's
information hierarchy, spacing rhythm, Installed icon strip, Recommended
section, outlined action controls, restrained separators, search placement, and
bottom-left Connectors entry. It also adds the requested centered Plugins and
Skills control without competing with the page title.

Intentional product-truth deviations are visible. Supported connector rows use
the existing Fable adapter icons and real runtime state. Catalogue-only entries
are muted, use a clock action, and open a Planned explanation rather than a
false connect flow. The left sidebar presents one compact Connectors entry,
not a long list of installed apps.

No P0, P1, or P2 visual mismatch remains in the captured state.

## Interaction and accessibility checks

- Search filters names, descriptions, sections, permissions, setup messages,
  and health summaries.
- Installed contains only runtime manifests in the connected state and excludes
  the local-files capability.
- A supported, disconnected GitHub row opens the existing connector detail and
  reports its missing broker configuration before offering Connect.
- A planned Figma row opens a truthful Planned detail with a disabled
  `Not available yet` action.
- The Plugins and Skills controls expose current-page state and the Skills page
  reads and runs persisted teammate responsibilities.
- Connector rows and compact icon actions have accessible names, visible focus
  treatment, and touch-size adjustments at the mobile breakpoint.
- The Skills create action opens the existing persisted learning form rather
  than a decorative mock.

## QA history

1. Initial browser pass verified the marketplace hierarchy and both top-level
   tabs against the selected visual direction.
2. Interaction pass verified search filtering, a real GitHub setup path, and a
   deliberately unavailable Figma path without initiating external auth.
3. Responsive refinement moved the directory to one column when the remaining
   content width became too narrow for readable descriptions.
4. Final side-by-side comparison confirmed the chosen visual hierarchy and the
   explicit real-versus-planned connector treatment.

final result: passed
