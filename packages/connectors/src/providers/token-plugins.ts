/** Public setup and capability metadata. Credentials are handled only by Rust. */
export interface TokenPluginDefinition {
  id: string;
  name: string;
  description: string;
  setup: string;
  docs: string;
  capabilities: Record<string, string>;
  fields?: readonly { name: "baseUrl" | "accountId" | "developerToken" | "loginCustomerId"; label: string; placeholder: string; secret?: boolean; optional?: boolean }[];
}

export const tokenPluginDefinitions: readonly TokenPluginDefinition[] = [
  { id: "outlook", name: "Outlook", description: "Read mail and calendar events from your Microsoft account.",
    setup: "Use a Microsoft Graph delegated access token with User.Read and Mail.Read. Calendar reads also require Calendars.Read. Your tenant may require administrator consent.",
    docs: "https://learn.microsoft.com/en-us/graph/auth/", capabilities: { "messages.list": "List mail; optional query.", "messages.read": "Read a message; requires id.", "events.list": "List calendar events." } },
  { id: "microsoft-teams", name: "Microsoft Teams", description: "Read your Teams chats and messages.",
    setup: "Use a Microsoft Graph delegated access token with User.Read and Chat.Read. A work or school account and tenant consent are required.",
    docs: "https://learn.microsoft.com/en-us/graph/api/chat-list?view=graph-rest-1.0", capabilities: { "chats.list": "List your chats.", "messages.list": "Read chat messages; requires chatId." } },
  { id: "zoom", name: "Zoom", description: "Read meetings and cloud recording metadata.",
    setup: "Use a Zoom OAuth access token with user:read:user, meeting:read:list_meetings, meeting:read:meeting and, for recordings, cloud_recording:read:list_user_recordings. Recording access depends on your Zoom plan.",
    docs: "https://developers.zoom.us/docs/api/", capabilities: { "meetings.list": "List scheduled meetings.", "meetings.read": "Read a meeting; requires id.", "recordings.list": "List recording metadata; optional from and to dates (YYYY-MM-DD)." } },
  { id: "linkedin", name: "LinkedIn", description: "Read the basic profile associated with your LinkedIn token.",
    setup: "Use an OAuth access token from an app with Sign In with LinkedIn using OpenID Connect (openid and profile). This integration currently reads your basic profile only; LinkedIn does not grant general feed, messaging or recruiting access through these permissions.",
    docs: "https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2", capabilities: { "profile.read": "Read your basic profile." } },
  { id: "instagram", name: "Instagram", description: "Read a professional Instagram profile, media and comments.",
    setup: "Use a Facebook Login user or Page access token for a linked Instagram Business or Creator account with instagram_basic and pages_read_engagement. Comments also require instagram_manage_comments. Personal accounts are unsupported.",
    docs: "https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/", fields: [{ name: "accountId", label: "Instagram professional account ID", placeholder: "17841400000000000" }],
    capabilities: { "profile.read": "Read the connected professional profile.", "media.list": "List its media.", "comments.list": "List comments; requires mediaId." } },
  { id: "youtube", name: "YouTube", description: "Read your channel, playlists, videos and comments.",
    setup: "Use a Google OAuth access token with youtube.readonly from a project with YouTube Data API v3 enabled. Requests consume your project's API quota.",
    docs: "https://developers.google.com/youtube/v3/docs/", capabilities: { "channels.list": "Read your channels and uploads playlist IDs.", "playlist-items.list": "List playlist items; requires playlistId.", "videos.list": "Read a video; requires id.", "comments.list": "List comment threads; requires videoId." } },
  { id: "google-ads", name: "Google Ads", description: "Read accessible accounts and campaign performance.",
    setup: "Use an OAuth token with the adwords scope and an approved Google Ads developer token. Campaign reads require a customer ID; manager accounts may need a login customer ID. No budgets or campaigns are changed.",
    docs: "https://developers.google.com/google-ads/api/rest/auth", fields: [{ name: "developerToken", label: "Developer token", placeholder: "Google Ads developer token", secret: true }, { name: "loginCustomerId", label: "Manager customer ID (optional)", placeholder: "1234567890", optional: true }],
    capabilities: { "customers.list": "List directly accessible customer resource names.", "campaigns.list": "Read campaign status and last-30-day metrics; requires customerId." } },
  { id: "meta-ads", name: "Meta Ads", description: "Read ad accounts, campaigns and performance.",
    setup: "Use a Meta user or system-user access token with ads_read and access to the ad accounts. Your app may require Advanced Access. No advertising spend or campaign settings are changed.",
    docs: "https://developers.facebook.com/docs/marketing-api/", capabilities: { "accounts.list": "List accessible ad accounts.", "campaigns.list": "List campaigns; requires accountId (digits, without act_).", "insights.list": "Read last-30-day account metrics; requires accountId (digits)." } },
  { id: "shopify", name: "Shopify", description: "Read your store's products and orders.",
    setup: "Use a Shopify Admin API access token with read_products. Orders additionally require read_orders and any applicable protected customer data access. The store domain must end in .myshopify.com.",
    docs: "https://shopify.dev/docs/api/admin-graphql", fields: [{ name: "baseUrl", label: "Store URL", placeholder: "https://your-store.myshopify.com" }],
    capabilities: { "products.list": "List products; optional query.", "orders.list": "List accessible orders; optional query. Usually limited to the last 60 days." } },
  { id: "docusign", name: "Docusign", description: "Read envelopes, their status and recipients.",
    setup: "Use an eSignature OAuth access token with the signature scope. Enter your account ID when you have several accounts; otherwise the default account is used. Use account-d.docusign.com for demo tokens.",
    docs: "https://developers.docusign.com/platform/auth/user-info/", fields: [{ name: "baseUrl", label: "Authorization server", placeholder: "https://account.docusign.com", optional: true }, { name: "accountId", label: "Account ID (optional)", placeholder: "Your eSignature account ID", optional: true }],
    capabilities: { "envelopes.list": "List envelope status changes; optional from date (YYYY-MM-DD; defaults to 30 days ago).", "envelopes.read": "Read an envelope; requires id.", "recipients.list": "Read envelope recipients; requires id." } },
  { id: "greenhouse", name: "Greenhouse", description: "Read jobs, candidates and applications through Harvest.",
    setup: "Use a Greenhouse Harvest v3 OAuth access token with the jobs read scope. Candidate and application reads need their own scopes. List endpoints require a Site Admin authorizing user or an appropriately configured integration service user. API availability depends on your organization's grants.",
    docs: "https://harvestdocs.greenhouse.io/docs/authentication", capabilities: { "jobs.list": "List jobs.", "candidates.list": "List candidates.", "applications.list": "List applications." } },
  { id: "lever", name: "Lever", description: "Read recruiting opportunities and users.",
    setup: "Use a Lever API key with read opportunities access. User reads require read users. API access is controlled by your organization.",
    docs: "https://hire.lever.co/developer/documentation", capabilities: { "opportunities.list": "List opportunities; optional query.", "opportunities.read": "Read an opportunity; requires id.", "users.list": "List users." } },
  { id: "workday", name: "Workday", description: "Read worker records from your Workday tenant.",
    setup: "Use a Workday OAuth access token with tenant security permissions for the Staffing v7 workers API. Enter the Staffing base URL supplied by your administrator. Access remains restricted by the tenant's security domains.",
    docs: "https://developer.workday.com/documentation/GUID-85810465-bcfb-4fdf-a26d-55eaff3968a8-enHYPHENus/", fields: [{ name: "baseUrl", label: "Staffing API base URL", placeholder: "https://tenant.myworkday.com/api/staffing/v7/tenant" }],
    capabilities: { "workers.list": "List workers; optional offset.", "workers.read": "Read a worker; requires id." } },
];

export const tokenPluginFor = (id: string): TokenPluginDefinition | undefined => tokenPluginDefinitions.find((plugin) => plugin.id === id);
