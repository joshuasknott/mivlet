//! Native-only credentials and a closed, read-only API surface for tenant plugins.
//! Neither tools nor provider pagination may choose a credential destination.
use std::collections::BTreeMap;

use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::models::{
    ConnectorAccountSummary, ConnectorCapabilityRequest, ConnectorCapabilityResult,
    ConnectorCommandError, ConnectorHealth,
};

pub(crate) const IDS: &[&str] = &[
    "outlook",
    "microsoft-teams",
    "zoom",
    "linkedin",
    "instagram",
    "youtube",
    "google-ads",
    "meta-ads",
    "shopify",
    "docusign",
    "greenhouse",
    "lever",
    "workday",
];
const MAX_RESPONSE: usize = 1_048_576;

// Intentionally no Debug: this object is confined to the native credential path.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Credential {
    pub token: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub account_id: String,
    #[serde(default)]
    pub developer_token: String,
    #[serde(default)]
    pub login_customer_id: String,
}

pub(crate) fn error(id: &str, code: &str, message: &str) -> ConnectorCommandError {
    ConnectorCommandError {
        connector_id: id.into(),
        code: code.into(),
        message: message.into(),
        retryable: matches!(code, "rate-limited" | "provider-unavailable"),
        retry_after: None,
    }
}

fn invalid(id: &str) -> ConnectorCommandError {
    error(
        id,
        "invalid-request",
        "This plugin's input or credential configuration is invalid. Check its setup instructions.",
    )
}

fn safe_text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

fn segment(value: &str) -> bool {
    safe_text(value, 256)
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.:@=".contains(&c))
}

fn digits(value: &str) -> bool {
    !value.is_empty() && value.len() <= 32 && value.bytes().all(|b| b.is_ascii_digit())
}

fn parse_base(id: &str, value: &str) -> Result<Url, ConnectorCommandError> {
    if value.contains('%') || value.contains("/../") || value.contains("/./") {
        return Err(invalid(id));
    }
    let url = Url::parse(value).map_err(|_| invalid(id))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid(id));
    }
    Ok(url)
}

fn tenant_host(host: &str, suffix: &str) -> bool {
    host.strip_suffix(suffix).is_some_and(|label| {
        !label.is_empty()
            && label
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    })
}

fn validate(id: &str, c: &mut Credential, stored: bool) -> Result<(), ConnectorCommandError> {
    if !IDS.contains(&id) || !safe_text(&c.token, 16_384) || c.token.trim() != c.token {
        return Err(invalid(id));
    }
    if id != "google-ads" && (!c.developer_token.is_empty() || !c.login_customer_id.is_empty()) {
        return Err(invalid(id));
    }
    if !matches!(id, "instagram" | "docusign") && !c.account_id.is_empty() {
        return Err(invalid(id));
    }
    match id {
        "shopify" => {
            let url = parse_base(id, &c.base_url)?;
            if !tenant_host(url.host_str().unwrap_or_default(), ".myshopify.com")
                || url.path() != "/"
            {
                return Err(invalid(id));
            }
            c.base_url = url.as_str().trim_end_matches('/').into();
        }
        "workday" => {
            let url = parse_base(id, &c.base_url)?;
            let path = url.path().trim_matches('/').split('/').collect::<Vec<_>>();
            let host = url.host_str().unwrap_or_default();
            if !(tenant_host(host, ".myworkday.com") || tenant_host(host, ".workday.com"))
                || path.len() != 4
                || path[..3] != ["api", "staffing", "v7"]
                || !segment(path[3])
            {
                return Err(invalid(id));
            }
            c.base_url = url.as_str().trim_end_matches('/').into();
        }
        "docusign" => {
            if c.base_url.is_empty() {
                c.base_url = "https://account.docusign.com".into();
            }
            let url = parse_base(id, &c.base_url)?;
            let host = url.host_str().unwrap_or_default();
            let allowed = if stored {
                matches!(
                    host,
                    "demo.docusign.net"
                        | "www.docusign.net"
                        | "na2.docusign.net"
                        | "na3.docusign.net"
                        | "na4.docusign.net"
                        | "ca.docusign.net"
                        | "eu.docusign.net"
                        | "au.docusign.net"
                )
            } else {
                matches!(host, "account.docusign.com" | "account-d.docusign.com")
            };
            if !allowed
                || url.path() != "/"
                || (!c.account_id.is_empty() && !segment(&c.account_id))
            {
                return Err(invalid(id));
            }
            c.base_url = url.as_str().trim_end_matches('/').into();
        }
        _ if !c.base_url.is_empty() => return Err(invalid(id)),
        _ => {}
    }
    if id == "instagram" && !digits(&c.account_id) {
        return Err(invalid(id));
    }
    if id == "google-ads"
        && (!safe_text(&c.developer_token, 2048)
            || (!c.login_customer_id.is_empty() && !digits(&c.login_customer_id)))
    {
        return Err(invalid(id));
    }
    Ok(())
}

