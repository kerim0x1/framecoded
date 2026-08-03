import type { IRSite, IRPage, IRFavicon } from "../ir/types.js";

interface MetaItem {
  [k: string]: string;
}

function jsObject(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

const OPEN_GRAPH_URL_KEYS = new Set([
  "url",
  "image",
  "image:url",
  "image:secure_url",
  "video",
  "video:url",
  "video:secure_url",
  "audio",
  "audio:url",
  "audio:secure_url",
]);
const TWITTER_URL_KEYS = new Set(["image", "image:src", "player", "player:stream"]);

function contentMetaLiteral(kind: "name" | "property", key: string, value: string): string {
  return `{ ${kind}: ${JSON.stringify(key)}, content: ${value} }`;
}

/** Convert URLs pointing at the captured Framer origin into deployment-relative values. */
function deploymentUrlValue(value: string, site: IRSite): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const parsed = new URL(value);
    for (const candidate of [site.baseUrl, site.source.origin]) {
      if (!candidate || !/^https?:\/\//i.test(candidate)) continue;
      if (parsed.origin === new URL(candidate).origin) {
        return parsed.pathname + parsed.search + parsed.hash;
      }
    }
  } catch {
    return value;
  }
  return value;
}

function deploymentJsonLdValue(value: unknown, site: IRSite): unknown {
  if (typeof value === "string") return deploymentUrlValue(value, site);
  if (Array.isArray(value)) return value.map((entry) => deploymentJsonLdValue(entry, site));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        deploymentJsonLdValue(entry, site),
      ]),
    );
  }
  return value;
}

/** The object literal for a page route's `head: () => (...)`. */
export function pageHeadLiteral(page: IRPage, site: IRSite): string {
  const meta: string[] = [];

  const title = page.meta.title ?? site.name;
  if (title) meta.push(jsObject({ title }));
  if (page.meta.description) {
    meta.push(contentMetaLiteral("name", "description", JSON.stringify(page.meta.description)));
  }
  if (page.meta.robots) {
    meta.push(contentMetaLiteral("name", "robots", JSON.stringify(page.meta.robots)));
  }

  // Open Graph
  const og: Record<string, string> = { type: "website", ...page.meta.openGraph };
  if (!og["title"] && title) og["title"] = title;
  if (!og["description"] && page.meta.description) og["description"] = page.meta.description;
  og["url"] ??= "";
  for (const [k, v] of Object.entries(og)) {
    const value = k === "url"
      ? `siteUrl(${JSON.stringify(page.path)})`
      : OPEN_GRAPH_URL_KEYS.has(k)
        ? `siteAssetUrl(${JSON.stringify(deploymentUrlValue(v, site))})`
        : JSON.stringify(v);
    meta.push(contentMetaLiteral("property", `og:${k}`, value));
  }

  // Twitter
  const tw: Record<string, string> = { card: "summary_large_image", ...page.meta.twitter };
  for (const [k, v] of Object.entries(tw)) {
    const value = TWITTER_URL_KEYS.has(k)
      ? `siteAssetUrl(${JSON.stringify(deploymentUrlValue(v, site))})`
      : JSON.stringify(v);
    meta.push(contentMetaLiteral("name", `twitter:${k}`, value));
  }

  // Canonical always follows the configured deployment domain, never the Framer source.
  const canonicalPath = canonicalPathname(page.meta.canonical, page.path);
  const links = [`{ rel: "canonical", href: siteUrl(${JSON.stringify(canonicalPath)}) }`];

  return `{
  meta: [
    ${meta.join(",\n    ")}
  ],
  links: [
    ${links.join(",\n    ")}
  ],
}`;
}

/** JSON-LD <script> tags to render inside a page route component. */
export function jsonLdScriptsJsx(page: IRPage, site: IRSite): string {
  const blocks = page.meta.jsonLd.map((block) => deploymentJsonLdValue(block, site));
  // Ensure at least a WebSite/WebPage node for richer results.
  if (!blocks.length && site.baseUrl) {
    blocks.push({
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: page.meta.title ?? site.name,
      description: page.meta.description ?? undefined,
      url: page.path,
    });
  }
  return blocks
    .map(
      (b) =>
        `<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: siteJsonLd(${JSON.stringify(b)}) }} />`,
    )
    .join("\n      ");
}

/** Root route head: charset, viewport, theme defaults, and favicons. */
export function rootHeadLiteral(site: IRSite): string {
  const meta: MetaItem[] = [
    { charSet: "utf-8" },
    { name: "viewport", content: "width=device-width, initial-scale=1" },
    { name: "generator", content: "framecoded (from Framer)" },
  ];
  if (site.name) meta.push({ name: "apple-mobile-web-app-title", content: site.name });
  if (site.pages[0]?.meta.openGraph["site_name"] ?? site.name)
    meta.push({ property: "og:site_name", content: site.pages[0]?.meta.openGraph["site_name"] ?? site.name });

  const links: MetaItem[] = [...faviconLinks(site.favicons), ...fontLinks(site)];
  return jsObject({ meta, links });
}

