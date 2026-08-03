/**
 * Rendered-site adapter: browser output â†’ `IRSite`.
 *
 * Structurally the same job as the published-site adapter, with one difference that
 * removes a whole class of bug: the styles arrive already resolved. There is no cascade
 * to re-derive, no `--extracted-*` inheritance to get right, and no breakpoint to guess
 * at â€” each viewport is rendered and read back as the browser actually painted it.
 */
import { parse as parseHtml, type HTMLElement as ParsedHTMLElement } from "node-html-parser";
import type { IRSite, IRPage, IRNode, IRElement, IRImage, IRFavicon, IRFont, CssDecls } from "../../ir/types.js";
import {
  withBrowser,
  capturePage,
  discoverResponsiveBreakpoints,
  type RenderedNode,
  type CapturedPage,
} from "./browser.js";
import { mergeBreakpoint } from "../../ir/responsive.js";
import { extractHead } from "../published-site/meta.js";
import { discoverInternalLinks } from "../published-site/fetch.js";
import { NameRegistry, routeFromPathname } from "../../util/names.js";
import { log } from "../../util/log.js";

export interface RenderedSiteOptions {
  /** Viewport widths to render, widest first. Narrower ones become media queries. */
  widths?: number[];
  crawl?: boolean;
  maxPages?: number;
  onProgress?: (message: string) => void;
}

/** Framer's stock breakpoints. The widest is the base; the rest fold in as max-width rules. */
const DEFAULT_WIDTHS = [1200, 810, 390];

interface CaptureViewport {
  /** Representative width rendered inside this responsive interval. */
  width: number;
  /** Cascading upper bound for every interval below the widest base. */
  media?: string;
}

/** Prefer Framer's common design-canvas widths when they fall inside an interval. */
const PREFERRED_CAPTURE_WIDTHS = [1200, 810, 390, 1440, 1920, 1024, 768, 430, 375, 360, 320];

const HEADER_RE = /\b(header|navbar|topbar)\b/i;
const NAV_RE = /\bnav(igation)?\b/i;
const FOOTER_RE = /\bfooter\b/i;
const SECTION_RE = /\bsection\b/i;

/** Attributes worth keeping. Framer's own bookkeeping is noise, with one exception. */
const NATIVE_ATTRS = new Set([
  "alt", "title", "target", "rel", "type", "dir", "name", "value", "placeholder", "download",
  "poster", "preload", "autoplay", "loop", "muted", "playsinline", "controls", "media", "accept",
  "action", "method", "tabindex", "colspan", "rowspan", "datetime", "open", "required", "disabled",
  "checked", "selected", "multiple", "readonly",
  "allow", "sandbox", "referrerpolicy", "allowfullscreen", "frameborder", "crossorigin", "loading",
  "min", "max", "step", "minlength", "maxlength", "pattern", "inputmode", "autocomplete",
  "autofocus", "novalidate", "formnovalidate", "capture", "usemap", "ismap",
]);

function cleanAttrs(attrs: Record<string, string>, tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    const key = k.toLowerCase();
    if (key === "href") continue;
    if ((key === "src" || key === "srcset" || key === "sizes") && tag === "img") continue;
    // Framer's CSS selects on this to highlight the link for the current page.
    if (key === "data-framer-page-link-current") {
      out[key] = v;
      continue;
    }
    if (key === "id") {
      if (v && !/^__framer/i.test(v) && v !== "svg-templates") out.id = v;
      continue;
    }
    if (key.startsWith("data-framer") || key === "data-styles-preset") continue;
    if (key.startsWith("aria-") || key === "role" || key.startsWith("data-")) out[key] = v;
    if (NATIVE_ATTRS.has(key) || key === "src" || key === "srcset" || key === "sizes") out[key] = v;
  }
  return out;
}

/**
 * The route a link points at, or `undefined` when it leaves the site. Framer writes
 * internal links relatively (`./`), so a leading-slash test misses them and they end up
 * hard-coded back to the Framer domain.
 */
function internalRoute(href: string, pageUrl: string): string | undefined {
  const h = href.trim();
  if (!h || h.startsWith("#")) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return undefined;
  if (h.startsWith("//")) return undefined;
  try {
    const base = new URL(pageUrl);
    const url = new URL(h, base);
    if (url.origin !== base.origin) return undefined;
    return (url.pathname || "/") + url.search + url.hash;
  } catch {
    return undefined;
  }
}