struct ReadRequest {
    method: Method,
    url: Url,
    body: Option<Value>,
    pointer: &'static str,
}

fn get(url: String, pointer: &'static str) -> Result<ReadRequest, ConnectorCommandError> {
    Ok(ReadRequest {
        method: Method::GET,
        url: Url::parse(&url).map_err(|_| invalid("plugin"))?,
        body: None,
        pointer,
    })
}

fn input<'a>(
    r: &'a ConnectorCapabilityRequest,
    name: &str,
) -> Result<&'a str, ConnectorCommandError> {
    r.input
        .get(name)
        .and_then(Value::as_str)
        .filter(|v| segment(v))
        .ok_or_else(|| {
            error(
                &r.connector_id,
                "invalid-request",
                &format!("Provide a valid {name}."),
            )
        })
}

fn date_input(
    r: &ConnectorCapabilityRequest,
    name: &str,
    fallback: String,
) -> Result<String, ConnectorCommandError> {
    match r.input.get(name) {
        None => Ok(fallback),
        Some(Value::String(s))
            if chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok() && s.len() == 10 =>
        {
            Ok(s.clone())
        }
        _ => Err(invalid(&r.connector_id)),
    }
}

fn map_read(
    c: &Credential,
    r: &ConnectorCapabilityRequest,
) -> Result<ReadRequest, ConnectorCommandError> {
    let id = r.connector_id.as_str();
    if r.input.len() > 8 || r.input.values().any(|v| v.to_string().len() > 4096) {
        return Err(invalid(id));
    }
    let extra: &[&str] = match (id, r.capability.as_str()) {
        ("outlook", "messages.list")
        | ("shopify", "products.list" | "orders.list")
        | ("lever", "opportunities.list") => &["query"],
        ("microsoft-teams", "messages.list") => &["chatId"],
        ("instagram", "comments.list") => &["mediaId"],
        ("youtube", "playlist-items.list") => &["playlistId"],
        ("youtube", "comments.list") => &["videoId"],
        ("google-ads", "campaigns.list") => &["customerId"],
        ("meta-ads", "campaigns.list" | "insights.list") => &["accountId"],
        ("docusign", "envelopes.list") => &["from"],
        ("zoom", "recordings.list") => &["from", "to"],
        ("workday", "workers.list") => &["offset"],
        (_, capability) if capability.ends_with(".read") && capability != "profile.read" => &["id"],
        ("youtube", "videos.list") | ("docusign", "recipients.list") => &["id"],
        _ => &[],
    };
    if r.input
        .keys()
        .any(|key| key != "limit" && !extra.contains(&key.as_str()))
    {
        return Err(error(
            id,
            "invalid-request",
            "This capability received an unsupported input field. Use the advertised fields only.",
        ));
    }
    let limit = match r.input.get("limit") {
        None => 20,
        Some(n) => n
            .as_u64()
            .filter(|n| (1..=50).contains(n))
            .ok_or_else(|| invalid(id))?,
    };
    let query = r
        .input
        .get("query")
        .map(|v| {
            v.as_str()
                .filter(|v| safe_text(v, 500))
                .ok_or_else(|| invalid(id))
        })
        .transpose()?;
    let mut out = match (id, r.capability.as_str()) {
        ("outlook", "messages.list") => get("https://graph.microsoft.com/v1.0/me/messages".into(), "/value")?,
        ("outlook", "messages.read") => get(format!("https://graph.microsoft.com/v1.0/me/messages/{}", input(r, "id")?), "")?,
        ("outlook", "events.list") => get("https://graph.microsoft.com/v1.0/me/events".into(), "/value")?,
        ("microsoft-teams", "chats.list") => get("https://graph.microsoft.com/v1.0/me/chats".into(), "/value")?,
        ("microsoft-teams", "messages.list") => get(format!("https://graph.microsoft.com/v1.0/chats/{}/messages", input(r, "chatId")?), "/value")?,
        ("zoom", "meetings.list") => get("https://api.zoom.us/v2/users/me/meetings".into(), "/meetings")?,
        ("zoom", "meetings.read") => get(format!("https://api.zoom.us/v2/meetings/{}", input(r, "id")?), "")?,
        ("zoom", "recordings.list") => get("https://api.zoom.us/v2/users/me/recordings".into(), "/meetings")?,
        ("linkedin", "profile.read") => get("https://api.linkedin.com/v2/userinfo".into(), "")?,
        ("instagram", "profile.read") => get(format!("https://graph.facebook.com/v26.0/{}?fields=id,username,name,biography,media_count", c.account_id), "")?,
        ("instagram", "media.list") => get(format!("https://graph.facebook.com/v26.0/{}/media?fields=id,caption,media_type,permalink,timestamp", c.account_id), "/data")?,
        ("instagram", "comments.list") => {
            let media = input(r, "mediaId")?; if !digits(media) { return Err(invalid(id)); }
            get(format!("https://graph.facebook.com/v26.0/{media}/comments?fields=id,text,timestamp,username"), "/data")?
        }
        ("youtube", "channels.list") => get("https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails,statistics&mine=true".into(), "/items")?,
        ("youtube", "playlist-items.list") => get(format!("https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId={}", input(r, "playlistId")?), "/items")?,
        ("youtube", "videos.list") => get(format!("https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id={}", input(r, "id")?), "/items")?,
        ("youtube", "comments.list") => get(format!("https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&textFormat=plainText&videoId={}", input(r, "videoId")?), "/items")?,
        ("google-ads", "customers.list") => get("https://googleads.googleapis.com/v25/customers:listAccessibleCustomers".into(), "/resourceNames")?,
        ("google-ads", "campaigns.list") => {
            let customer = input(r, "customerId")?; if !digits(customer) { return Err(invalid(id)); }
            let mut req = get(format!("https://googleads.googleapis.com/v25/customers/{customer}/googleAds:search"), "/results")?;
            req.method = Method::POST;
            req.body = Some(json!({"query": format!("SELECT campaign.id, campaign.name, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_30_DAYS LIMIT {limit}")})); req
        }
        ("meta-ads", "accounts.list") => get("https://graph.facebook.com/v26.0/me/adaccounts?fields=id,name,account_status,currency".into(), "/data")?,
        ("meta-ads", "campaigns.list" | "insights.list") => {
            let account = input(r, "accountId")?; if !digits(account) { return Err(invalid(id)); }
            let path = if r.capability == "campaigns.list" { "campaigns?fields=id,name,status,objective" } else { "insights?fields=account_id,account_name,impressions,clicks,spend,date_start,date_stop&date_preset=last_30d" };
            get(format!("https://graph.facebook.com/v26.0/act_{account}/{path}"), "/data")?
        }
        ("shopify", "products.list" | "orders.list") => {
            let (root, fields) = if r.capability == "products.list" { ("products", "id title handle status totalInventory updatedAt") } else { ("orders", "id name createdAt displayFinancialStatus displayFulfillmentStatus totalPriceSet { shopMoney { amount currencyCode } }") };
            let mut req = get(format!("{}/admin/api/2026-07/graphql.json", c.base_url), if root == "products" { "/data/products/nodes" } else { "/data/orders/nodes" })?;
            req.method = Method::POST;
            req.body = Some(json!({"query": format!("query($limit:Int!,$query:String,$cursor:String) {{ {root}(first:$limit,query:$query,after:$cursor) {{ nodes {{ {fields} }} pageInfo {{ hasNextPage endCursor }} }} }}"), "variables":{"limit":limit,"query":query,"cursor":r.cursor}})); req
        }
        ("docusign", "envelopes.list") => get(format!("{}/restapi/v2.1/accounts/{}/envelopes", c.base_url, c.account_id), "/envelopes")?,
        ("docusign", "envelopes.read" | "recipients.list") => get(format!("{}/restapi/v2.1/accounts/{}/envelopes/{}{}", c.base_url, c.account_id, input(r, "id")?, if r.capability == "recipients.list" { "/recipients" } else { "" }), "")?,
        ("greenhouse", "jobs.list" | "candidates.list" | "applications.list") => get(format!("https://harvest.greenhouse.io/v3/{}", r.capability.trim_end_matches(".list")), "")?,
        ("lever", "opportunities.list" | "users.list") => get(format!("https://api.lever.co/v1/{}", r.capability.trim_end_matches(".list")), "/data")?,
        ("lever", "opportunities.read") => get(format!("https://api.lever.co/v1/opportunities/{}", input(r, "id")?), "/data")?,
        ("workday", "workers.list") => get(format!("{}/workers", c.base_url), "/data")?,
        ("workday", "workers.read") => get(format!("{}/workers/{}", c.base_url, input(r, "id")?), "")?,
        _ => return Err(error(id, "invalid-request", "This read capability is not implemented for the selected plugin.")),
    };
    if r.capability.ends_with(".list") && !matches!(id, "shopify" | "google-ads") {
        let page_key = match id {
            "outlook" | "microsoft-teams" => "$top",
            "zoom" => "page_size",
            "youtube" => "maxResults",
            "greenhouse" => "per_page",
            "docusign" => "count",
            _ => "limit",
        };
        out.url
            .query_pairs_mut()
            .append_pair(page_key, &limit.to_string());
    }
    if id == "outlook" {
        if r.capability == "messages.list" {
            out.url.query_pairs_mut().append_pair(
                "$select",
                "id,subject,from,receivedDateTime,bodyPreview,webLink",
            );
        }
        if let Some(query) = query {
            if r.capability != "messages.list" {
                return Err(invalid(id));
            }
            out.url.query_pairs_mut().append_pair(
                "$search",
                &format!("\"{}\"", query.replace(['"', '\\'], " ")),
            );
        }
    } else if id == "lever" {
        if let Some(query) = query {
            out.url.query_pairs_mut().append_pair("query", query);
        }
    } else if query.is_some() && id != "shopify" {
        return Err(error(id, "invalid-request", "This capability does not support a search query. Read a page and use its IDs to continue."));
    }
    if id == "docusign" && r.capability == "envelopes.list" {
        out.url.query_pairs_mut().append_pair(
            "from_date",
            &date_input(
                r,
                "from",
                (chrono::Utc::now() - chrono::Duration::days(30))
                    .format("%Y-%m-%d")
                    .to_string(),
            )?,
        );
    }
    if id == "zoom" && r.capability == "recordings.list" {
        out.url
            .query_pairs_mut()
            .append_pair(
                "from",
                &date_input(
                    r,
                    "from",
                    (chrono::Utc::now() - chrono::Duration::days(29))
                        .format("%Y-%m-%d")
                        .to_string(),
                )?,
            )
            .append_pair(
                "to",
                &date_input(r, "to", chrono::Utc::now().format("%Y-%m-%d").to_string())?,
            );
    }
    if id == "workday" && r.cursor.is_none() {
        if let Some(offset) = r.input.get("offset") {
            let offset = offset
                .as_u64()
                .filter(|v| *v <= 1_000_000)
                .ok_or_else(|| invalid(id))?;
            out.url
                .query_pairs_mut()
                .append_pair("offset", &offset.to_string());
        }
    }
    if let Some(cursor) = &r.cursor {
        if !safe_text(cursor, 8192) {
            return Err(invalid(id));
        }
        match id {
            "outlook" | "microsoft-teams" => {
                let next = Url::parse(cursor).map_err(|_| invalid(id))?;
                if next.origin() != out.url.origin()
                    || next.path() != out.url.path()
                    || !next.username().is_empty()
                    || next.password().is_some()
                    || next.fragment().is_some()
                    || next
                        .query_pairs()
                        .any(|(k, _)| matches!(k.as_ref(), "access_token" | "token"))
                {
                    return Err(invalid(id));
                }
                out.url = next;
            }
            "youtube" => {
                out.url.query_pairs_mut().append_pair("pageToken", cursor);
            }
            "zoom" => {
                out.url
                    .query_pairs_mut()
                    .append_pair("next_page_token", cursor);
            }
            "instagram" | "meta-ads" => {
                out.url.query_pairs_mut().append_pair("after", cursor);
            }
            "lever" => {
                out.url.query_pairs_mut().append_pair("offset", cursor);
            }
            "greenhouse" => {
                out.url.set_query(None);
                out.url.query_pairs_mut().append_pair("cursor", cursor);
            }
            "shopify" => {}
            "google-ads" if r.capability == "campaigns.list" => {
                out.body.as_mut().unwrap()["pageToken"] = json!(cursor);
            }
            "docusign" | "workday" => {
                if !digits(cursor) {
                    return Err(invalid(id));
                }
                out.url.query_pairs_mut().append_pair(
                    if id == "docusign" {
                        "start_position"
                    } else {
                        "offset"
                    },
                    cursor,
                );
            }
            _ => return Err(invalid(id)),
        }
    }
    Ok(out)
}