/** Google Fonts <link>s for the families used in the design (best-effort, graceful fallback). */
export function fontLinks(site: IRSite): MetaItem[] {
  const families = site.fonts.filter((f) => f.google !== false).map((f) => f.family);
  if (!families.length) return [];
  const params = families
    .map((fam) => `family=${encodeURIComponent(fam).replace(/%20/g, "+")}:wght@300;400;500;600;700`)
    .join("&");
  return [
    { rel: "preconnect", href: "https://fonts.googleapis.com" },
    { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
    { rel: "stylesheet", href: `https://fonts.googleapis.com/css2?${params}&display=swap` },
  ];
}

export function faviconLinks(favicons: IRFavicon[]): MetaItem[] {
  const out: MetaItem[] = [];
  for (const f of favicons) {
    const item: MetaItem = { rel: f.rel, href: f.localFile ? `/${f.localFile}` : f.href };
    if (f.media) item.media = f.media;
    if (f.type) item.type = f.type;
    if (f.sizes) item.sizes = f.sizes;
    out.push(item);
  }
  return out;
}

/** Shared deployment-domain helper used by route head metadata and JSON-LD. */
export function siteConfigTs(_site: IRSite): string {
  return String.raw`
function normalizedSiteUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    const normalized = parsed.toString();
    return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  } catch {
    return undefined;
  }
}

function requiredSiteUrl(value: string | undefined): string {
  const normalized = normalizedSiteUrl(value?.trim());
  if (!normalized) {
    throw new Error("[framecoded] VITE_SITE_URL is required and must be an absolute http(s) URL.");
  }
  return normalized;
}

export const SITE_URL = requiredSiteUrl(import.meta.env.VITE_SITE_URL);

export function siteUrl(path = "/"): string {
  if (/^https?:\/\//i.test(path)) {
    const parsed = new URL(path);
    path = parsed.pathname + parsed.search + parsed.hash;
  }
  let relative = path || "/";
  while (relative.startsWith("/")) relative = relative.slice(1);
  return new URL(relative, SITE_URL + "/").toString();
}

export function siteAssetUrl(value: string): string {
  if (!value || /^(data:|blob:|mailto:|tel:)/i.test(value)) return value;
  if (value.startsWith("/") && !value.startsWith("//")) return siteUrl(value);
  if (!/^(https?:)?\/\//i.test(value)) return siteUrl(value);
  try {
    return new URL(value, SITE_URL).toString();
  } catch {
    return value;
  }
}

function rewriteJsonLd(value: unknown): unknown {
  if (typeof value === "string") {
    return /^(https?:)?\/\//i.test(value) || (value.startsWith("/") && !value.startsWith("//"))
      ? siteAssetUrl(value)
      : value;
  }
  if (Array.isArray(value)) return value.map(rewriteJsonLd);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, rewriteJsonLd(entry)]),
    );
  }
  return value;
}

export function siteJsonLd(value: unknown): string {
  return JSON.stringify(rewriteJsonLd(value));
}
`;
}

/** Build-time SEO writer. It reads the same VITE_SITE_URL used by the React app. */
export function seoGeneratorScript(site: IRSite): string {
  const paths = site.pages.map((page) => page.path).filter((path) => !path.includes("$"));
  return String.raw`import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const PAGE_PATHS = ${JSON.stringify(paths)};
const root = process.cwd();

async function readEnv(name) {
  try {
    const text = await readFile(resolve(root, name), "utf8");
    const values = {};
    for (const rawLine of text.split(/\r?\n/)) {
      const match = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      let value = match[2] || "";
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      } else {
        value = value.replace(/\s+#.*$/, "").trim();
      }
      values[match[1]] = value;
    }
    return values;
  } catch {
    return {};
  }
}

function normalizeSiteUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
    const normalized = parsed.toString();
    return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  } catch {
    throw new Error("VITE_SITE_URL must be an absolute http(s) URL, received: " + JSON.stringify(value));
  }
}

function absoluteUrl(siteUrl, path) {
  let relative = path || "/";
  while (relative.startsWith("/")) relative = relative.slice(1);
  return new URL(relative, siteUrl + "/").toString();
}

function escapeXml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const fileEnv = { ...(await readEnv(".env")), ...(await readEnv(".env.local")) };
const configuredSiteUrl = process.env.VITE_SITE_URL || fileEnv.VITE_SITE_URL;
if (!configuredSiteUrl) {
  throw new Error("VITE_SITE_URL is required. Add it to .env before running dev or build.");
}
const siteUrl = normalizeSiteUrl(configuredSiteUrl);
const urls = PAGE_PATHS.map((path) => "  <url>\n    <loc>" + escapeXml(absoluteUrl(siteUrl, path)) + "</loc>\n  </url>").join("\n");
const sitemap = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n" + urls + "\n</urlset>\n";
const robots = "User-agent: *\nAllow: /\n\nSitemap: " + absoluteUrl(siteUrl, "/sitemap.xml") + "\n";

await mkdir(resolve(root, "public"), { recursive: true });
await Promise.all([
  writeFile(resolve(root, "public", "sitemap.xml"), sitemap, "utf8"),
  writeFile(resolve(root, "public", "robots.txt"), robots, "utf8"),
]);
console.log("[framecoded] SEO files generated for " + siteUrl);
`;
}

function canonicalPathname(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  try {
    const parsed = new URL(value, "https://framecoded.local");
    return parsed.pathname + parsed.search;
  } catch {
    return fallback;
  }
}
