import { parse } from "node-html-parser";
import { log } from "../../util/log.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 framecoded/0.1";

export interface FetchedPage {
  requestedUrl: string;
  finalUrl: string;
  html: string;
}

export async function fetchHtml(url: string): Promise<FetchedPage> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url} — HTTP ${res.status} ${res.statusText}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("html")) {
    throw new Error(`${url} did not return HTML (content-type: ${ct || "unknown"})`);
  }
  const html = await res.text();
  return { requestedUrl: url, finalUrl: res.url || url, html };
}

export async function fetchBinary(url: string): Promise<{ data: Buffer; contentType: string }> {
  const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
  if (!res.ok) throw new Error(`Failed to fetch asset ${url} — HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { data: buf, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
}

/**
 * Find same-origin internal links worth turning into routes.
 * Framer sites use real <a href="/path"> for internal navigation.
 */
export function discoverInternalLinks(html: string, origin: string): string[] {
  const root = parse(html);
  const found = new Set<string>();
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (!href) continue;
    const abs = resolveUrl(href, origin);
    if (!abs) continue;
    const u = new URL(abs);
    if (u.origin !== new URL(origin).origin) continue; // same-origin only
    // Skip anchors, files, query-heavy urls.
    if (/\.(png|jpe?g|svg|webp|gif|pdf|zip|mp4|webm|ico|css|js|json|xml)$/i.test(u.pathname)) continue;
    const clean = u.origin + u.pathname.replace(/\/+$/, "");
    found.add(clean === u.origin ? clean + "/" : clean);
  }
  return [...found];
}

export function resolveUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export interface CrawlOptions {
  maxPages: number;
  /** When false, only the entry page is fetched. */
  crawl: boolean;
}

export async function crawlSite(
  entryUrl: string,
  options: CrawlOptions,
): Promise<{ origin: string; pages: FetchedPage[] }> {
  const entry = await fetchHtml(entryUrl);
  const origin = new URL(entry.finalUrl).origin;
  const pages: FetchedPage[] = [entry];

  if (!options.crawl) return { origin, pages };

  const seen = new Set<string>([normalize(entry.finalUrl)]);
  const queue = discoverInternalLinks(entry.html, origin).filter((u) => !seen.has(normalize(u)));

  while (queue.length && pages.length < options.maxPages) {
    const next = queue.shift()!;
    const key = normalize(next);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      log.debug(`crawling ${next}`);
      const page = await fetchHtml(next);
      pages.push(page);
      for (const link of discoverInternalLinks(page.html, origin)) {
        if (!seen.has(normalize(link))) queue.push(link);
      }
    } catch (err) {
      log.warn(`skipped ${next}: ${(err as Error).message}`);
    }
  }
  return { origin, pages };
}

function normalize(url: string): string {
  try {
    const u = new URL(url);
    return (u.origin + u.pathname).replace(/\/+$/, "") || u.origin;
  } catch {
    return url;
  }
}