async fn send(
    id: &str,
    c: &Credential,
    r: &ReadRequest,
) -> Result<(Value, Option<String>), ConnectorCommandError> {
    crate::ensure_rustls_provider();
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| error(id, "unknown", "Could not initialize plugin transport."))?;
    let request = client
        .request(r.method.clone(), r.url.clone())
        .header("Accept", "application/json");
    let mut request = match id {
        "lever" => request.basic_auth(&c.token, Some("")),
        "shopify" => request.header("X-Shopify-Access-Token", &c.token),
        _ => request.bearer_auth(&c.token),
    };
    if id == "outlook" {
        request = request.header("Prefer", "outlook.body-content-type=\"text\"");
    }
    if id == "google-ads" {
        request = request.header("developer-token", &c.developer_token);
        if !c.login_customer_id.is_empty() {
            request = request.header("login-customer-id", &c.login_customer_id);
        }
    }
    if let Some(body) = &r.body {
        request = request.json(body);
    }
    let mut response = request.send().await.map_err(|_| {
        error(
            id,
            "provider-unavailable",
            "The plugin API could not be reached.",
        )
    })?;
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() { 401 => error(id, "needs-auth", "This token expired or was rejected. Connect again with a current token."), 403 => error(id, "permission-denied", "The token lacks the permission, account access or API entitlement required for this read."), 429 => error(id, "rate-limited", "The provider's request limit was reached. Try again later."), _ => error(id, "provider-unavailable", &format!("The plugin API returned HTTP {}. Check the operation and account configuration.", status.as_u16())) });
    }
    let cursor = if id == "greenhouse" {
        greenhouse_cursor(
            response.headers().get("link").and_then(|v| v.to_str().ok()),
            &r.url,
        )?
    } else {
        None
    };
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        error(
            id,
            "provider-unavailable",
            "The plugin response was interrupted.",
        )
    })? {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err(error(
                id,
                "invalid-request",
                "The plugin response is too large. Use a smaller limit.",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
        error(
            id,
            "provider-unavailable",
            "The plugin returned an invalid JSON response.",
        )
    })?;
    if value.get("error").is_some()
        || value
            .get("errors")
            .is_some_and(|v| v.as_array().is_none_or(|a| !a.is_empty()))
    {
        return Err(error(
            id,
            "provider-unavailable",
            "The API rejected this read. Check the token's scopes and the requested resource.",
        ));
    }
    Ok((value, cursor))
}

