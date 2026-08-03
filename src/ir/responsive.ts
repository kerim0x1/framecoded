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

  bc.forEach((b, bi) => {
    const key = structuralKey(b);
    const vi = vc.findIndex((v, i) => !usedVariant.has(i) && structuralKey(v) === key);
    if (vi === -1) return;
    usedVariant.add(vi);
    matchedBase.add(bi);
    mergeNode(b, vc[vi]!, media, result);
  });

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
