export type LegalDocumentKind = "terms" | "privacy";

export function LegalDocument({ kind }: { kind: LegalDocumentKind }) {
  return (
    <article className="mivlet-legal-document">
      <h1>{kind === "terms" ? "Terms of Service" : "Privacy Policy"}</h1>
      <p className="mivlet-legal-notice">For review · Not yet effective</p>
      <p>
        This document is provided for review. It is not a published agreement or
        a complete privacy notice. Using this preview does not constitute
        acceptance of these proposed terms.
      </p>
      {kind === "terms" ? (
        <>
          <h2>Using Mivlet</h2>
          <p>
            Mivlet is a workspace for working with AI agents. You are
            responsible for the instructions you give, the content you provide,
            and reviewing outputs and actions before relying on them. AI
            responses can be inaccurate.
          </p>
          <h2>Your account and content</h2>
          <p>
            Keep your account secure and only connect services and share content
            you are authorised to use. You retain your rights in your content.
            Use Mivlet lawfully and respect the rights of others.
          </p>
          <h2>Connected services</h2>
          <p>
            AI providers and other connected services have their own terms,
            availability and charges. Review those terms before connecting a
            service.
          </p>
          <h2>Before publication</h2>
          <p>
            The operator’s legal name and contact details, eligibility, licence
            terms, payment and cancellation rules (if applicable), suspension
            and termination, warranties, liability, governing law, dispute
            resolution, change notices and effective date still require
            confirmation and legal review. Applicable statutory rights must be
            preserved.
          </p>
        </>
      ) : (
        <>
          <h2>Account information</h2>
          <p>
            Mivlet uses Clerk for authentication. Signing in by email, Google or
            GitHub involves processing account identifiers and authentication
            information. Social sign-in also involves the provider you select.
          </p>
          <h2>Workspace and connected services</h2>
          <p>
            Mivlet is designed around a local workspace. When you use AI
            providers or connected services, information needed for those
            requests may leave your device. The final notice must describe each
            supported data flow, including any hosted features, diagnostics and
            synchronisation.
          </p>
          <h2>Before publication</h2>
          <p>
            Confirm the data controller and contact details, categories and
            sources of personal data, purposes and lawful bases, recipients and
            processors, international transfers and safeguards, retention
            periods, security practices, cookies and local storage, deletion
            procedures and children’s data practices.
          </p>
          <h2>Your privacy rights</h2>
          <p>
            The final notice must explain applicable access, correction,
            deletion, restriction, portability, objection and consent-withdrawal
            rights, how to exercise them, and how to complain to the relevant
            supervisory authority. Contact details and the effective date are
            still to be supplied.
          </p>
        </>
      )}
    </article>
  );
}