fn greenhouse_cursor(
    header: Option<&str>,
    requested: &Url,
) -> Result<Option<String>, ConnectorCommandError> {
    let Some(link) =
        header.and_then(|header| header.split(',').find(|part| part.contains("rel=\"next\"")))
    else {
        return Ok(None);
    };
    let raw = link
        .trim()
        .strip_prefix('<')
        .and_then(|s| s.split_once('>'))
        .map(|(url, _)| url)
        .ok_or_else(|| invalid("greenhouse"))?;
    let next = Url::parse(raw).map_err(|_| invalid("greenhouse"))?;
    let query = next.query_pairs().collect::<Vec<_>>();
    if next.origin() != requested.origin()
        || next.path() != requested.path()
        || !next.username().is_empty()
        || next.password().is_some()
        || next.fragment().is_some()
        || query.len() != 1
        || query[0].0 != "cursor"
        || !safe_text(&query[0].1, 8192)
    {
        return Err(invalid("greenhouse"));
    }
    Ok(Some(query[0].1.to_string()))
}

fn default_capability(id: &str) -> &'static str {
    match id {
        "outlook" => "messages.list",
        "microsoft-teams" => "chats.list",
        "zoom" => "meetings.list",
        "linkedin" | "instagram" => "profile.read",
        "youtube" => "channels.list",
        "google-ads" => "customers.list",
        "meta-ads" => "accounts.list",
        "shopify" => "products.list",
        "docusign" => "envelopes.list",
        "greenhouse" => "jobs.list",
        "lever" => "opportunities.list",
        _ => "workers.list",
    }
}

