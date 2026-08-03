import postcss, { type Rule, type AtRule, type Declaration } from "postcss";
import type { HTMLElement } from "node-html-parser";
import type { CssDecls } from "../../ir/types.js";
import { log } from "../../util/log.js";

/**
 * Real(ish) CSS cascade resolution.
 *
 * Framer puts a large fraction of its styling — especially text presets and nested
 * layout — in **compound** (`.a.b`) and **descendant** (`.a .b h4`) selectors. A
 * single-class resolver drops all of that and the result looks broken. So instead we
 * match every selector against the actual DOM with `querySelectorAll`, and accumulate
 * the winning declarations onto each element (respecting specificity + source order).
 * The result is a per-element resolved style we can re-emit under clean class names.
 */

export interface ResolvedStyle {
  base: CssDecls;
  pseudo: Map<string, CssDecls>;
  media: Array<{ query: string; decls: CssDecls; pseudo: Map<string, CssDecls> }>;
}

export interface Cascade {
  /** Resolved style for an element (or undefined if it had no matching rules). */
  styleOf(el: HTMLElement): ResolvedStyle | undefined;
  /** Effective `display` for an element at a viewport width (for variant collapse). */
  displayAtWidth(el: HTMLElement, width: number): string | undefined;
  /** Global passthrough CSS: resets, element selectors, @font-face, @keyframes. */
  rootCss: string;
  /** --token-* color values (Framer shared color styles). */
  tokenColors: Map<string, string>;
  /** Framer link colours, to be re-declared at :root. */
  linkVars: Map<string, string>;
}

interface ParsedRule {
  /** Selector with pseudo-classes/elements stripped, for DOM matching. */
  match: string;
  /** A pseudo suffix on the key compound, e.g. ":hover" / "::before", or "". */
  pseudo: string;
  decls: CssDecls;
  specificity: number;
  order: number;
  media?: string;
}

const PSEUDO_RE = /(::?[A-Za-z][\w-]*(?:\([^)]*\))?)/g;
const KEY_PSEUDO_RE = /((?:::?[A-Za-z][\w-]*(?:\([^)]*\))?)+)\s*$/;

function declsOf(rule: Rule): CssDecls {
  const out: CssDecls = {};
  rule.each((node) => {
    if (node.type === "decl") {
      const d = node as Declaration;
      out[d.prop] = d.value + (d.important ? " !important" : "");
    }
  });
  return out;
}

function specificityOf(sel: string): number {
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  const classes = (sel.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) || []).length;
  const els = (sel.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
  return ids * 10000 + classes * 100 + els;
}

/** Split a selector into a DOM-matchable part + the key pseudo (if any). */
function prepareSelector(sel: string): { match: string; pseudo: string } | null {
  const s = sel.trim();
  if (!s) return null;
  // Pull the pseudo on the rightmost compound (the "key").
  let pseudo = "";
  const km = KEY_PSEUDO_RE.exec(s);
  if (km) {
    // Only treat :hover/:focus/:active/::before/::after etc. as emittable pseudo on the key.
    pseudo = km[1]!;
  }
  // Strip ALL pseudo for matching (over-match a little; acceptable for Framer output).
  let match = s.replace(PSEUDO_RE, "").trim();
  // If stripping emptied a compound (selector was just a pseudo), bail.
  if (!match) return null;
  // node-html-parser doesn't support sibling combinators well; skip them.
  if (/[~+]/.test(match)) return null;
  return { match, pseudo };
}

function isGlobalSelector(sel: string): boolean {
  const s = sel.trim();
  if (!s) return false;
  if (s.includes(".") || s.includes("[") || s.includes("#")) return false;
  if (/framer/i.test(s)) return false;
  return true; // *, html, body, element selectors, ::selection, a:hover, etc.
}

