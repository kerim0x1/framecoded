import type { HTMLElement } from "node-html-parser";
import type { IRMeta, IRFavicon } from "../../ir/types.js";
import { log } from "../../util/log.js";
import { resolveUrl } from "./fetch.js";

export interface ExtractedHead {
  meta: IRMeta;
  favicons: IRFavicon[];
  lang: string;
  /** Detected Google Fonts <link> hrefs for self-host/preconnect. */
  fontLinks: string[];
  siteName?: string;
}

function attr(el: HTMLElement | null, name: string): string | undefined {
  const v = el?.getAttribute(name);
  return v == null || v === "" ? undefined : v;
}

export function extractHead(root: HTMLElement, pageUrl: string): ExtractedHead {
  const head = root.querySelector("head") ?? root;
  const htmlEl = root.querySelector("html");
  const lang = attr(htmlEl, "lang") ?? "en";

  const meta: IRMeta = {
    openGraph: {},
    twitter: {},
    jsonLd: [],
    lang,
  };

  const titleEl = head.querySelector("title");
  if (titleEl) meta.title = decode(titleEl.text.trim());

  for (const m of head.querySelectorAll("meta")) {
    const name = (attr(m, "name") ?? "").toLowerCase();
    const prop = (attr(m, "property") ?? "").toLowerCase();
    const content = attr(m, "content");
    if (!content) continue;
    if (name === "description") meta.description = decode(content);
    else if (name === "robots") meta.robots = content;
    else if (prop.startsWith("og:")) meta.openGraph[prop.slice(3)] = decode(content);
    else if (name.startsWith("twitter:")) meta.twitter[name.slice(8)] = decode(content);
    else if (name.startsWith("og:")) meta.openGraph[name.slice(3)] = decode(content);
  }

  const canonical = head.querySelector('link[rel="canonical"]');
  if (canonical) meta.canonical = attr(canonical, "href");

  // Favicons (light/dark/apple-touch/mask).
  const favicons: IRFavicon[] = [];
  for (const link of head.querySelectorAll("link")) {
    const rel = (attr(link, "rel") ?? "").toLowerCase();
    if (!/(^|\s)(icon|apple-touch-icon|mask-icon|shortcut icon)(\s|$)/.test(rel)) continue;
    const href = attr(link, "href");
    if (!href) continue;
    const abs = resolveUrl(href, pageUrl) ?? href;
    favicons.push({
      rel: rel.replace("shortcut icon", "icon"),
      href: abs,
      media: attr(link, "media"),
      type: attr(link, "type"),
      sizes: attr(link, "sizes"),
    });
  }

  // JSON-LD structured data.
  for (const script of head.querySelectorAll('script[type="application/ld+json"]')) {
    pushJsonLd(meta, script.text);
  }
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    pushJsonLd(meta, script.text);
  }

  // Google Fonts links.
  const fontLinks: string[] = [];
  for (const link of head.querySelectorAll("link")) {
    const href = attr(link, "href") ?? "";
    if (href.includes("fonts.googleapis.com") || href.includes("fonts.gstatic.com")) {
      fontLinks.push(href);
    }
  }

  const siteName = meta.openGraph["site_name"];

  return { meta, favicons: dedupeFavicons(favicons), lang, fontLinks, siteName };
}

function pushJsonLd(meta: IRMeta, raw: string) {
  const text = raw.trim();
  if (!text) return;
  try {
    const parsed = JSON.parse(text);
    if (!meta.jsonLd.some((x) => JSON.stringify(x) === JSON.stringify(parsed))) {
      meta.jsonLd.push(parsed);
    }
  } catch (err) {
    log.debug(`ignored invalid JSON-LD block: ${(err as Error).message}`);
  }
}

function dedupeFavicons(list: IRFavicon[]): IRFavicon[] {
  const seen = new Set<string>();
  const out: IRFavicon[] = [];
  for (const f of list) {
    const key = `${f.rel}|${f.media ?? ""}|${f.href}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(f);
    }
  }
  return out;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&nbsp;": " ",
};

export function decode(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (m) => ENTITIES[m] ?? m);
}