fn probe_request(id: &str) -> ConnectorCapabilityRequest {
    ConnectorCapabilityRequest {
        connector_id: id.into(),
        capability: default_capability(id).into(),
        input: BTreeMap::from([("limit".into(), json!(1))]),
        cursor: None,
    }
}

pub(crate) async fn prepare(
    id: &str,
    mut c: Credential,
) -> Result<(Credential, ConnectorAccountSummary), ConnectorCommandError> {
    validate(id, &mut c, false)?;
    let identity = match id {
        "outlook" | "microsoft-teams" => Some(
            send(
                id,
                &c,
                &get(
                    "https://graph.microsoft.com/v1.0/me?$select=id,displayName".into(),
                    "",
                )?,
            )
            .await?
            .0,
        ),
        "zoom" => Some(
            send(id, &c, &get("https://api.zoom.us/v2/users/me".into(), "")?)
                .await?
                .0,
        ),
        "docusign" => {
            let identity = send(id, &c, &get(format!("{}/oauth/userinfo", c.base_url), "")?)
                .await?
                .0;
            let accounts = identity["accounts"].as_array().ok_or_else(|| invalid(id))?;
            let account = accounts
                .iter()
                .find(|a| {
                    if c.account_id.is_empty() {
                        a["is_default"] == true || a["is_default"] == "true" || accounts.len() == 1
                    } else {
                        a["account_id"].as_str() == Some(c.account_id.as_str())
                    }
                })
                .ok_or_else(|| {
                    error(
                        id,
                        "invalid-request",
                        "Select an account ID authorized by this Docusign token.",
                    )
                })?;
            c.base_url = account["base_uri"]
                .as_str()
                .ok_or_else(|| invalid(id))?
                .trim_end_matches('/')
                .into();
            c.account_id = account["account_id"]
                .as_str()
                .ok_or_else(|| invalid(id))?
                .into();
            validate(id, &mut c, true)?;
            Some(identity)
        }
        _ => None,
    };
    let request = probe_request(id);
    let read = map_read(&c, &request)?;
    let (value, _) = send(id, &c, &read).await?;
    extract(&request, &read, &value)?;
    let identity = identity.as_ref().unwrap_or(&value);
    let provider_id = identity["id"].as_str().or(identity["sub"].as_str());
    if matches!(
        id,
        "outlook" | "microsoft-teams" | "zoom" | "linkedin" | "instagram" | "docusign"
    ) && provider_id.is_none_or(|s| !safe_text(s, 256))
    {
        return Err(error(
            id,
            "provider-unavailable",
            "The provider did not return a valid account identity.",
        ));
    }
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "{}\0{}\0{}",
                c.base_url,
                c.account_id,
                provider_id.unwrap_or(&c.token)
            )
            .as_bytes()
        )
    );
    let display_name = identity["displayName"]
        .as_str()
        .or(identity["name"].as_str())
        .or(identity["username"].as_str())
        .filter(|s| safe_text(s, 120) && !s.contains(&c.token))
        .unwrap_or(id)
        .to_string();
    Ok((
        c,
        ConnectorAccountSummary {
            id: format!("token-{fingerprint}"),
            display_name,
            handle: None,
            email: None,
            workspace: None,
            avatar_url: None,
        },
    ))
}

