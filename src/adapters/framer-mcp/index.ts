import { readFile } from "node:fs/promises";
import { parse as parseXml, HTMLElement, NodeType } from "node-html-parser";
import type {
  IRSite,
  IRPage,
  IRNode,
  IRElement,
  IRText,
  IRImage,
  IRSvg,
  IRStyle,
  IRColorStyle,
} from "../../ir/types.js";
import { toCamelCase, toPascalCase, routeFromPathname, NameRegistry } from "../../util/names.js";
import { traitsToCss, determineNodeType, type Attrs } from "./css.js";
import { log } from "../../util/log.js";

let idc = 0;
const nid = () => "m" + (idc++).toString(36);
let names = new NameRegistry();
const style = (css: Record<string, string>): IRStyle => ({ base: css, pseudo: {}, responsive: [] });
const emptyStyle = (): IRStyle => ({ base: {}, pseudo: {}, responsive: [] });

const HEADING_NAME = /\b(h[1-6]|heading|title|headline)\b/i;
const SEMANTIC_NAME: Array<[RegExp, string]> = [
  [/\b(header|navbar)\b/i, "header"],
  [/\bnav(igation)?\b/i, "nav"],
  [/\bfooter\b/i, "footer"],
  [/\bsection\b/i, "section"],
  [/\b(list|items)\b/i, "ul"],
];

export async function ingestFramerMcpFile(filePath: string): Promise<IRSite> {
  const xml = await readFile(filePath, "utf8");
  return ingestFramerMcp(xml);
}

export function ingestFramerMcp(xml: string): IRSite {
  const doc = parseXml(xml, { comment: false, voidTag: { closingSlash: true } as never });
  names = new NameRegistry();

  const colorStyles = parseColorStyles(doc);
  const pages = parsePages(doc);

  if (!pages.length) throw new Error("No pages/content found in the MCP XML. Provide getNodeXml output for at least one page.");

  const name = text(firstByTag(doc, "project")?.getAttribute("name")) ?? pages[0]!.name ?? "Framer Site";

  return {
    name,
    source: { type: "plugin", origin: "framer-mcp" },
    baseUrl: undefined,
    pages,
    favicons: [],
    colorStyles,
    fonts: [],
    globalCss: "",
    assets: [],
    lang: "en",
  };
}

function parsePages(doc: HTMLElement): IRPage[] {
  // Page containers can be <Page>/<WebPageNode> (with path) or, for a single
  // getNodeXml dump, the whole tree is one page.
  const pageEls = [...allByTag(doc, "webpagenode"), ...allByTag(doc, "page")].filter(
    (el) => contentChildren(el).length > 0,
  );

  const usedRoutes = new Set<string>();
  const pages: IRPage[] = [];

  const addPage = (root: IRNode, path: string, fallbackName: string) => {
    let { path: p, name } = path ? routeFromPathname(path) : { path: "/", name: toPascalCase(fallbackName) || "Home" };
    let i = 2;
    const baseP = p;
    while (usedRoutes.has(p)) p = `${baseP}-${i++}`;
    usedRoutes.add(p);
    pages.push({ path: p, name, meta: { title: name, openGraph: {}, twitter: {}, jsonLd: [] }, root });
  };

  if (pageEls.length) {
    for (const pageEl of pageEls) {
      const kids = contentChildren(pageEl).map((c) => nodeToIR(c)).filter(Boolean) as IRNode[];
      const root = wrap(kids);
      addPage(root, pageEl.getAttribute("path") ?? "", pageEl.getAttribute("name") ?? "Page");
    }
    return pages;
  }

  // Single getNodeXml content tree (no <Page> wrapper): treat the top element(s) as one page.
  const roots = contentRoots(doc);
  const kids = roots.map((c) => nodeToIR(c)).filter(Boolean) as IRNode[];
  if (kids.length) addPage(wrap(kids), "", "Home");
  return pages;
}

function wrap(kids: IRNode[]): IRNode {
  if (kids.length === 1) return kids[0]!;
  return { kind: "element", id: nid(), tag: "main", style: emptyStyle(), attrs: {}, children: kids };
}

/** Top-level content elements, skipping the meta sections of a project dump. */
function contentRoots(doc: HTMLElement): HTMLElement[] {
  const skip = new Set(["colorstyles", "textstyles", "codecomponents", "codeoverrides", "components", "designpages", "pages", "project"]);
  const body = doc.querySelector("body") ?? doc;
  const top = elementChildren(body);
  // Unwrap a single <Project>/wrapper to reach real content.
  const out: HTMLElement[] = [];
  for (const el of top) {
    if (skip.has(el.rawTagName?.toLowerCase() ?? "")) continue;
    out.push(el);
  }
  return out.length ? out : top;
}

