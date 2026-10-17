import { HOSTED_PUBLIC_WEB_LIMITS, type HostedPublicWebScope } from "@mivlet/protocol";

/** Convenience validation only: native admission and the runner enforce scope. */
export function researchScopeFromPages(value: string): HostedPublicWebScope {
  const pages = value.split(/\r?\n/).map(page => page.trim()).filter(Boolean);
  if (!pages.length || pages.length > HOSTED_PUBLIC_WEB_LIMITS.initialUrls)
    throw new Error(`Enter between 1 and ${HOSTED_PUBLIC_WEB_LIMITS.initialUrls} starting pages, one per line.`);
  const urls = pages.map(page => {
    let url: URL;
    try { url = new URL(page); }
    catch { throw new Error("Use a complete public HTTPS address for each starting page."); }
    if (url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password
      || !url.hostname.includes(".") || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":")
      || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname))
      throw new Error("Starting pages must use public HTTPS websites without a sign-in, IP address, or custom port.");
    url.hash = "";
    return url;
  });
  return { allowedDomains: [...new Set(urls.map(url => url.hostname))], initialUrls: [...new Set(urls.map(url => url.href))] };
}