fn extract(
    r: &ConnectorCapabilityRequest,
    read: &ReadRequest,
    v: &Value,
) -> Result<(Vec<Value>, Option<String>), ConnectorCommandError> {
    let data = v.pointer(read.pointer).ok_or_else(|| {
        error(
            &r.connector_id,
            "provider-unavailable",
            "The plugin returned an unexpected response shape.",
        )
    })?;
    let items = match data {
        Value::Array(items) => items.clone(),
        Value::Object(_)
            if !r.capability.ends_with(".list") || r.capability == "recipients.list" =>
        {
            vec![data.clone()]
        }
        _ => {
            return Err(error(
                &r.connector_id,
                "provider-unavailable",
                "The plugin returned an unexpected response shape.",
            ))
        }
    };
    let cursor = match r.connector_id.as_str() {
        "outlook" | "microsoft-teams" => v["@odata.nextLink"].as_str(),
        "zoom" => v["next_page_token"].as_str(),
        "instagram" | "meta-ads" if v.pointer("/paging/next").is_some() => {
            v.pointer("/paging/cursors/after").and_then(Value::as_str)
        }
        "youtube" | "google-ads" => v["nextPageToken"].as_str(),
        "lever" if v["hasNext"] == true => v["next"].as_str(),
        "shopify" => {
            let root = if r.capability == "products.list" {
                "products"
            } else {
                "orders"
            };
            let page = &v["data"][root]["pageInfo"];
            if page["hasNextPage"] == true {
                page["endCursor"].as_str()
            } else {
                None
            }
        }
        _ => None,
    }
    .filter(|s| safe_text(s, 8192))
    .map(str::to_string);
    let cursor = cursor.or_else(|| {
        let limit = r.input.get("limit").and_then(Value::as_u64).unwrap_or(20);
        match r.connector_id.as_str() {
            "workday" if items.len() as u64 == limit => Some(
                (r.cursor
                    .as_ref()
                    .and_then(|s| s.parse::<u64>().ok())
                    .or_else(|| r.input.get("offset").and_then(Value::as_u64))
                    .unwrap_or(0)
                    + limit)
                    .to_string(),
            ),
            "docusign" if v["nextUri"].as_str().is_some_and(|s| !s.is_empty()) => v["endPosition"]
                .as_str()
                .and_then(|s| s.parse::<u64>().ok())
                .map(|n| (n + 1).to_string()),
            _ => None,
        }
    });
    Ok((items, cursor))
}

