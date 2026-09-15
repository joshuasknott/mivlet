import type { IdentityStatus } from "@fable/protocol";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { OnboardingPage } from "./OnboardingPage";

const signedOut: IdentityStatus = {
  enabled: true,
  state: "signed-out",
  message: "Sign in to continue.",
  scopes: [],
};
const signedIn: IdentityStatus = {
  ...signedOut,
  state: "signed-in",
  message: "Signed in.",
  authentication: {
    provider: "clerk",
    normalizedIssuer: "https://accounts.fable.test",
    subject: "person-1",
    authenticationEventRef: "event-1",
    sessionRef: "session-1",
    authenticatedAt: "2026-08-31T12:00:00.000Z",
    expiresAt: "2026-08-31T13:00:00.000Z",
    verifiedAttributes: [],
  },
};
function props(
  overrides: Partial<ComponentProps<typeof OnboardingPage>> = {},
): ComponentProps<typeof OnboardingPage> {
  return {
    identityStatus: signedOut,
    identityPending: false,
    workspaceMessage: "Workspace unavailable. Try again.",
    onSignIn: vi.fn().mockResolvedValue(undefined),
    onOpenWorkspace: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("account entry", () => {
  it("starts with Google and email account entry and no setup wizard", () => {
    render(<OnboardingPage {...props()} />);
    expect(
      screen.getByRole("heading", { name: "Welcome to Mivlet" }),
    ).toHaveFocus();
    expect(
      screen.getByText("Sign in or create an account to get started."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue with Google" }),
    ).toHaveClass("og-primary-button");
    expect(
      screen.getByRole("button", { name: "Continue with email" }),
    ).toHaveClass("og-text-button");
    expect(screen.queryByLabelText(/Onboarding step/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Skip|Enter Mivlet/ }),
    ).toBeNull();
  });

  it.each(["Google", "email"] as const)(
    "opens %s sign-in without treating completion as workspace authority",
    async (entry) => {
      const user = userEvent.setup();
      const input = props();
      render(<OnboardingPage {...input} />);
      await user.click(
        screen.getByRole("button", { name: `Continue with ${entry}` }),
      );
      expect(input.onSignIn).toHaveBeenCalledWith(entry.toLowerCase());
      expect(input.onOpenWorkspace).not.toHaveBeenCalled();
      expect(
        screen.getByRole("heading", { name: "Welcome to Mivlet" }),
      ).toBeVisible();
      expect(screen.getByRole("status")).toHaveTextContent(
        "Sign in to continue.",
      );
    },
  );

  it("keeps failed sign-in recoverable and prevents another request while pending", async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const onSignIn = vi
      .fn()
      .mockRejectedValueOnce(new Error("Browser sign-in could not open."))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
    render(<OnboardingPage {...props({ onSignIn })} />);
    await user.click(
      screen.getByRole("button", { name: "Continue with Google" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Browser sign-in could not open.",
    );
    await user.click(
      screen.getByRole("button", { name: "Continue with email" }),
    );
    expect(
      screen.getByRole("button", { name: "Opening sign in" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Continue with email" }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "Continue with email" }),
    );
    expect(onSignIn).toHaveBeenCalledTimes(2);
    await act(async () => finish());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Continue with Google" }),
    ).toBeEnabled();
  });

  it("retries the native workspace for an authenticated account without opening provider setup", async () => {
    const user = userEvent.setup();
    const input = props({ identityStatus: signedIn });
    render(<OnboardingPage {...input} />);
    expect(
      screen.getByRole("heading", { name: "Open your workspace" }),
    ).toHaveFocus();
    expect(screen.getByText(input.workspaceMessage)).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Try opening workspace again" }),
    );
    expect(input.onOpenWorkspace).toHaveBeenCalledOnce();
    expect(input.onSignIn).not.toHaveBeenCalled();
    expect(screen.queryByText("Choose your provider")).toBeNull();
    expect(screen.queryByText("Connect the apps you use")).toBeNull();
  });

  it("requires sign-in for an offline identity without authentication evidence", () => {
    render(
      <OnboardingPage
        {...props({ identityStatus: { ...signedOut, state: "offline" } })}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Continue with Google" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Try opening workspace again" }),
    ).toBeNull();
  });

  it("shows local privacy information with keyboard dismissal and focus return", async () => {
    const user = userEvent.setup();
    render(<OnboardingPage {...props()} />);
    const privacy = screen.getByRole("button", { name: "Privacy & data" });
    await user.click(privacy);
    const dialog = screen.getByRole("dialog", { name: "Privacy & data" });
    expect(within(dialog).getByText("Model providers")).toBeVisible();
    expect(
      within(dialog).getByText(/Clerk handles account sign-in/),
    ).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(privacy).toHaveFocus();
  });
});
