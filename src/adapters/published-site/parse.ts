import { parse as parseHtml, HTMLElement, type Node, NodeType } from "node-html-parser";
import type { IRNode, IRElement, IRText, IRImage, IRSvg, IRStyle } from "../../ir/types.js";
import { NameRegistry } from "../../util/names.js";
import { computeCascade, withInline, type Cascade, type ResolvedStyle } from "./styles.js";
import { decode } from "./meta.js";
import { resolveUrl } from "./fetch.js";

const INLINE_TAGS = new Set([
  "a", "span", "strong", "b", "em", "i", "u", "s", "mark", "small", "sub", "sup", "code", "br", "wbr",
]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const TEXT_TAGS = new Set([...HEADING_TAGS, "p", "li", "blockquote", "figcaption", "label"]);
const SEMANTIC_PRESERVE = new Set([
  "header", "nav", "footer", "main", "article", "aside", "section", "figure", "figcaption",
  "ul", "ol", "li", "button", "form", "label", "blockquote", "table", "thead", "tbody", "tr", "td", "th",
  ...HEADING_TAGS, "p",
]);
const SKIP_TAGS = new Set(["script", "style", "link", "noscript", "meta", "template", "head", "title"]);

export interface ParseContext {
  cascade: Cascade;
  names: NameRegistry;
  pageUrl: string;
  /** Image/background-image URLs encountered (for optional local download). */
  assets: Set<string>;
  /** #fragment ids referenced by in-page links — these ids are preserved. */
  keepIds: Set<string>;
  /** Viewport width used to pick the canonical responsive breakpoint variant. */
  targetWidth: number;
  warnings: { variantsCollapsed: number; nodes: number };
}

export interface ParsedPage {
  root: IRNode;
  /** Markup of Framer's shared `#svg-templates` block, if the page has one. */
  svgSprite?: string;
  rootCss: string;
  assets: string[];
  tokenColors: Map<string, string>;
  /** Framer link colours captured for re-declaration at :root. */
  linkVars: Map<string, string>;
  variantsCollapsed: number;
  nodeCount: number;
}

export interface ParseOptions {
  /** Viewport width used to choose the canonical responsive variant (default 1200 = desktop). */
  targetWidth?: number;
}

export function parseDocument(html: string, pageUrl: string, options: ParseOptions = {}): ParsedPage {
  const doc = parseHtml(html, {
    comment: false,
    blockTextElements: { script: false, noscript: false, style: true, pre: true },
  });

  const cssBlocks: string[] = [];
  for (const styleEl of doc.querySelectorAll("style")) cssBlocks.push(styleEl.text);
  const cascade = computeCascade(doc, cssBlocks);

  const keepIds = new Set<string>();
  for (const a of doc.querySelectorAll('a[href^="#"]')) {
    const href = a.getAttribute("href")!;
    if (href.length > 1) keepIds.add(href.slice(1));
  }

  const ctx: ParseContext = {
    cascade,
    names: new NameRegistry(),
    pageUrl,
    assets: new Set(),
    keepIds,
    targetWidth: options.targetWidth ?? 1200,
    warnings: { variantsCollapsed: 0, nodes: 0 },
  };

  const body = doc.querySelector("body") ?? doc;
  const contentChildren = collectContentRoots(body, ctx);

  let root: IRNode;
  if (contentChildren.length === 1) {
    root = contentChildren[0]!;
  } else {
    // Synthetic wrapper: no className (it has no style), so the className⟺style
    // invariant holds and no dangling `styles.*` reference is emitted.
    root = {
      kind: "element",
      id: "page-root",
      tag: "div",
      style: emptyStyle(),
      attrs: {},
      children: contentChildren,
    };
  }
  root = pruneEmpty(root) ?? root;

  // Framer stores each icon's geometry once and points at it from every place the icon
  // appears. The block is hidden, so it reads as page chrome — but dropping it leaves
  // every reference resolving to nothing and the icons render as blank boxes.
  const sprite = doc.querySelector("#svg-templates");

  return {
    root,
    svgSprite: sprite ? sprite.innerHTML.trim() || undefined : undefined,
    rootCss: cascade.rootCss,
    assets: [...ctx.assets],
    tokenColors: cascade.tokenColors,
    linkVars: cascade.linkVars,
    variantsCollapsed: ctx.warnings.variantsCollapsed,
    nodeCount: ctx.warnings.nodes,
  };
}

/** Collect the meaningful top-level content nodes from <body>, skipping Framer chrome. */
function collectContentRoots(body: HTMLElement, ctx: ParseContext): IRNode[] {
  const out: IRNode[] = [];
  // Framer usually nests everything under one wrapper div; unwrap pure wrappers
  // until we reach real content, to avoid an empty <div> at the top.
  let containers: HTMLElement[] = elementChildren(body).filter((el) => !isChrome(el));
  // Unwrap a single styleless wrapper repeatedly.
  for (let i = 0; i < 4; i++) {
    if (containers.length === 1) {
      const only = containers[0]!;
      const kids = elementChildren(only).filter((el) => !isChrome(el));
      const resolved = withInline(ctx.cascade.styleOf(only), only.getAttribute("style"));
      const styleless = Object.keys(resolved.base).length <= 1; // e.g. just display:contents
      if (kids.length > 1 && styleless) {
        containers = kids;
        continue;
      }
    }
    break;
  }
  const rescue = rescueVariant(containers, ctx);
  for (const el of containers) {
    pushParsed(out, el, ctx, true, el === rescue);
  }
  return out;
}

/**
 * Parse one element into the output list, transparently handling Framer's
 * `ssr-variant` responsive wrappers: the active breakpoint (at ctx.targetWidth)
 * is unwrapped (its children inlined, since `.ssr-variant{display:contents}`),
 * and inactive breakpoint variants are dropped entirely. This collapses Framer's
 * 2–3× duplicated SSR DOM down to a single clean tree.
 */
function pushParsed(
  out: IRNode[],
  el: HTMLElement,
  ctx: ParseContext,
  topLevel: boolean,
  /** Keep this element even if it evaluates as hidden — see `rescueVariant`. */
  force = false,
): void {
  if (isChrome(el)) return;
  const classNames = classList(el);
  // Only an `ssr-variant` wrapper is a genuine duplicate of a sibling, and only those
  // may be dropped. A bare `hidden-XXXX` class marks content that is hidden *at one
  // breakpoint* — it is not a duplicate, and its own media query already says so.
  // Dropping those on a mis-resolved cascade deletes real sections outright.
  if (classNames.includes("ssr-variant")) {
    const display = ctx.cascade.displayAtWidth(el, ctx.targetWidth);
    if (display === "none" && !force) {
      ctx.warnings.variantsCollapsed++;
      return; // inactive breakpoint variant
    }
    if (classNames.includes("ssr-variant")) {
      // transparent wrapper — inline its children
      for (const child of elementChildren(el)) pushParsed(out, child, ctx, topLevel);
      return;
    }
  }
  const node = parseNode(el, ctx, topLevel);
  if (!node) return;

  // A `hidden-XXXX` layer is not a duplicate of a sibling, so it must not be dropped —
  // but it *is* hidden at some widths, and keeping it without that rule renders another
  // breakpoint's content on top of this one (a phone variant's 12px text winning over
  // the desktop copy). Hide it here and let its own media queries reveal it.
  if (classNames.some((c) => c.startsWith("hidden-"))) {
    if (ctx.cascade.displayAtWidth(el, ctx.targetWidth) === "none") {
      node.style.base["display"] = "none";
      ctx.warnings.variantsCollapsed++;
    }
  }
  out.push(node);
}

function isBreakpointVariant(classNames: string[]): boolean {
  return classNames.includes("ssr-variant");
}

/**
 * Guard against a breakpoint-variant group disappearing wholesale.
 *
 * Framer emits the same content two or three times, one copy per breakpoint, and marks
 * the inactive copies hidden through a media query. Dropping those is the whole point of
 * the collapse — but it relies on resolving the cascade at a chosen width, and when that
 * resolution misses (an unmatched selector, an unusual query), *every* copy reads as
 * hidden and the entire branch vanishes silently. That failure took a 1974-element page
 * down to 208.
 *
 * So: if a sibling group contains variants and none of them survives, keep the first.
 * A duplicated section is a visible, fixable problem; a missing one looks like the
 * exporter simply lost the page.
 */
function rescueVariant(els: HTMLElement[], ctx: ParseContext): HTMLElement | undefined {
  const variants = els.filter((el) => !isChrome(el) && isBreakpointVariant(classList(el)));
  if (!variants.length) return undefined;
  const anyVisible = variants.some((el) => ctx.cascade.displayAtWidth(el, ctx.targetWidth) !== "none");
  return anyVisible ? undefined : variants[0];
}

const KEEP_EMPTY_TAGS = new Set(["img", "svg", "br", "hr", "input", "iframe", "video", "source"]);

/** Remove truly-empty wrapper elements (no style, no children, no meaningful attrs). */
function pruneEmpty(node: IRNode): IRNode | null {
  if (node.kind !== "element") return node;
  const children: IRNode[] = [];
  for (const c of node.children) {
    const pruned = pruneEmpty(c);
    if (pruned) children.push(pruned);
  }
  node.children = children;

  if (KEEP_EMPTY_TAGS.has(node.tag)) return node;
  if (node.href) return node; // links matter even if empty
  const hasStyle = !!node.className;
  const meaningfulAttrs = Object.keys(node.attrs).some((k) => k === "role" || k.startsWith("aria-") || k === "id");
  if (children.length === 0 && !hasStyle && !meaningfulAttrs) return null;
  return node;
}

function parseChildren(el: HTMLElement, ctx: ParseContext, topLevel: boolean): IRNode[] {
  const out: IRNode[] = [];
  const rescue = rescueVariant(elementChildren(el), ctx);
  for (const child of el.childNodes) {
    if (child.nodeType === NodeType.TEXT_NODE) {
      const t = decode((child as any).rawText ?? "").replace(/\s+/g, " ");
      if (t.trim()) out.push(textLeaf(t.trim(), ctx));
    } else if (child.nodeType === NodeType.ELEMENT_NODE) {
      pushParsed(out, child as HTMLElement, ctx, topLevel, child === rescue);
    }
  }
  return out;
}

function parseNode(el: HTMLElement, ctx: ParseContext, topLevel = false): IRNode | null {
  const tag = el.rawTagName?.toLowerCase();
  if (!tag || SKIP_TAGS.has(tag)) return null;
  if (isChrome(el)) return null;

  const classNames = classList(el);
  const inline = el.getAttribute("style");
  const resolved = withInline(ctx.cascade.styleOf(el), inline);

  // Neutralize Framer entrance-animation initial states. Framer sets the *start*
  // of scroll/appear animations inline (opacity ~0, a transform offset, will-change)
  // and animates to the settled state via JS. We strip the runtime, so we must
  // render the settled (visible) state or the content would be invisible.
  neutralizeAppearState(el, resolved.base);
  for (const m of resolved.media) neutralizeAppearState(el, m.decls);

  // SVG → keep raw vector markup.
  if (tag === "svg") {
    return makeSvg(el, ctx, resolved);
  }

  // <img> → image node.
  if (tag === "img") {
    return makeImage(el, ctx, resolved);
  }

  const componentType = el.getAttribute("data-framer-component-type");
  const isTextContainer = componentType === "RichTextContainer" || componentType === "Text";

  // Text node: a text-bearing tag (or Framer text container) whose children are inline-only.
  if ((TEXT_TAGS.has(tag) || isTextContainer || onlyInlineChildren(el)) && hasText(el)) {
    if (onlyInlineChildren(el)) {
      return makeText(el, ctx, resolved, topLevel);
    }
  }

  // Generic container / link / list → element with children.
  return makeElement(el, ctx, resolved, classNames, topLevel);
}

function makeElement(
  el: HTMLElement,
  ctx: ParseContext,
  resolved: ResolvedStyle,
  classNames: string[],
  topLevel: boolean,
): IRElement {
  ctx.warnings.nodes++;
  const rawTag = el.rawTagName!.toLowerCase();
  const framerName = el.getAttribute("data-framer-name") ?? "";

  // Recurse into children (ssr-variant wrappers are unwrapped/collapsed here).
  const children = parseChildren(el, ctx, false);

  const tag = chooseTag(rawTag, framerName, topLevel, children, resolved);
  const href = el.getAttribute("href");
  const route = href ? internalRoute(href, ctx.pageUrl) : undefined;
  const internal = route != null;

  const node: IRElement = {
    kind: "element",
    id: el.getAttribute("id") && ctx.keepIds.has(el.getAttribute("id")!) ? el.getAttribute("id")! : shortId(),
    tag,
    className: assignClass(ctx, resolved, framerName || tag),
    style: toIRStyle(resolved),
    attrs: cleanAttrs(el, ctx),
    children,
  };
  if (href && tag === "a") {
    node.href = route ?? resolveUrl(href, ctx.pageUrl) ?? href;
    node.hrefTarget = el.getAttribute("target") ?? undefined;
    node.internalLink = internal;
  }
  return node;
}

function makeText(
  el: HTMLElement,
  ctx: ParseContext,
  resolved: ResolvedStyle,
  topLevel: boolean,
): IRText {
  ctx.warnings.nodes++;
  const rawTag = el.rawTagName!.toLowerCase();
  const framerName = el.getAttribute("data-framer-name") ?? "";
  const tag = HEADING_TAGS.has(rawTag) || TEXT_TAGS.has(rawTag) ? rawTag : chooseTextTag(el);
  const { text, html, hasInlineMarkup } = serializeInline(el, ctx);

  const href = el.tagName?.toLowerCase() === "a" ? el.getAttribute("href") : undefined;
  const route = href ? internalRoute(href, ctx.pageUrl) : undefined;
  const internal = route != null;

  const node: IRText = {
    kind: "text",
    id: shortId(),
    tag: href ? "a" : tag,
    className: assignClass(ctx, resolved, framerName || tag),
    style: toIRStyle(resolved),
    attrs: cleanAttrs(el, ctx),
    text,
  };
  if (hasInlineMarkup) node.html = html;
  if (href) {
    node.href = route ?? resolveUrl(href, ctx.pageUrl) ?? href;
    node.hrefTarget = el.getAttribute("target") ?? undefined;
    node.internalLink = internal;
  }
  return node;
}

function makeImage(el: HTMLElement, ctx: ParseContext, resolved: ResolvedStyle): IRImage {
  ctx.warnings.nodes++;
  const srcRaw = el.getAttribute("src") ?? "";
  const src = resolveUrl(srcRaw, ctx.pageUrl) ?? srcRaw;
  if (src) ctx.assets.add(src);
  const w = numAttr(el, "width");
  const h = numAttr(el, "height");
  const framerName = el.getAttribute("data-framer-name") ?? "";
  const alt = el.getAttribute("alt");

  const node: IRImage = {
    kind: "image",
    id: shortId(),
    tag: "img",
    className: assignClass(ctx, resolved, framerName || "image"),
    style: toIRStyle(resolved),
    attrs: {},
    src,
    alt: alt ?? "",
    altGenerated: false,
    width: w,
    height: h,
    srcset: el.getAttribute("srcset") ?? undefined,
    sizes: el.getAttribute("sizes") ?? undefined,
  };
  return node;
}

function makeSvg(el: HTMLElement, ctx: ParseContext, resolved: ResolvedStyle): IRSvg {
  ctx.warnings.nodes++;
  const framerName = el.getAttribute("data-framer-name") ?? "";
  return {
    kind: "svg",
    id: shortId(),
    tag: "svg",
    className: assignClass(ctx, resolved, framerName || "icon"),
    style: toIRStyle(resolved),
    attrs: {},
    svg: stripFramerAttrs(el.outerHTML),
  };
}

// ---------- helpers ----------

function textLeaf(text: string, ctx: ParseContext): IRText {
  return {
    kind: "text",
    id: shortId(),
    tag: "span",
    style: emptyStyle(),
    attrs: {},
    text,
  };
}

function chooseTag(
  rawTag: string,
  framerName: string,
  topLevel: boolean,
  children: IRNode[],
  resolved: ResolvedStyle,
): string {
  if (SEMANTIC_PRESERVE.has(rawTag)) return rawTag;
  if (rawTag === "a") return "a";
  if (rawTag !== "div" && rawTag !== "span") return rawTag;

  const name = framerName.toLowerCase();
  // Light semantic promotion based on the layer name Framer gives us.
  if (/(^|\b)(header|navbar|nav bar)\b/.test(name)) return "header";
  if (/\bnav(igation)?\b/.test(name)) return "nav";
  if (/\bfooter\b/.test(name)) return "footer";
  if (topLevel && (name || children.length > 1)) return "section";
  if (rawTag === "span") return "span";
  return "div";
}

function chooseTextTag(el: HTMLElement): string {
  const inner = el.querySelector("h1,h2,h3,h4,h5,h6,p");
  if (inner) return inner.rawTagName!.toLowerCase();
  return "p";
}

function onlyInlineChildren(el: HTMLElement): boolean {
  // True if every element child is an inline tag (text container).
  let sawText = false;
  let blockChildren = 0;
  let styledBlockChild = false;

  for (const child of el.childNodes) {
    if (child.nodeType === NodeType.TEXT_NODE) {
      if (((child as any).rawText ?? "").trim()) sawText = true;
    } else if (child.nodeType === NodeType.ELEMENT_NODE) {
      const e = child as HTMLElement;
      const t = e.rawTagName?.toLowerCase();
      // An inline tag that wraps real structure isn't inline content. Framer builds a
      // button as `<a><div><div><svg/></div></div>text</a>`; flattening it to markup
      // keeps the label and throws the icon and the layout away.
      if (t && INLINE_TAGS.has(t) && e.querySelector("svg,img,picture,video,div") != null) {
        return false;
      }
      if (!t || !INLINE_TAGS.has(t)) {
        // A nested heading/paragraph can still be flattened into a single text leaf —
        // but only when it carries no styling of its own.
        if (t && (HEADING_TAGS.has(t) || t === "p")) {
          blockChildren++;
          // Framer puts each paragraph's typography inline on the <p> itself
          // (`--framer-font-size`, `--framer-text-color`, …). Flattening the container
          // serializes those children to plain markup and discards it, which is how a
          // 64px heading ends up rendering at the browser's default 16px.
          if (/--framer-/.test(e.getAttribute("style") ?? "")) styledBlockChild = true;
          continue;
        }
        return false;
      }
    }
  }

  // A paragraph or heading child must stay its own node. Folding it into the container
  // makes the *container's* box the text leaf, so the text inherits `display:flex` and
  // the container's type instead of its own — the paragraph's colour, size and weight
  // are silently replaced by whatever the wrapper happened to have.
  if (styledBlockChild || blockChildren > 0) return false;

  return sawText || el.querySelector("h1,h2,h3,h4,h5,h6,p,span,a") != null;
}

function hasText(el: HTMLElement): boolean {
  return el.text.trim().length > 0;
}

/** Reset an element's style to the settled (visible) state of a Framer appear animation. */
/**
 * The route this link points at, or `undefined` when it leaves the site.
 *
 * A published Framer page writes its own links *relatively* — the home link is `./`,
 * not `/`. Testing for a leading slash misses those, so they get resolved against the
 * page URL and hard-coded back to the Framer domain: clicking "Home" in the export
 * navigates away from the export. Anything on the same origin is a route.
 */
function internalRoute(href: string, pageUrl: string): string | undefined {
  const h = href.trim();
  if (!h || h.startsWith("#")) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return undefined; // mailto:, tel:, https:, data:
  if (h.startsWith("//")) return undefined; // protocol-relative → external
  try {
    const base = new URL(pageUrl);
    const url = new URL(h, base);
    if (url.origin !== base.origin) return undefined;
    return (url.pathname || "/") + url.search + url.hash;
  } catch {
    return undefined;
  }
}

function neutralizeAppearState(el: HTMLElement, decls: Record<string, string>): void {
  const opacity = parseFloat((decls["opacity"] ?? "1").replace(/!important/i, "").trim());
  if (!Number.isFinite(opacity) || opacity >= 0.05) {
    // Not transparent — nothing to settle, but a stray offset still has to go.
    if (el.getAttribute("data-framer-appear-id") == null) return;
  }

  const hasAppearId = el.getAttribute("data-framer-appear-id") != null;
  // `will-change` is stripped from `decls` by DROP_PROPS before this runs, so the raw
  // attribute is the only place left to see it.
  const rawStyle = el.getAttribute("style") ?? "";
  const willChangeTransform =
    (decls["will-change"] ?? "").includes("transform") || /will-change\s*:[^;]*transform/i.test(rawStyle);

  // A fully transparent element that still carries real content is an entrance
  // animation waiting for Framer's runtime — which this export doesn't ship. Left
  // alone it stays invisible forever, which is how whole sections vanish while the
  // page height stays correct.
  const hasContent = (el.textContent ?? "").trim().length > 0 || el.querySelector("img,svg,video") != null;
  const looksLikeAppear = hasAppearId || willChangeTransform || hasContent;
  if (!looksLikeAppear) return;
  if (Number.isFinite(opacity) && opacity < 0.05) decls["opacity"] = "1";
  // Remove the entrance transform offset (translate/scale) — settled state is no transform.
  if (decls["transform"] && /translate|scale|rotate|perspective|matrix/.test(decls["transform"])) {
    delete decls["transform"];
  }
  delete decls["will-change"];
}

/**
 * Serialize an element's inline content: returns plain text + a cleaned inline-HTML
 * string (only safe inline tags, framer attrs stripped). `hasInlineMarkup` is true
 * when the cleaned HTML contains tags beyond plain text/<br>.
 */
function serializeInline(
  el: HTMLElement,
  ctx: ParseContext,
): { text: string; html: string; hasInlineMarkup: boolean } {
  let html = "";
  let markup = false;

  const walk = (node: Node) => {
    if (node.nodeType === NodeType.TEXT_NODE) {
      html += escapeText(decode((node as any).rawText ?? ""));
      return;
    }
    if (node.nodeType !== NodeType.ELEMENT_NODE) return;
    const e = node as HTMLElement;
    const t = e.rawTagName?.toLowerCase();
    if (!t) return;
    if (t === "br") {
      html += "<br />";
      markup = true;
      return;
    }
    if (t === "a") {
      const href = e.getAttribute("href") ?? "";
      const abs = internalRoute(href, ctx.pageUrl) ?? resolveUrl(href, ctx.pageUrl) ?? href;
      const target = e.getAttribute("target");
      // Framer's CSS selects on this to highlight the link for the current page.
      const current = e.getAttribute("data-framer-page-link-current");
      markup = true;
      html += `<a href="${escapeAttr(abs)}"${target ? ` target="${escapeAttr(target)}" rel="noopener"` : ""}${
        current != null ? ` data-framer-page-link-current="${escapeAttr(current)}"` : ""
      }>`;
      for (const c of e.childNodes) walk(c);
      html += "</a>";
      return;
    }
    if (INLINE_TAGS.has(t) && t !== "span") {
      markup = true;
      html += `<${t}>`;
      for (const c of e.childNodes) walk(c);
      html += `</${t}>`;
      return;
    }
    // Framer paints gradient text with a span that carries the gradient as a
    // background and clips it to the glyphs. Unwrapping the span keeps the words but
    // drops the fill, so the text falls back to whatever colour it inherits.
    const fillStyle = e.getAttribute("style") ?? "";
    if (t === "span" && (e.getAttribute("data-text-fill") != null || /background-image/i.test(fillStyle))) {
      markup = true;
      const clip = "-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent";
      html += `<span style="${escapeAttr(`${fillStyle};${clip}`)}">`;
      for (const c of e.childNodes) walk(c);
      html += `</span>`;
      return;
    }

    // span / heading / p inside: unwrap, keep text
    for (const c of e.childNodes) walk(c);
  };

  for (const c of el.childNodes) walk(c);
  html = html.replace(/\s+/g, " ").trim();
  const text = decode(el.text).replace(/\s+/g, " ").trim();
  return { text, html, hasInlineMarkup: markup };
}

function assignClass(
  ctx: ParseContext,
  resolved: ResolvedStyle,
  base: string,
): string | undefined {
  const hasStyle =
    Object.keys(resolved.base).length > 0 ||
    resolved.pseudo.size > 0 ||
    resolved.media.some((m) => Object.keys(m.decls).length > 0 || m.pseudo.size > 0);
  if (!hasStyle) return undefined;
  return ctx.names.unique(base);
}

function toIRStyle(resolved: ResolvedStyle): IRStyle {
  return {
    base: resolved.base,
    pseudo: Object.fromEntries(resolved.pseudo),
    responsive: resolved.media.map((m) => ({
      media: m.query,
      style: m.decls,
      pseudo: m.pseudo.size ? Object.fromEntries(m.pseudo) : undefined,
    })),
  };
}

function emptyStyle(): IRStyle {
  return { base: {}, pseudo: {}, responsive: [] };
}

function cleanAttrs(el: HTMLElement, ctx: ParseContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(el.attributes)) {
    const key = k.toLowerCase();
    if (key === "class" || key === "style" || key === "href" || key === "src" || key === "srcset" || key === "sizes")
      continue;
    // Most `data-framer-*` attributes are runtime bookkeeping and only add noise — but a
    // few are what Framer's own CSS selects on. Dropping this one loses the highlight on
    // the link for the page you are actually on.
    if (key === "data-framer-page-link-current") {
      out[key] = v;
      continue;
    }
    if (key.startsWith("data-framer") || key === "data-styles-preset") continue;
    if (key === "id") {
      if (ctx.keepIds.has(v)) out.id = v;
      continue;
    }
    if (key.startsWith("aria-") || key === "role" || key.startsWith("data-")) out[key] = v;
    if (key === "target" || key === "rel" || key === "type" || key === "dir") out[key] = v;
  }
  return out;
}