fn redact(value: &mut Value, credential: &Credential) {
    match value {
        Value::Object(map) => {
            map.retain(|key, _| {
                let key = key.to_ascii_lowercase();
                !key.contains("token")
                    && !key.contains("password")
                    && !key.contains("passcode")
                    && !matches!(key.as_str(), "authorization" | "secret" | "api_key")
            });
            for v in map.values_mut() {
                redact(v, credential);
            }
        }
        Value::Array(values) => {
            for v in values {
                redact(v, credential);
            }
        }
        Value::String(s) => {
            if let Ok(mut url) = Url::parse(s) {
                let safe = url
                    .query_pairs()
                    .filter(|(key, _)| {
                        let key = key.to_ascii_lowercase();
                        !key.contains("token")
                            && !key.contains("password")
                            && !key.contains("secret")
                    })
                    .map(|(k, v)| (k.into_owned(), v.into_owned()))
                    .collect::<Vec<_>>();
                if url.query().is_some() {
                    url.set_query(None);
                    if !safe.is_empty() {
                        url.query_pairs_mut().extend_pairs(safe);
                    }
                    *s = url.to_string();
                }
            }
            for secret in [&credential.token, &credential.developer_token] {
                if !secret.is_empty() {
                    *s = s.replace(secret, "[redacted]");
                }
            }
        }
        _ => {}
    }
}

