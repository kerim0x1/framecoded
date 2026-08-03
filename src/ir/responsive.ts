/**
 * Breakpoint folding.
 *
 * Framer stores every breakpoint (Desktop / Tablet / Phone) as its own complete copy
 * of the design under the page node. Emitting them as-is would stack N copies of the
 * site on top of each other, so the widest breakpoint becomes the base tree and the
 * narrower ones are folded into it as media-query deltas.
 *
 * Pure IR-in / IR-out, with no Framer SDK dependency, so the CLI and the plugin share
 * one implementation and it can be tested directly.
 */
import type { IRNode, IRElement, CssDecls } from "./types.js";

/**
 * Neutral values for properties a narrower breakpoint drops entirely.
 *
 * Without an explicit reset the base declaration leaks down the cascade — a desktop
 * `display: flex` would still apply on mobile even though that breakpoint's frame
 * isn't a stack at all. Only properties with an unambiguous "off" state are listed;
 * anything else is left to inherit rather than guessed at.
 */
const RESET_VALUES: Record<string, string> = {
  display: "block",
  position: "static",
  width: "auto",
  height: "auto",
  "max-width": "none",
  "min-width": "0",
  "flex-grow": "0",
  "flex-basis": "auto",
  "flex-shrink": "1",
  "background-color": "transparent",
  "border-radius": "0",
  opacity: "1",
  transform: "none",
  "z-index": "auto",
  gap: "0px",
  padding: "0px",
  color: "inherit",
  "text-align": "left",
};

/** Declarations needed at a narrower breakpoint to reach `variant` from `base`. */
export function diffDecls(base: CssDecls, variant: CssDecls): CssDecls {
  const out: CssDecls = {};
  for (const [k, v] of Object.entries(variant)) if (base[k] !== v) out[k] = v;
  for (const k of Object.keys(base)) {
    if (k in variant) continue;
    const reset = RESET_VALUES[k];
    if (reset != null) out[k] = reset;
  }
  return out;
}

/**
 * Identity of a layer across breakpoints. Class names are uniquified per node
 * (`hero`, `hero2`, …) so they can't be compared — content and shape can.
 */
export function structuralKey(n: IRNode): string {
  switch (n.kind) {
    case "text":
      return `t:${n.text.slice(0, 32)}`;
    case "image":
      return `i:${n.src.slice(-40)}`;
    case "svg":
      return `s:${n.svg.length}`;
    default:
      return `e:${n.tag}:${n.children.length}`;
  }
}

const GENERIC_LAYER_NAME =
  /^(?:div|el|span|frame|container|variant|wrapper|content|group|stack|box|row|col|column|inner|outer|holder|block|elem|node|section)$/i;
const BREAKPOINT_NAME = /^(?:desktop|tablet|mobile|phone|breakpoint|wide|narrow|small|medium|large)$/i;
const SIGNAL_STOP_WORDS = new Set([
  "and", "are", "but", "for", "from", "has", "have", "into", "not", "that", "the", "this", "with", "you", "your",
]);

/** A designer-facing identity with generated suffixes and breakpoint labels removed. */
function semanticName(node: IRNode): string {
  const source = node.className ?? node.attrs["data-framer-name"] ?? "";
  const tokens = source
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\d+$/g, " ")
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token && !BREAKPOINT_NAME.test(token));
  const name = tokens.join("");
  return name && !GENERIC_LAYER_NAME.test(name) ? name : "";
}

/** Content survives even when Framer gives the breakpoint roots unrelated names. */
function semanticSignals(node: IRNode, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 9 || out.size >= 96) return out;

  const addWords = (value: string | undefined, prefix = "w") => {
    if (!value) return;
    const words = value
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2 && !SIGNAL_STOP_WORDS.has(word));
    for (const word of words) {
      out.add(`${prefix}:${word}`);
      if (out.size >= 96) break;
    }
    if (words.length > 1) out.add(`p:${words.slice(0, 8).join("-")}`);
  };

  if (node.kind === "text") addWords(node.text);
  if (node.kind === "image") {
    addWords(node.alt, "a");
    const asset = node.src.split(/[?#]/, 1)[0]?.split("/").pop()?.toLowerCase();
    if (asset) out.add(`i:${asset}`);
  }
  if ((node.kind === "element" || node.kind === "text") && node.href) {
    out.add(`h:${node.href.replace(/[?#].*$/, "").toLowerCase()}`);
  }
  if (node.kind === "element") {
    for (const child of node.children) semanticSignals(child, out, depth + 1);
  }
  return out;
}

function signalSimilarity(base: IRNode, variant: IRNode): number {
  const left = semanticSignals(base);
  const right = semanticSignals(variant);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const signal of left) if (right.has(signal)) shared++;
  return shared / Math.min(left.size, right.size);
}