/** Give the box a meaningful element, using the designer's layer name where there is one. */
function chooseTag(node: RenderedNode, depth: number): string {
  const tag = node.tag;
  if (tag === "a" || tag === "button" || tag === "ul" || tag === "ol" || tag === "li") return tag;
  if (tag === "p" || /^h[1-6]$/.test(tag)) return tag;
  const name = node.attrs["data-framer-name"] ?? "";
  if (HEADER_RE.test(name)) return "header";
  if (NAV_RE.test(name)) return "nav";
  if (FOOTER_RE.test(name)) return "footer";
  if (SECTION_RE.test(name) || depth === 1) return "section";
  return tag === "div" ? "div" : tag;
}

interface ConvertCtx {
  names: NameRegistry;
  pageUrl: string;
  assets: Set<string>;
}

/**
 * Properties that decide whether two text runs *look* the same.
 *
 * Geometry is deliberately excluded: every letter of a split heading has its own width,
 * so comparing the full style map would never find two letters alike. What must match is
 * the type â€” merging runs of different colour or size would change the design.
 */
const TEXT_IDENTITY = [
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-transform",
  "text-decoration-line",
  "-webkit-text-fill-color",
  "background-image",
  "background-color",
];

function sameTextStyle(a: RenderedNode, b: RenderedNode): boolean {
  return TEXT_IDENTITY.every((k) => (a.styles[k] ?? "") === (b.styles[k] ?? ""));
}

/** Per-glyph placement, meaningless once several glyphs share one node. */
const GEOMETRY_KEYS = [
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "width",
  "height",
  "transform",
  "transform-origin",
];

function isTextLeaf(n: RenderedNode): boolean {
  return n.text != null && !n.children.length && n.tag !== "#text" && !n.attrs["href"];
}

/**
 * Where a run sits vertically.
 *
 * Read from the measured box, not from a declaration: Framer's line breaks are the
 * result of how it placed each word, and nothing in the stylesheet says which line a
 * word belongs to.
 */
function lineTop(n: RenderedNode): number | null {
  return n.rect ? n.rect.top : null;
}

/**
 * Two runs the designer put on the same line.
 *
 * Unplaced runs (a plain whitespace node, or text in normal flow) join whatever they
 * sit next to; only two *placed* runs at different heights are kept apart.
 */
function onSameLine(a: RenderedNode, b: RenderedNode): boolean {
  const ta = lineTop(a);
  const tb = lineTop(b);
  if (ta === null || tb === null) return true;
  return Math.abs(ta - tb) < 4;
}

/**
 * Put a split heading back together.
 *
 * Framer animates headings by wrapping every single character in its own element, so a
 * six-word line arrives as ~40 nodes â€” each with its own class. The runtime that
 * animated them isn't shipped, so keeping the split costs a class per letter and, worse,
 * makes the whitespace between words structurally significant.
 *
 * Adjacent text leaves that share identical styling are merged back into one node.
 */
