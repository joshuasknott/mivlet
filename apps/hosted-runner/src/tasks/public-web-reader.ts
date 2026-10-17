import { hostedTaskSha256, hostedTextContentFailure, HOSTED_PUBLIC_WEB_LIMITS as L, publicWebUrl,
  type HostedPublicWebScope, type HostedPublicWebSource } from "@mivlet/protocol";

export interface PublicPage {
  source: HostedPublicWebSource;
  text: string;
  links: string[];
}
export interface PublicWebReader {
  read(url: string, scope: HostedPublicWebScope, signal: AbortSignal): Promise<PublicPage>;
}
const encoder = new TextEncoder();
const passive = "script,style,noscript,template,iframe,object,embed,svg,math,form,input,textarea,select,button,meta,link,base,[hidden],[inert],[aria-hidden='true']";
const prefix = (value: string, maximum: number) => new TextDecoder().decode(encoder.encode(value).subarray(0, maximum), { stream: true });

/** Global Fetch's final-peer public-network restriction is the SSRF boundary.
 * wrangler.tasks.jsonc requires global_fetch_strictly_public and grants no
 * origin, VPC or private-network binding. This is NOT a claimed DNS/IP pin. */
export const publicWebReader: PublicWebReader = { async read(value, scope, signal) {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(L.readMs)]);
  let url = publicWebUrl(value, scope.allowedDomains);
  let response: Response | undefined;
  for (let redirects = 0; redirects <= L.redirectsPerRead; redirects++) {
    bounded.throwIfAborted();
    if (hostedTextContentFailure(url)) throw new Error("research-secret-url");
    response = await fetch(url, { method: "GET", redirect: "manual", credentials: "omit",
      headers: { accept: "text/html,text/plain;q=0.9", "accept-encoding": "identity", "user-agent": "MivletPublicResearch/1.0" },
      cache: "no-store", signal: bounded });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location"); await response.body?.cancel();
    if (!location || redirects === L.redirectsPerRead) throw new Error("research-redirect-limit");
    url = publicWebUrl(new URL(location, url).href, scope.allowedDomains);
    response = undefined;
  }
  if (!response?.ok || !response.body) { await response?.body?.cancel(); throw new Error("research-page-unavailable"); }
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^text\/(?:html|plain)(?:\s*;|$)/i.test(contentType)
    || /charset\s*=\s*["']?(?!utf-?8\b|us-ascii\b)[^\s;"']+/i.test(contentType)) {
    await response.body.cancel(); throw new Error("research-passive-text-required");
  }
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > L.htmlBytes)) { await response.body.cancel(); throw new Error("research-page-limit"); }
  const chunks: Uint8Array[] = []; let size = 0; const reader = response.body.getReader();
  try {
    for (;;) {
      bounded.throwIfAborted(); const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > L.htmlBytes) throw new Error("research-page-limit"); chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  bounded.throwIfAborted();
  const bytes = new Uint8Array(size); let at = 0; for (const part of chunks) { bytes.set(part, at); at += part.byteLength; }
  return extractPublicPage(bytes, contentType, url, scope, bounded);
} };

/** Fixed passive extraction shared with the actual Workerd acceptance check. */
export async function extractPublicPage(bytes: Uint8Array<ArrayBuffer>, contentType: string, url: string,
  scope: HostedPublicWebScope, signal: AbortSignal): Promise<PublicPage> {
  signal.throwIfAborted();
  let text = ""; let title = ""; const links: string[] = []; let linkBytes = 0; let omitted = false;
  const append = (value: string) => {
    const remaining = Math.max(0, L.pageTextBytes * 2 - text.length);
    if (value.length > remaining) omitted = true;
    text += value.slice(0, remaining);
  };
  if (/^text\/plain/i.test(contentType)) text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  else {
    // Two streaming passes: removed subtrees cannot reach the second pass's
    // text or link callbacks, including default values and hidden form text.
    const clean = new HTMLRewriter().on(passive, { element(element) { element.remove(); } })
      .transform(new Response(bytes, { headers: { "content-type": "text/html; charset=utf-8" } }));
    const extracted = new HTMLRewriter()
      .on("p,div,h1,h2,h3,h4,h5,h6,li,ul,ol,br,hr,section,article,header,footer,table,tr,blockquote,pre", { element(element) {
        append("\n");
        if (element.tagName !== "br" && element.tagName !== "hr") element.onEndTag(() => append("\n"));
      } })
      .on("title", { text(chunk) { if (title.length < 512) title += chunk.text.slice(0, 512 - title.length); } })
      .on("a[href]", { element(element) {
        if (links.length >= L.linksPerPage) return;
        try { const link = publicWebUrl(new URL(element.getAttribute("href") ?? "", url).href, scope.allowedDomains);
          const bytes = encoder.encode(link).length;
          if (!hostedTextContentFailure(link) && !links.includes(link) && linkBytes + bytes <= 4096) { links.push(link); linkBytes += bytes; }
        } catch { /* Out-of-scope links grant no authority. */ }
      } })
      .onDocument({ text(chunk) { append(chunk.text); } })
      .transform(clean);
    const drain = extracted.body!.getReader();
    try { for (;;) { signal.throwIfAborted(); if ((await drain.read()).done) break; } }
    finally { await drain.cancel().catch(() => undefined); drain.releaseLock(); }
  }
  signal.throwIfAborted(); text = text.replace(/\s+/g, " ").trim();
  const truncated = omitted || encoder.encode(text).length > L.pageTextBytes;
  text = prefix(text, L.pageTextBytes); title = prefix(title.replace(/\s+/g, " ").trim(), 256) || url;
  if (!text || hostedTextContentFailure(text) || hostedTextContentFailure(title)) throw new Error("research-page-content-unavailable");
  const contentBytes = encoder.encode(text).length;
  const contentSha256 = await hostedTaskSha256({ finalUri: url, text });
  return { source: { citationId: `web-${contentSha256.slice(0, 24)}`, title, finalUri: url, fetchedAt: new Date().toISOString(), contentSha256, contentBytes, truncated }, text, links };
}