function firstHeading(node: IRNode, depth = 0): string {
  if (depth > 7) return "";
  if (node.kind === "text" && /^h[1-6]$/.test(node.tag)) {
    return node.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  }
  if (node.kind === "element") {
    for (const child of node.children) {
      const heading = firstHeading(child, depth + 1);
      if (heading) return heading;
    }
  }
  return "";
}

/**
 * Confidence that two sibling layers are the same semantic region at different widths.
 * High-value human signals outweigh structural differences, while position and shape
 * keep anonymous Framer scaffolding aligned around inserted mobile-only layers.
 */
function responsiveMatchScore(base: IRNode, variant: IRNode, baseIndex: number, variantIndex: number): number {
  if (base.kind !== variant.kind) return Number.NEGATIVE_INFINITY;

  let score = base.tag === variant.tag ? 18 : -12;
  if (structuralKey(base) === structuralKey(variant)) score += 24;

  const baseName = semanticName(base);
  const variantName = semanticName(variant);
  if (baseName && variantName) score += baseName === variantName ? 72 : -36;

  const baseHeading = firstHeading(base);
  const variantHeading = firstHeading(variant);
  if (baseHeading && variantHeading) score += baseHeading === variantHeading ? 88 : -28;

  const similarity = signalSimilarity(base, variant);
  score += similarity * 92;
  if (similarity === 0 && semanticSignals(base).size > 1 && semanticSignals(variant).size > 1) score -= 32;

  if (base.kind === "image" && variant.kind === "image" && base.src === variant.src) score += 96;
  if (base.kind === "element" && variant.kind === "element") {
    const largest = Math.max(base.children.length, variant.children.length, 1);
    score += (Math.min(base.children.length, variant.children.length) / largest) * 12;
  }

  score += Math.max(0, 12 - Math.abs(baseIndex - variantIndex) * 3);
  return score;
}

export interface MergeResult {
  /** Subtrees whose layer structure didn't line up with the primary breakpoint. */
  structureMismatches: number;
}

/**
 * Fold `variant` into `base` as overrides that apply under `media`.
 * Mutates `base`; `variant` nodes may be adopted into it when breakpoint-specific.
 */
export function mergeBreakpoint(base: IRNode, variant: IRNode, media: string): MergeResult {
  const result: MergeResult = { structureMismatches: 0 };
  mergeNode(base, variant, media, result);
  return result;
}

/** The declarations actually reaching the next, narrower max-width query. */
function cascadedDecls(node: IRNode): CssDecls {
  const out: CssDecls = { ...node.style.base };
  for (const override of node.style.responsive) Object.assign(out, override.style);
  return out;
}

/** Pseudo declarations actually reaching the next, narrower max-width query. */
function cascadedPseudoDecls(node: IRNode): Record<string, CssDecls> {
  const out: Record<string, CssDecls> = {};
  for (const [selector, decls] of Object.entries(node.style.pseudo)) out[selector] = { ...decls };
  for (const override of node.style.responsive) {
    for (const [selector, decls] of Object.entries(override.pseudo ?? {})) {
      Object.assign((out[selector] ??= {}), decls);
    }
  }
  return out;
}

function diffPseudoDecls(
  base: Record<string, CssDecls>,
  variant: Record<string, CssDecls>,
): Record<string, CssDecls> {
  const out: Record<string, CssDecls> = {};
  for (const [selector, decls] of Object.entries(variant)) {
    const delta = diffDecls(base[selector] ?? {}, decls);
    if (Object.keys(delta).length) out[selector] = delta;
  }
  return out;
}

