import type { ComponentProps } from "react";
import { ClerkProvider } from "@clerk/react";
import { enUS } from "@clerk/localizations";
import symbol from "../../desktop/public/brand/mivlet-symbol-light.png";

// One theme also covers password, verification, recovery and MFA screens.
export const appearance: ComponentProps<typeof ClerkProvider>["appearance"] = {
  options: {
    logoImageUrl: symbol,
    logoPlacement: "inside",
    socialButtonsVariant: "blockButton",
    socialButtonsPlacement: "top",
    animations: false,
  },
  variables: {
    colorPrimary: "#272623",
    colorForeground: "#272623",
    colorMutedForeground: "#68645e",
    colorBackground: "#faf9f6",
    colorInput: "#faf9f6",
    colorInputForeground: "#272623",
    colorPrimaryForeground: "#faf9f6",
    colorNeutral: "#272623",
    colorBorder: "#c9c5bd",
    fontFamily: '"Inter", ui-sans-serif, system-ui, sans-serif',
    fontSize: "16px",
    borderRadius: "12px",
  },
  elements: {
    rootBox: "account-root",
    cardBox: "account-card-box",
    card: "account-card",
    headerTitle: "account-heading",
    headerSubtitle: "account-subtitle",
    logoBox: "account-logo-box",
    logoImage: "account-logo",
    formButtonPrimary: "account-primary",
    socialButtonsBlockButton: "account-social",
    formFieldInput: "account-input",
    formFieldLabel: "account-label",
    footer: "account-footer",
    footerActionLink: "account-link",
    dividerLine: "account-divider",
  },
};

export const localization = {
  ...enUS,
  signIn: {
    ...enUS.signIn,
    start: {
      ...enUS.signIn?.start,
      title: "Log in to Mivlet",
      subtitle: "Welcome back. Pick up where you left off.",
      actionText: "New here?",
    },
  },
  signUp: {
    ...enUS.signUp,
    start: {
      ...enUS.signUp?.start,
      title: "Create your account",
      subtitle: "Your personal AI workspace starts here.",
      actionLink: "Log in",
    },
  },
  oauthConsent: {
    ...enUS.oauthConsent,
    action__allow: "Allow access",
    action__deny: "Cancel",
    // Keep the SDK's actual application, account, scope and redirect details.
  },
};
