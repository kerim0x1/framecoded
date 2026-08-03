import { parse as parseHtml } from "node-html-parser";
import type { IRSite, IRPage, IRColorStyle, IRFont, IRFavicon } from "../../ir/types.js";
import { crawlSite } from "./fetch.js";
import { extractHead } from "./meta.js";
import { parseDocument } from "./parse.js";
import { routeFromPathname, toKebabCase } from "../../util/names.js";
import { log } from "../../util/log.js";

export interface PublishedSiteOptions {
  crawl: boolean;
  maxPages: number;
  /** Viewport width used to pick the canonical responsive breakpoint (default 1200). */
  targetWidth?: number;
}

export async function ingestPublishedSite(
  entryUrl: string,
  options: PublishedSiteOptions,
): Promise<IRSite> {
  log.step(`Fetching ${entryUrl}`);
  const { origin, pages: fetched } = await crawlSite(entryUrl, options);
  log.success(`Fetched ${fetched.length} page(s) from ${origin}`);

  const pages: IRPage[] = [];
  const favicons = new Map<string, IRFavicon>();
  const fontFamilies = new Map<string, IRFont>();
  const tokenColors = new Map<string, string>();
  const assets = new Set<string>();
  let globalCss = "";
  let svgSprite: string | undefined;
  let lang = "en";
  let siteName: string | undefined;

  const usedRoutes = new Set<string>();
  const usedNames = new Set<string>();

  for (const page of fetched) {
    const root = parseHtml(page.html);
    const head = extractHead(root, page.finalUrl);
    lang = head.lang || lang;
    siteName = siteName ?? head.siteName;

    for (const f of head.favicons) favicons.set(`${f.rel}|${f.media ?? ""}|${f.href}`, f);
    for (const link of head.fontLinks) registerGoogleFonts(link, fontFamilies);

    const parsed = parseDocument(page.html, page.finalUrl, { targetWidth: options.targetWidth });
    for (const [k, v] of parsed.tokenColors) tokenColors.set(k, v);
    for (const a of parsed.assets) assets.add(a);
    if (!globalCss) {
      // Framer's link colours are declared inside a rule scoped to its own generated
      // class names, which a clean rebuild replaces — the declaration survives but
      // reaches nothing. Re-declare them at the root so they stay inheritable.
      const rootVars = [...parsed.linkVars].map(([k, v]) => `  ${k}: ${v};`).join("\n");
      globalCss = (rootVars ? `:root {\n${rootVars}\n}\n\n` : "") + parsed.rootCss;
    }
    if (!svgSprite && parsed.svgSprite) svgSprite = parsed.svgSprite;
    if (parsed.variantsCollapsed) {
      log.debug(`${page.finalUrl}: collapsed ${parsed.variantsCollapsed} breakpoint variant(s)`);
    }

    const { path, name } = uniqueRoute(page.finalUrl, usedRoutes, usedNames);
    pages.push({ path, name, meta: head.meta, root: parsed.root });
    log.debug(`parsed ${path} (${name}) - ${parsed.nodeCount} nodes`);
  }

  // Ensure there is a home route.
  if (!pages.some((p) => p.path === "/")) {
    if (pages[0]) pages[0].path = "/";
  }

  const colorStyles = buildColorStyles(tokenColors);
  const name = siteName ?? deriveName(pages, origin);

  return {
    name,
    source: { type: "published-site", origin: entryUrl },
    baseUrl: origin,
    pages,
    favicons: [...favicons.values()],
    colorStyles,
    fonts: [...fontFamilies.values()],
    globalCss,
    svgSprite,
    assets: [...assets].map((url) => ({ url })),
    lang,
  };
}

function uniqueRoute(
  url: string,
  usedRoutes: Set<string>,
  usedNames: Set<string>,
): { path: string; name: string } {
  const { pathname } = new URL(url);
  let { path, name } = routeFromPathname(pathname);
  let p = path;
  let i = 2;
  while (usedRoutes.has(p)) p = `${path}-${i++}`;
  usedRoutes.add(p);
  let n = name;
  i = 2;
  while (usedNames.has(n)) n = `${name}${i++}`;
  usedNames.add(n);
  return { path: p, name: n };
}

function buildColorStyles(tokens: Map<string, string>): IRColorStyle[] {
  const out: IRColorStyle[] = [];
  let i = 1;
  for (const [name, value] of tokens) {
    if (!name.startsWith("--token-")) continue;
    if (!isColor(value)) continue;
    out.push({
      name: `color ${i}`,
      varName: name, // keep Framer's token name so existing var() references keep working
      light: value,
    });
    i++;
  }
  return out;
}

function isColor(v: string): boolean {
  const s = v.trim().toLowerCase();
  return (
    /^#([0-9a-f]{3,8})$/.test(s) ||
    s.startsWith("rgb") ||
    s.startsWith("hsl") ||
    s.startsWith("oklch") ||
    s.startsWith("color(")
  );
}

function registerGoogleFonts(href: string, map: Map<string, IRFont>) {
  try {
    const u = new URL(href, "https://fonts.googleapis.com");
    for (const fam of u.searchParams.getAll("family")) {
      const [family, spec] = fam.split(":");
      const weights = spec
        ? [...spec.matchAll(/(\d{3})/g)].map((m) => parseInt(m[1]!, 10))
        : [];
      if (family && !map.has(family)) {
        map.set(family, { family: family.replace(/\+/g, " "), weights, google: true });
      }
    }
  } catch {
    /* ignore */
  }
}

function deriveName(pages: IRPage[], origin: string): string {
  const t = pages[0]?.meta.title;
  if (t) return t.split(/[–—|·]/)[0]!.trim() || hostName(origin);
  return hostName(origin);
}

function hostName(origin: string): string {
  try {
    return new URL(origin).hostname.replace(/^www\./, "");
  } catch {
    return "framer-site";
  }
}

export { toKebabCase };