function mergeNode(base: IRNode, variant: IRNode, media: string, result: MergeResult): void {
  // Queries are emitted widest to narrowest and all matching max-width queries cascade
  // on a phone. Compare against the preceding effective state, not just desktop. This
  // emits required resets such as desktop 24px -> tablet 16px -> phone 24px.
  const decls = diffDecls(cascadedDecls(base), variant.style.base);
  const pseudo = diffPseudoDecls(cascadedPseudoDecls(base), variant.style.pseudo);
  if (Object.keys(decls).length || Object.keys(pseudo).length) {
    base.style.responsive.push({
      media,
      style: decls,
      ...(Object.keys(pseudo).length ? { pseudo } : {}),
    });
  }

  // Framer can assign different reveal offsets, delays and ticker timings at each
  // breakpoint. Keep the rendered variant calls on the shared node; the generated
  // runtime chooses one matching media group rather than layering all of them.
  if (variant.animations?.length) {
    const responsiveAnimations = variant.animations.map((animation) => ({ ...animation, media }));
    base.animations = [...(base.animations ?? []), ...responsiveAnimations];
  }

  // Stateful components have rendered geometry at each viewport too. Keep those states
  // beside the ordinary responsive CSS so the runtime does not animate a phone component
  // toward desktop geometry.
  if (variant.interaction) {
    if (base.interaction) {
      const responsive = base.interaction.responsive ?? [];
      responsive.push({
        media,
        targets: variant.interaction.targets,
        duration: variant.interaction.duration,
        easing: variant.interaction.easing,
      });
      base.interaction.responsive = responsive;
    } else {
      base.interaction = variant.interaction;
      const trigger = variant.attrs["data-framecoded-trigger"];
      if (trigger) base.attrs["data-framecoded-trigger"] = trigger;
    }
  }
  const stateId = variant.attrs["data-framecoded-state"];
  if (stateId && !base.attrs["data-framecoded-state"]) base.attrs["data-framecoded-state"] = stateId;

  if (base.kind === "element" && variant.kind === "element") {
    mergeChildren(base, variant, media, result);
  }
}

function mergeChildren(base: IRElement, variant: IRElement, media: string, result: MergeResult): void {
  const bc = base.children;
  const vc = variant.children;

  // The common case: breakpoints mirror the same layer tree, so index alignment holds.
  if (bc.length === vc.length) {
    for (let i = 0; i < bc.length; i++) mergeNode(bc[i]!, vc[i]!, media, result);
    return;
  }

  result.structureMismatches++;
  const usedVariant = new Set<number>();
  const matchedBase = new Set<number>();

  // A section may have a different child count at each Framer breakpoint while still
  // being the same About, Hero, Pricing, or Navigation component. Match the strongest
  // semantic pairs globally instead of accepting the first generic `div:N` shape.
  const candidates: Array<{ bi: number; vi: number; score: number }> = [];
  bc.forEach((b, bi) => {
    vc.forEach((v, vi) => {
      const score = responsiveMatchScore(b, v, bi, vi);
      if (score >= 45) candidates.push({ bi, vi, score });
    });
  });
  candidates.sort(
    (a, b) => b.score - a.score || Math.abs(a.bi - a.vi) - Math.abs(b.bi - b.vi) || a.bi - b.bi,
  );

  for (const candidate of candidates) {
    if (matchedBase.has(candidate.bi) || usedVariant.has(candidate.vi)) continue;
    matchedBase.add(candidate.bi);
    usedVariant.add(candidate.vi);
    mergeNode(bc[candidate.bi]!, vc[candidate.vi]!, media, result);
  }

  // Present in the primary but not at this width — hide it here.
  bc.forEach((b, bi) => {
    if (!matchedBase.has(bi)) b.style.responsive.push({ media, style: { display: "none" } });
  });

  // Breakpoint-only layers (a phone-only menu, say) join the shared DOM hidden by
  // default and reveal themselves inside the query.
  vc.forEach((v, vi) => {
    if (usedVariant.has(vi)) return;
    const shown = v.style.base["display"] ?? "block";
    v.style.base["display"] = "none";
    v.style.responsive.push({ media, style: { display: shown } });
    bc.push(v);
  });
}