function nodeToIR(el: HTMLElement): IRNode | null {
  const tagName = el.rawTagName ?? "";
  if (!tagName) return null;
  const attrs: Attrs = {};
  for (const [k, v] of Object.entries(el.attributes)) {
    if (k === "nodeId" || k.toLowerCase() === "nodeid") continue;
    attrs[k] = v;
  }
  const directText = directTextOf(el);
  const type = determineNodeType(attrs, directText.length > 0);
  const css = traitsToCss(attrs);
  const layerName = tagName;
  // Keep the className⟺style invariant: only name styled nodes.
  const cls = (c: Record<string, string>, fallback: string) =>
    Object.keys(c).length ? classFrom(layerName, fallback) : undefined;

  if (type === "SVG") {
    return {
      kind: "svg",
      id: nid(),
      tag: "svg",
      className: cls(css, "icon"),
      style: style(css),
      attrs: {},
      svg: attrs["svg"] ?? "",
    } satisfies IRSvg;
  }

  if (type === "Text") {
    return {
      kind: "text",
      id: nid(),
      tag: textTag(layerName, attrs),
      className: cls(css, "text"),
      style: style(css),
      attrs: {},
      text: directText,
    } satisfies IRText;
  }

  // Frame or ComponentInstance: an element with children.
  // A Frame whose only role is to show an image → <img>.
  const bgImage = attrs["backgroundImage"];
  const kids = contentChildren(el).map((c) => nodeToIR(c)).filter(Boolean) as IRNode[];
  if (bgImage && kids.length === 0) {
    const imgCss = stripBg(css);
    return {
      kind: "image",
      id: nid(),
      tag: "img",
      className: cls(imgCss, "image"),
      style: style(imgCss),
      attrs: {},
      src: bgImage,
      alt: text(attrs["altText"]) ?? "",
      altGenerated: false,
    } satisfies IRImage;
  }

  const el2: IRElement = {
    kind: "element",
    id: nid(),
    tag: frameTag(layerName, attrs, kids.length),
    className: cls(css, "frame"),
    style: style(css),
    attrs: {},
    children: kids,
  };
  const link = attrs["link"] ?? attrs["insertUrl"];
  if (link && el2.tag !== "section") {
    el2.tag = "a";
    el2.href = link;
    el2.internalLink = link.startsWith("/");
    if (attrs["linkOpenInNewTab"] === "true") el2.hrefTarget = "_blank";
  }
  return el2;
}

function stripBg(css: Record<string, string>): Record<string, string> {
  const out = { ...css };
  delete out["background-image"];
  return out;
}

function frameTag(layerName: string, attrs: Attrs, childCount: number): string {
  if (attrs["link"] || attrs["insertUrl"]) return "a";
  for (const [re, tag] of SEMANTIC_NAME) if (re.test(layerName)) return tag;
  return "div";
}

function textTag(layerName: string, attrs: Attrs): string {
  const preset = attrs["inlineTextStyle"] ?? "";
  const m = /\b(h[1-6])\b/i.exec(preset) ?? /\b(h[1-6])\b/i.exec(layerName);
  if (m) return m[1]!.toLowerCase();
  if (HEADING_NAME.test(layerName)) return "h2";
  return "p";
}

function classFrom(layerName: string, fallback: string): string | undefined {
  return names.unique(layerName || fallback);
}

function parseColorStyles(doc: HTMLElement): IRColorStyle[] {
  const section = firstByTag(doc, "colorstyles");
  if (!section) return [];
  const out: IRColorStyle[] = [];
  let i = 1;
  for (const el of elementChildren(section)) {
    const name = el.getAttribute("name") ?? el.getAttribute("path") ?? `color ${i}`;
    const light = el.getAttribute("light") ?? el.getAttribute("value") ?? el.text.trim();
    const dark = el.getAttribute("dark") ?? undefined;
    if (!light) continue;
    out.push({ name, varName: `--color-${toCamelCase(name) || i}`, light, dark });
    i++;
  }
  return out;
}

// ---- helpers ----
function allByTag(root: HTMLElement, tagLower: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  const walk = (el: HTMLElement) => {
    for (const c of elementChildren(el)) {
      if ((c.rawTagName ?? "").toLowerCase() === tagLower) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}
function firstByTag(root: HTMLElement, tagLower: string): HTMLElement | undefined {
  return allByTag(root, tagLower)[0];
}
function elementChildren(el: HTMLElement): HTMLElement[] {
  return el.childNodes.filter((n) => n.nodeType === NodeType.ELEMENT_NODE) as HTMLElement[];
}
function contentChildren(el: HTMLElement): HTMLElement[] {
  // Skip plain structural wrappers <div>/<span> by unwrapping them transparently.
  const out: HTMLElement[] = [];
  for (const c of elementChildren(el)) {
    const t = c.rawTagName?.toLowerCase();
    if (t === "div" || t === "span") {
      out.push(...contentChildren(c));
    } else {
      out.push(c);
    }
  }
  return out;
}
function directTextOf(el: HTMLElement): string {
  let t = "";
  for (const c of el.childNodes) {
    if (c.nodeType === NodeType.TEXT_NODE) t += (c as { rawText?: string }).rawText ?? "";
  }
  return t.replace(/\s+/g, " ").trim();
}
function text(v: string | undefined | null): string | undefined {
  return v && v.trim() ? v.trim() : undefined;
}