function collapseSplitText(nodes: RenderedNode[]): RenderedNode[] {
  const out: RenderedNode[] = [];
  const lineOf = new Map<RenderedNode, number>();

  for (const node of nodes) {
    const prev = out[out.length - 1];
    const mergeable =
      prev &&
      (isTextLeaf(prev) || prev.tag === "#text") &&
      (isTextLeaf(node) || node.tag === "#text") &&
      !prev.animations?.length &&
      !node.animations?.length &&
      // A bare whitespace run joins whichever side it sits between.
      (prev.tag === "#text" || node.tag === "#text" || sameTextStyle(prev, node)) &&
      // â€¦but only within one visual line. Framer's line breaks live in each word's
      // absolute `top`, and that placement is dropped on merge â€” so a run that spans two
      // lines silently reflows into one and the block loses a line's worth of height.
      onSameLine(prev, node);

    // Remember which line a run came from before its placement is thrown away.
    const top = lineTop(node);

    if (mergeable) {
      // Keep the styled node's identity; a whitespace run has none of its own.
      const keepPrev = prev!.tag !== "#text";
      const merged: RenderedNode = keepPrev ? prev! : node;
      const prevLine = lineOf.get(prev!);
      merged.text = (prev!.text ?? "") + (node.text ?? "");
      if (!keepPrev) {
        merged.tag = node.tag;
        merged.attrs = node.attrs;
        merged.styles = node.styles;
      }
      // Framer places each letter absolutely so it can animate them independently.
      // Those coordinates describe a single glyph, so carrying them onto the merged run
      // stacks every word at the same point. Dropping them lets the text flow instead.
      for (const key of GEOMETRY_KEYS) delete merged.styles[key];
      out[out.length - 1] = merged;
      const line = prevLine ?? top;
      if (line !== null && line !== undefined) lineOf.set(merged, line);
      continue;
    }

    out.push(node);
    if (top !== null) lineOf.set(node, top);
  }

  // Deliberately not forcing a break between lines here. Framer wraps each *word* of a
  // split heading in its own element, so marking every run as a block puts one word per
  // line â€” the heading grew from 198px to 990px. Runs from different lines are kept
  // separate (see `onSameLine`) and left to wrap naturally instead.
  void lineOf;

  return out;
}

function assignClass(
  ctx: ConvertCtx,
  styles: CssDecls,
  base: string,
  pseudo: Record<string, CssDecls> = {},
): string | undefined {
  // A node whose only styling is an ::after overlay still needs a class to hang it on.
  if (!Object.keys(styles).length && !Object.keys(pseudo).length) return undefined;
  return ctx.names.unique(base);
}

function convert(node: RenderedNode, ctx: ConvertCtx, depth = 0): IRNode | null {
  // A bare text run between inline elements. It carries no box of its own â€” it must
  // inherit from its parent, so it gets no class and no style.
  if (node.tag === "#text") {
    const text = node.text ?? "";
    if (!text) return null;
    return {
      kind: "text",
      id: nextId(),
      tag: "span",
      style: { base: {}, pseudo: {}, responsive: [] },
      attrs: {},
      text,
    };
  }

  const styles: CssDecls = { ...node.styles };
  const animations = node.animations?.length ? node.animations : undefined;
  const interaction = node.interaction;
  // Framer draws borders and overlays with ::after rather than on the box itself, so a
  // card loses its outline entirely if these are dropped.
  const pseudo: Record<string, CssDecls> = node.pseudo ? { ...node.pseudo } : {};
  const nameHint = node.attrs["data-framer-name"] || node.tag;

  if (node.tag === "svg" && node.svg) {
    return {
      kind: "svg",
      id: nextId(),
      tag: "svg",
      className: assignClass(ctx, styles, nameHint === "svg" ? "icon" : nameHint),
      style: { base: styles, pseudo, responsive: [] },
      attrs: {},
      animations,
      interaction,
      svg: node.svg,
    };
  }

  if (node.tag === "img") {
    const src = node.attrs["src"];
    if (!src) return null;
    ctx.assets.add(src);
    const img: IRImage = {
      kind: "image",
      id: nextId(),
      tag: "img",
      className: assignClass(ctx, styles, nameHint === "img" ? "image" : nameHint),
      style: { base: styles, pseudo, responsive: [] },
      attrs: cleanAttrs(node.attrs, node.tag),
      animations,
      interaction,
      src,
      alt: node.attrs["alt"] ?? "",
      altGenerated: false,
    };
    if (node.attrs["srcset"]) img.srcset = node.attrs["srcset"];
    if (node.attrs["sizes"]) img.sizes = node.attrs["sizes"];
    const w = parseInt(node.attrs["width"] ?? "", 10);
    const h = parseInt(node.attrs["height"] ?? "", 10);
    if (Number.isFinite(w)) img.width = w;
    if (Number.isFinite(h)) img.height = h;
    return img;
  }

  const href = node.attrs["href"];
  const route = href ? internalRoute(href, ctx.pageUrl) : undefined;

  // A leaf whose content is text becomes a text node, keeping its own typography.
  if (node.text != null && !node.children.length) {
    // Keep the tag the browser used. Forcing everything to <p> turns Framer's inline
    // per-letter spans into block boxes and destroys the line.
    const tag = node.tag === "a" ? "a" : node.tag;
    const textNode: IRNode = {
      kind: "text",
      id: nextId(),
      tag,
      className: assignClass(ctx, styles, nameHint, pseudo),
      style: { base: styles, pseudo, responsive: [] },
      attrs: cleanAttrs(node.attrs, node.tag),
      animations,
      interaction,
      text: node.text,
    };
    if (href) {
      textNode.href = route ?? href;
      textNode.internalLink = route != null;
      if (node.attrs["target"]) textNode.hrefTarget = node.attrs["target"];
    }
    return textNode;
  }

  const children: IRNode[] = [];
  for (const child of collapseSplitText(node.children)) {
    const c = convert(child, ctx, depth + 1);
    if (c) children.push(c);
  }

  // Nothing renderable and nothing to paint â€” drop it rather than emit an empty box.
  const preserveEmpty = /^(br|source|video|audio|iframe|input|textarea|select|option|canvas)$/.test(node.tag);
  if (!children.length && !Object.keys(styles).length && !node.text && !animations && !preserveEmpty) return null;

  const el: IRElement = {
    kind: "element",
    id: nextId(),
    tag: chooseTag(node, depth),
    className: assignClass(ctx, styles, nameHint, pseudo),
    style: { base: styles, pseudo, responsive: [] },
    attrs: cleanAttrs(node.attrs, node.tag),
    animations,
    interaction,
    children,
  };
  if (href) {
    el.tag = "a";
    el.href = route ?? href;
    el.internalLink = route != null;
    if (node.attrs["target"]) el.hrefTarget = node.attrs["target"];
  }
  return el;
}