export function computeCascade(doc: HTMLElement, cssBlocks: string[]): Cascade {
  const targeted: ParsedRule[] = [];
  const rootChunks: string[] = [];
  const tokenColors = new Map<string, string>();
  const linkVars = new Map<string, string>();
  let order = 0;

  const handleRule = (rule: Rule, media?: string) => {
    const decls = declsOf(rule);
    // Capture color tokens wherever they are defined.
    for (const [prop, val] of Object.entries(decls)) {
      if (prop.startsWith("--token-")) tokenColors.set(prop, val.replace(/\s*!important$/i, ""));
      // Link colours are declared inside a rule scoped to Framer's generated class
      // names. Those names don't survive a rebuild, so the declaration would be kept
      // but reach nothing — the active nav link loses its colour. Capture the value so
      // it can be re-declared at the document root.
      if (prop.startsWith("--framer-link-") && prop.endsWith("-text-color")) {
        linkVars.set(prop, val.replace(/\s*!important$/i, ""));
      }
    }
    const selectors = rule.selectors ?? [rule.selector];
    let keptGlobal = false;
    for (const sel of selectors) {
      if (isGlobalSelector(sel)) {
        keptGlobal = true;
        continue;
      }
      const prepared = prepareSelector(sel);
      if (!prepared) continue;
      targeted.push({
        match: prepared.match,
        pseudo: prepared.pseudo,
        decls,
        specificity: specificityOf(sel),
        order: order++,
        media,
      });
    }
    if (keptGlobal && !media) rootChunks.push(rule.toString());
    if (keptGlobal && media) rootChunks.push(`@media ${media}{${rule.toString()}}`);
  };

  for (const css of cssBlocks) {
    let rootNode;
    try {
      rootNode = postcss.parse(css);
    } catch (err) {
      log.debug(`skipping unparseable <style>: ${(err as Error).message}`);
      continue;
    }
    rootNode.each((node) => {
      if (node.type === "rule") handleRule(node as Rule);
      else if (node.type === "atrule") {
        const at = node as AtRule;
        if (at.name === "media") {
          at.each((child) => {
            if (child.type === "rule") handleRule(child as Rule, at.params);
          });
        } else if (at.name === "font-face" || at.name === "keyframes") {
          rootChunks.push(at.toString());
        }
      }
    });
  }

  // Apply rules in cascade order (specificity asc, then source order) so later wins.
  targeted.sort((a, b) => a.specificity - b.specificity || a.order - b.order);

  const styles = new Map<HTMLElement, ResolvedStyle>();
  const ensure = (el: HTMLElement): ResolvedStyle => {
    let s = styles.get(el);
    if (!s) {
      s = { base: {}, pseudo: new Map(), media: [] };
      styles.set(el, s);
    }
    return s;
  };
  const mediaBucket = (s: ResolvedStyle, query: string) => {
    let m = s.media.find((x) => x.query === query);
    if (!m) {
      m = { query, decls: {}, pseudo: new Map() };
      s.media.push(m);
    }
    return m;
  };

  let matchFailures = 0;
  for (const rule of targeted) {
    let matched: HTMLElement[];
    try {
      matched = doc.querySelectorAll(rule.match) as unknown as HTMLElement[];
    } catch {
      matchFailures++;
      continue;
    }
    for (const el of matched) {
      const s = ensure(el);
      if (!rule.media) {
        if (rule.pseudo) mergeInto(pseudoMap(s.pseudo, rule.pseudo), rule.decls);
        else Object.assign(s.base, rule.decls);
      } else {
        const m = mediaBucket(s, rule.media);
        if (rule.pseudo) mergeInto(pseudoMap(m.pseudo, rule.pseudo), rule.decls);
        else Object.assign(m.decls, rule.decls);
      }
    }
  }
  if (matchFailures) log.debug(`${matchFailures} selector(s) could not be matched and were skipped`);

  return {
    styleOf: (el) => styles.get(el),
    displayAtWidth: (el, width) => {
      const s = styles.get(el);
      if (!s) return undefined;
      let display = bare(s.base["display"]);
      for (const m of s.media) {
        if (queryMatchesWidth(m.query, width) && m.decls["display"] != null) {
          display = bare(m.decls["display"]);
        }
      }
      return display;
    },
    rootCss: dedupe(rootChunks).join("\n\n"),
    tokenColors,
    linkVars,
  };
}

function pseudoMap(map: Map<string, CssDecls>, key: string): CssDecls {
  let d = map.get(key);
  if (!d) {
    d = {};
    map.set(key, d);
  }
  return d;
}
function mergeInto(target: CssDecls, src: CssDecls) {
  Object.assign(target, src);
}

function bare(v: string | undefined): string | undefined {
  return v?.replace(/\s*!important\s*$/i, "").trim();
}

function dedupe(chunks: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of chunks) {
    const key = c.replace(/\s+/g, " ").trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

export function queryMatchesWidth(query: string, width: number): boolean {
  const parts = query.split(/\band\b/);
  for (const part of parts) {
    const min = /min-width:\s*([\d.]+)px/.exec(part);
    const max = /max-width:\s*([\d.]+)px/.exec(part);
    if (min && width < parseFloat(min[1]!)) return false;
    if (max && width > parseFloat(max[1]!)) return false;
  }
  return true;
}

/**
 * Split a declaration list on top-level `;` only.
 *
 * A naive `split(";")` truncates any value that legitimately contains one — most
 * commonly `url('data:image/svg+xml;base64,…')`, which then emits as an unterminated
 * string and fails the generated project's CSS parse outright. Quotes and parentheses
 * therefore have to be tracked.
 */
function splitDeclarations(style: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;

  for (let i = 0; i < style.length; i++) {
    const ch = style[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      parts.push(style.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(style.slice(start));
  return parts;
}

export function parseInlineStyle(style: string): CssDecls {
  const out: CssDecls = {};
  for (const part of splitDeclarations(style)) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    const prop = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (prop && value) out[prop] = value;
  }
  return out;
}

/** Declarations that are Framer-runtime noise and add nothing to a clean rebuild. */
const DROP_PROPS = new Set<string>(["--framer-will-change-override", "will-change"]);

/** Merge an element's cascade-resolved style with its inline style (inline wins). */
export function withInline(resolved: ResolvedStyle | undefined, inlineStyle: string | undefined): ResolvedStyle {
  const base: CssDecls = { ...(resolved?.base ?? {}) };
  if (inlineStyle) Object.assign(base, parseInlineStyle(inlineStyle));
  for (const p of DROP_PROPS) delete base[p];
  const pseudo = new Map(resolved?.pseudo ?? []);
  const media = (resolved?.media ?? []).map((m) => {
    const decls = { ...m.decls };
    for (const p of DROP_PROPS) delete decls[p];
    return { query: m.query, decls, pseudo: new Map(m.pseudo) };
  });
  return { base, pseudo, media };
}
