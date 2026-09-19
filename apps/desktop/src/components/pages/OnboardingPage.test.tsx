import type { IdentityStatus } from "@mivlet/protocol";
import { act, render, screen } from "@testing-library/react";
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
    normalizedIssuer: "https://accounts.mivlet.test",
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
    onCancelSignIn: vi.fn().mockResolvedValue(undefined),
    onSignOut: vi.fn().mockResolvedValue(undefined),
    onOpenWorkspace: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("account entry", () => {
  it("starts with login and signup account entry and no setup wizard", () => {
    render(<OnboardingPage {...props()} />);
    expect(
      screen.getByRole("heading", { name: "Start using Mivlet" }),
    ).toHaveFocus();
    expect(screen.getByRole("button", { name: "Log in" })).toHaveClass(
      "og-primary-button",
    );
    expect(
      screen.getByRole("button", { name: "Create an account" }),
    ).toHaveClass("og-secondary-button");
    expect(screen.queryByLabelText(/Onboarding step/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Skip|Enter Mivlet/ }),
    ).toBeNull();
  });

  it.each(["Log in", "Create an account"] as const)(
    "opens %s sign-in without treating completion as workspace authority",
    async (entry) => {
      const user = userEvent.setup();
      const input = props();
      render(<OnboardingPage {...input} />);
      await user.click(screen.getByRole("button", { name: entry }));
      expect(input.onSignIn).toHaveBeenCalledWith(
        entry === "Create an account" ? "sign-up" : "sign-in",
      );
      expect(input.onOpenWorkspace).not.toHaveBeenCalled();
      expect(
        screen.getByRole("heading", { name: "Start using Mivlet" }),
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
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Browser sign-in could not open.",
    );
    await user.click(screen.getByRole("button", { name: "Create an account" }));
    expect(
      screen.getByRole("button", { name: "Waiting for sign-up" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Log in" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(onSignIn).toHaveBeenCalledTimes(2);
    await act(async () => finish());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Log in" })).toBeEnabled();
  });

  it("lets a user go back from an unfinished sign-up and start login", async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const input = props({
      onSignIn: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
        )
        .mockResolvedValue(undefined),
    });
    render(<OnboardingPage {...input} />);
    await user.click(screen.getByRole("button", { name: "Create an account" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(input.onCancelSignIn).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Log in" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(input.onSignIn).toHaveBeenLastCalledWith("sign-in");
    await act(async () => finish());
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
    expect(screen.getByRole("button", { name: "Log in" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Try opening workspace again" }),
    ).toBeNull();
  });
});