function classList(el: HTMLElement): string[] {
  const cls = el.getAttribute("class");
  return cls ? cls.split(/\s+/).filter(Boolean) : [];
}

function elementChildren(el: HTMLElement): HTMLElement[] {
  return el.childNodes.filter((n) => n.nodeType === NodeType.ELEMENT_NODE) as HTMLElement[];
}

function isChrome(el: HTMLElement): boolean {
  const tag = el.rawTagName?.toLowerCase();
  if (tag && SKIP_TAGS.has(tag)) return true;
  const id = el.getAttribute("id") ?? "";
  const cls = el.getAttribute("class") ?? "";
  if (/__framer-badge|framer-badge/.test(cls) || id === "__framer-badge-container") return true;
  if (id.startsWith("__framer-editorbar") || el.querySelector("#__framer-editorbar-button")) return true;
  if (id === "svg-templates" || /framer-cursor/.test(cls)) return true;
  return false;
}

function numAttr(el: HTMLElement, name: string): number | undefined {
  const v = el.getAttribute(name);
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function stripFramerAttrs(svg: string): string {
  return svg
    .replace(/\sdata-framer[a-z-]*="[^"]*"/gi, "")
    .replace(/\sdata-styles-preset="[^"]*"/gi, "")
    .replace(/\sclass="[^"]*"/gi, "");
}

let idCounter = 0;
function shortId(): string {
  return "n" + (idCounter++).toString(36);
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
