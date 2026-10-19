// Remote MCP transport is split by protocol responsibility while remaining in the
// parent module's scope so the existing account, approval and session fences stay
// unchanged.
include!("remote_transport/http.rs");
include!("remote_transport/oauth_metadata.rs");
include!("remote_transport/oauth_client.rs");
include!("remote_transport/oauth_flow.rs");
include!("remote_transport/helpers.rs");