let counter = 0;
const nextId = () => "r" + (counter++).toString(36);

/** Media query for breakpoint `i`, which applies below where the wider one stops. */
function mediaFor(widths: number[], i: number): string {
  return `(max-width: ${Math.max(1, widths[i - 1]! - 1)}px)`;
}

/** Preserve the existing explicit-width API exactly as supplied by callers. */
function fixedViewportPlan(input: number[]): CaptureViewport[] {
  const widths = [...new Set(input.map(Math.round))].filter((width) => width > 0).sort((a, b) => b - a);
  return widths.map((width, index) => ({
    width,
    ...(index > 0 ? { media: mediaFor(widths, index) } : {}),
  }));
}

/** Convert exact CSS boundaries into one representative capture per responsive interval. */
function detectedViewportPlan(input: number[]): CaptureViewport[] {
  const boundaries = [...new Set(input.map(Math.round))]
    .filter((width) => width >= 240 && width <= 3840)
    .sort((a, b) => a - b);
  if (!boundaries.length) return fixedViewportPlan(DEFAULT_WIDTHS);

  const highest = boundaries[boundaries.length - 1]!;
  const plan: CaptureViewport[] = [{ width: Math.max(1200, highest) }];

  for (let index = boundaries.length - 1; index >= 0; index--) {
    const upper = boundaries[index]!;
    const lower = index > 0 ? boundaries[index - 1]! : 1;
    const preferred = PREFERRED_CAPTURE_WIDTHS.find((width) => width >= lower && width < upper);
    const midpoint = Math.round((lower + upper - 1) / 2);
    const width = preferred ?? Math.max(1, Math.min(upper - 1, midpoint));
    plan.push({ width, media: `(max-width: ${Math.max(1, upper - 1)}px)` });
  }

  return plan;
}