fn safe_cursor(cursor: &str, credential: &Credential) -> bool {
    let contains_secret = |value: &str| {
        [&credential.token, &credential.developer_token]
            .iter()
            .any(|secret| !secret.is_empty() && value.contains(secret.as_str()))
    };
    if contains_secret(cursor) {
        return false;
    }
    let Ok(url) = Url::parse(cursor) else {
        return true;
    };
    url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.query_pairs().all(|(key, value)| {
            let key = key.to_ascii_lowercase();
            let pagination_token = matches!(key.as_str(), "$skiptoken" | "skiptoken");
            !(key.contains("token") && !pagination_token
                || key.contains("password")
                || key.contains("passcode")
                || key.contains("secret")
                || matches!(key.as_str(), "api_key" | "apikey" | "key" | "authorization")
                || contains_secret(&value))
        })
}

pub(crate) async fn read(
    app: &tauri::AppHandle,
    request: ConnectorCapabilityRequest,
) -> Result<ConnectorCapabilityResult, ConnectorCommandError> {
    let id = &request.connector_id;
    if !IDS.contains(&id.as_str()) {
        return Err(invalid(id));
    }
    let scope =
        crate::authorized_scope::active_command_scope(crate::authorized_scope::ScopeAccess::Read)
            .map_err(|_| invalid(id))?;
    let store = crate::store::try_global().ok_or_else(|| invalid(id))?;
    let evidence = crate::connectors::selected_connection_evidence(store, &scope, id)?;
    let encoded = crate::connector_auth::provider_access_token_for_connection(
        app,
        id,
        Some(&evidence.connection_id),
    )
    .await?;
    let mut credential: Credential = serde_json::from_str(&encoded).map_err(|_| invalid(id))?;
    validate(id, &mut credential, true)?;
    let read = map_read(&credential, &request)?;
    crate::connectors::require_unchanged_connection_evidence(store, &scope, id, &evidence)?;
    let (value, header_cursor) = send(id, &credential, &read).await?;
    let (mut items, next_cursor) = extract(&request, &read, &value)?;
    for item in &mut items {
        redact(item, &credential);
    }
    crate::connectors::require_unchanged_connection_evidence(store, &scope, id, &evidence)?;
    let next_cursor = next_cursor
        .or(header_cursor)
        .filter(|cursor| safe_cursor(cursor, &credential));
    Ok(ConnectorCapabilityResult {
        connector_id: id.clone(),
        capability: request.capability,
        items,
        next_cursor,
        rate_limit_remaining: None,
        rate_limit_reset_at: None,
    })
}

pub(crate) async fn probe_health(app: &tauri::AppHandle, id: &str) -> ConnectorHealth {
    let result = read(app, probe_request(id)).await;
    ConnectorHealth {
        state: if result.is_ok() { "healthy" } else { "error" }.into(),
        summary: result
            .map(|_| {
                "Read access verified. Additional operations require their documented permissions."
                    .into()
            })
            .unwrap_or_else(|e| e.message),
        checked_at: chrono::Utc::now().to_rfc3339(),
        retry_after: None,
    }
}

#[cfg(test)]
mod tests;
