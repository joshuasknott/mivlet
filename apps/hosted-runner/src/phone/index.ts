import { PHONE_CONNECTION_ID, readPhoneRelayCapability, type PhoneRelayOperation } from "@mivlet/protocol";
import html from "../../../desktop/src-tauri/src/mcp_server/remote/index.html";
import script from "../../../desktop/src-tauri/src/mcp_server/remote/app.js";
import serviceWorker from "../../../desktop/src-tauri/src/mcp_server/remote/sw.js";
import css from "../../../desktop/src-tauri/src/mcp_server/remote/styles.css";
import icon from "../../../desktop/src-tauri/icons/128x128@2x.png";
import { body, browserSession, json, type PhoneEnv } from "./contracts";
export { PhoneRelayAuthority } from "./authority";

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; manifest-src 'self'; img-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";
function asset(value: string | ArrayBuffer, contentType: string): Response {
  return new Response(value, { headers: { "Content-Type": contentType, "Cache-Control": "no-store",
    "Content-Security-Policy": CSP, "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } });
}
export default {
  async fetch(request: Request, env: PhoneEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.search || request.headers.has("Forwarded") || request.headers.has("X-Forwarded-Host")) return json({ error: "invalid-request" }, 400);
    if (url.pathname === "/health" && request.method === "GET") return json({ status: "ok", service: "mivlet-phone-relay" });
    const upgrade = url.pathname.match(/^\/v1\/phone\/([a-f0-9]{64})\/connect$/);
    if (upgrade) {
      if (request.method !== "GET" || request.headers.has("Origin") || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "native-connection-required" }, 403);
      try {
        const authorization = request.headers.get("Authorization") ?? "";
        if (!authorization.startsWith("MivletPhone ")) return json({ error: "unauthorized" }, 401);
        const cap = await readPhoneRelayCapability(env.MIVLET_PHONE_RELAY_SIGNING_KEY, authorization.slice(12));
        if (cap.connectionId !== upgrade[1]) return json({ error: "scope-mismatch" }, 401);
        return await env.PHONE_RELAY_AUTHORITY.getByName(cap.connectionId).fetch(request);
      } catch { return json({ error: "phone-connection-rejected" }, 401); }
    }
    const path = url.pathname.match(/^\/d\/([a-f0-9]{64})\/remote(?:\/(app\.js|sw\.js|styles\.css|icon\.png|manifest\.webmanifest|connect|consent|session|call|disconnect|push))?$/);
    if (!path || !PHONE_CONNECTION_ID.test(path[1])) return json({ error: "not-found" }, 404);
    const connectionId = path[1];
    const prefix = `/d/${connectionId}`;
    const route = path[2] ?? "";
    if (request.method === "GET") {
      if (route === "") return asset(html.replaceAll('"/remote', `"${prefix}/remote`), "text/html; charset=utf-8");
      if (route === "app.js") return asset(script, "text/javascript; charset=utf-8");
      if (route === "sw.js") {
        const response = asset(serviceWorker, "text/javascript; charset=utf-8");
        response.headers.set("Service-Worker-Allowed", `${prefix}/remote`);
        return response;
      }
      if (route === "styles.css") return asset(css, "text/css; charset=utf-8");
      if (route === "icon.png") return asset(icon, "image/png");
      if (route === "manifest.webmanifest") return json({ id: `${prefix}/remote`, name: "Mivlet", short_name: "Mivlet", start_url: `${prefix}/remote`,
        scope: `${prefix}/remote`, display: "standalone", background_color: "#faf9f7", theme_color: "#faf9f7",
        icons: [{ src: `${prefix}/remote/icon.png`, sizes: "256x256", type: "image/png" }] });
    }
    const operation: PhoneRelayOperation | undefined = request.method === "GET"
      ? route === "session" ? "session" : route === "consent" ? "consent" : route === "push" ? "push-status" : undefined
      : request.method === "POST" ? route === "connect" ? "begin" : route === "call" ? "call" : route === "disconnect" ? "disconnect" : route === "push" ? "push-subscribe" : undefined : undefined;
    if (!operation) return json({ error: "not-found" }, 404);
    // No CORS, cookie auth only here, no native bearer or query-string credentials.
    if (request.method !== "GET" && (request.headers.get("Origin") !== url.origin || request.headers.get("X-Mivlet-Remote") !== "1")) return json({ error: "invalid-origin" }, 403);
    if (request.headers.has("Origin") && request.headers.get("Origin") !== url.origin) return json({ error: "invalid-origin" }, 403);
    try {
      const data = request.method === "POST" ? await body(request) : {};
      const session = browserSession(request.headers, connectionId);
      return await env.PHONE_RELAY_AUTHORITY.getByName(connectionId).forward(connectionId, operation, session, data);
    } catch { return json({ error: "Invalid phone request." }, 400); }
  },
} satisfies ExportedHandler<PhoneEnv>;