export async function ingestRenderedSite(
  entryUrl: string,
  options: RenderedSiteOptions = {},
): Promise<IRSite> {
  const fixedPlan = options.widths?.length ? fixedViewportPlan(options.widths) : undefined;
  counter = 0;

  const { captureGroups, viewportPlan } = await withBrowser(async (browser) => {
    options.onProgress?.("Discovering responsive breakpoints");
    const plan = fixedPlan ?? detectedViewportPlan(await discoverResponsiveBreakpoints(browser, entryUrl));
    log.step(`Rendering ${entryUrl} at ${plan.map(({ width }) => width).join("px, ")}px`);
    const groups: CapturedPage[][] = [];
    const queue = [entryUrl];
    const seen = new Set<string>();
    const maxPages = Math.max(1, options.maxPages ?? 25);

    while (queue.length && groups.length < maxPages) {
      const requested = queue.shift()!;
      const key = normalizeUrl(requested);
      if (seen.has(key)) continue;
      seen.add(key);

      try {
        const captures: CapturedPage[] = [];
        let pagePath = requested;
        try {
          pagePath = new URL(requested).pathname || "/";
        } catch {
          // Keep the requested value when it is not a valid absolute URL.
        }
        for (let viewportIndex = 0; viewportIndex < plan.length; viewportIndex++) {
          const { width } = plan[viewportIndex]!;
          captures.push(
            await capturePage(browser, requested, {
              width,
              // Hover state is component behavior, not a responsive layout value. Capture
              // it once on the widest representation instead of repeating it per viewport.
              captureInteractions: viewportIndex === 0,
              onProgress: (stage) =>
                options.onProgress?.(
                  `Page ${groups.length + 1} @ ${width}px - ${stage} (${pagePath})`,
                ),
            }),
          );
        }
        groups.push(captures);

        if (options.crawl) {
          const canonical = captures[0]!.url;
          for (const link of discoverInternalLinks(captures[0]!.html, canonical)) {
            const linkKey = normalizeUrl(link);
            if (!seen.has(linkKey) && !queue.some((queued) => normalizeUrl(queued) === linkKey)) queue.push(link);
          }
        }
      } catch (err) {
        if (isBrowserUnavailable(err)) {
          throw new Error(
            `Browser renderer stopped while capturing ${requested}: ${(err as Error).message}`,
          );
        }
        if (groups.length === 0) throw err;
        log.warn(`skipped ${requested}: ${(err as Error).message}`);
      }
    }

    return { captureGroups: groups, viewportPlan: plan };
  });

  const first = captureGroups[0]?.[0];
  if (!first) throw new Error(`No renderable pages found at ${entryUrl}.`);

  const assets = new Set<string>();
  const pages: IRPage[] = [];
  const favicons = new Map<string, IRFavicon>();
  const fonts = new Map<string, IRFont>();
  const usedPaths = new Set<string>();
  const usedNames = new Set<string>();
  let totalNodes = 0;
  let mismatches = 0;

  for (const captures of captureGroups) {
    const base = captures[0]!;
    totalNodes += base.nodeCount;
    const ctx: ConvertCtx = { names: new NameRegistry(), pageUrl: base.url, assets };
    const root = convert(base.root, ctx) ?? emptyRoot();

    // Narrower viewports fold into the base as media-query deltas. Each variant gets
    // its own registry so its class names cannot consume the base namespace.
    for (let i = 1; i < captures.length; i++) {
      const variantCtx: ConvertCtx = { names: new NameRegistry(), pageUrl: captures[i]!.url, assets };
      const variant = convert(captures[i]!.root, variantCtx);
      if (!variant) continue;
      mismatches += mergeBreakpoint(root, variant, viewportPlan[i]!.media!).structureMismatches;
    }

    const head = extractHead(parseHtml(base.html), base.url);
    for (const favicon of head.favicons) {
      favicons.set(`${favicon.rel}|${favicon.media ?? ""}|${favicon.href}`, favicon);
    }
    for (const font of capturedFonts(base)) if (!fonts.has(font.family)) fonts.set(font.family, font);

    const route = uniqueRenderedRoute(base.url, usedPaths, usedNames);
    pages.push({ path: route.path, name: route.name, meta: head.meta, root });
  }

  if (!pages.some((page) => page.path === "/") && pages[0]) pages[0].path = "/";
  log.success(`Rendered ${pages.length} page(s) at ${viewportPlan.length} viewport(s) - ${totalNodes} base node(s)`);
  if (mismatches) log.debug(`${mismatches} subtree(s) differed in structure between viewports`);

  const firstHead = extractHead(parseHtml(first.html), first.url);
  return {
    name: firstHead.siteName ?? hostName(first.url),
    source: { type: "published-site", origin: entryUrl },
    baseUrl: new URL(first.url).origin,
    pages,
    favicons: [...favicons.values()],
    colorStyles: [],
    fonts: [...fonts.values()],
    globalCss: mergedGlobalCss(first, captureGroups),
    svgSprite: mergedSvgSprite(captureGroups),
    assets: [...assets].map((url) => ({ url })),
    lang: firstHead.lang || "en",
  };
}

function isBrowserUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /target page, context or browser has been closed|browser has been closed|browser disconnected|target closed/i.test(
    message,
  );
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return (parsed.origin + parsed.pathname).replace(/\/+$/, "") || parsed.origin;
  } catch {
    return url;
  }
}

function uniqueRenderedRoute(
  url: string,
  usedPaths: Set<string>,
  usedNames: Set<string>,
): { path: string; name: string } {
  const route = routeFromPathname(new URL(url).pathname);
  const basePath = route.path || "/";
  const baseName = route.name || "Home";
  let path = basePath;
  let name = baseName;
  let index = 2;
  while (usedPaths.has(path)) path = `${basePath === "/" ? "/page" : basePath}-${index++}`;
  index = 2;
  while (usedNames.has(name)) name = `${baseName}${index++}`;
  usedPaths.add(path);
  usedNames.add(name);
  return { path, name };
}
function capturedFonts(page: CapturedPage): IRFont[] {
  const names: string[] = [];
  const add = (raw: string | undefined) => {
    const name = raw?.split(",")[0]?.trim().replace(/^['"]|['"]$/g, "");
    if (name && !/^(serif|sans-serif|system-ui|monospace)$/i.test(name) && !names.includes(name)) names.push(name);
  };
  add(page.bodyStyles["font-family"]);
  for (const match of page.globalCss.matchAll(/font-family:\s*([^;}]+)/gi)) add(match[1]);
  return names.map((family) => ({ family, weights: [] }));
}

function capturedGlobalCss(page: CapturedPage): string {
  const body = page.bodyStyles;
  const props = ["background-color", "color", "font-family", "font-size", "font-weight", "line-height"];
  const declarations = props
    .filter((prop) => body[prop] && body[prop] !== "rgba(0, 0, 0, 0)")
    .map((prop) => `  ${prop}: ${body[prop]};`);
  const bodyRule = declarations.length ? `body {\n${declarations.join("\n")}\n}` : "";
  const smoothScroll = /<html[^>]*class=["'][^"']*\blenis\b/i.test(page.html)
    ? "html { scroll-behavior: smooth; }"
    : "";
  return [page.globalCss, bodyRule, smoothScroll].filter(Boolean).join("\n\n");
}

function mergedGlobalCss(first: CapturedPage, groups: CapturedPage[][]): string {
  const blocks = [capturedGlobalCss(first)];
  const seen = new Set<string>([first.globalCss.trim()]);
  for (const captures of groups) {
    for (const capture of captures) {
      const css = capture.globalCss.trim();
      if (!css || seen.has(css)) continue;
      seen.add(css);
      blocks.push(css);
    }
  }
  return blocks.filter(Boolean).join("\n\n");
}

function mergedSvgSprite(groups: CapturedPage[][]): string | undefined {
  const blocks: string[] = [];
  const seenIds = new Set<string>();
  for (const captures of groups) {
    for (const capture of captures) {
      const sprite = capture.svgSprite?.trim() ?? "";
      if (!sprite) continue;

      // Parse Framer's template-container content as a Node-side HTML fragment, then
      // keep one complete SVG definition per id across routes and breakpoints.
      const fragment = parseHtml(`<div data-framecoded-sprite-root>${sprite}</div>`);
      const root = fragment.querySelector("[data-framecoded-sprite-root]");
      if (!root) continue;
      for (const child of root.childNodes) {
        const element = child as Partial<ParsedHTMLElement>;
        if (typeof element.tagName !== "string" || element.tagName.toLowerCase() !== "svg") continue;
        if (typeof element.getAttribute !== "function") continue;
        const id = element.getAttribute("id")?.trim();
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        blocks.push((element as ParsedHTMLElement).outerHTML);
      }
    }
  }
  return blocks.length ? blocks.join("\n") : undefined;
}

function emptyRoot(): IRElement {
  return {
    kind: "element",
    id: "page-root",
    tag: "main",
    style: { base: {}, pseudo: {}, responsive: [] },
    attrs: {},
    children: [],
  };
}

function hostName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "framer-site";
  }
}
