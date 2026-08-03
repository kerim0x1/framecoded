/**
 * Materialize Framer's typography custom properties.
 *
 * Framer never writes `font-size` on a text layer. It writes `--framer-font-size: 77px`
 * on the element and relies on a rule in its own global stylesheet — scoped to the
 * generated `.framer-xxxx` class names — to read it back out:
 *
 *   .framer-xxxx .framer-text { font-size: var(--framer-font-size, 16px); … }
 *
 * A clean rebuild emits CSS-Module class names instead, so those selectors no longer
 * match anything. The custom properties survive, nothing consumes them, and every
 * heading silently collapses to the browser's 16px in near-black — the design is
 * present in the CSS but invisible on screen.
 *
 * So each variable is turned into the concrete declaration it was always meant to
 * produce, keeping the `var()` reference (with the original as fallback) so the values
 * stay editable in one place.
 */
import type { CssDecls, IRNode, IRSite } from "./types.js";

/** Framer custom property → the declaration that consumes it. */
const VAR_TO_PROP: Record<string, string> = {
  "--framer-font-family": "font-family",
  "--framer-font-size": "font-size",
  "--framer-font-weight": "font-weight",
  "--framer-font-style": "font-style",
  "--framer-text-color": "color",
  "--framer-line-height": "line-height",
  "--framer-letter-spacing": "letter-spacing",
  "--framer-text-alignment": "text-align",
  "--framer-text-transform": "text-transform",
  "--framer-text-decoration": "text-decoration",
  "--framer-font-variation-axes": "font-variation-settings",
  "--framer-font-open-type-features": "font-feature-settings",
};

export interface FramerVarStats {
  /** Declarations added because nothing was reading the variable. */
  materialized: number;
  nodes: number;
}

function materializeDecls(decls: CssDecls, stats: FramerVarStats): void {
  let touched = false;
  for (const [variable, prop] of Object.entries(VAR_TO_PROP)) {
    const value = decls[variable];
    if (value == null || value === "") continue;
    // An explicit declaration already won the cascade; don't fight it.
    if (decls[prop] != null) continue;
    decls[prop] = `var(${variable}, ${value})`;
    stats.materialized++;
    touched = true;
  }
  if (touched) stats.nodes++;
}

function walk(node: IRNode, stats: FramerVarStats): void {
  materializeDecls(node.style.base, stats);
  for (const decls of Object.values(node.style.pseudo)) materializeDecls(decls, stats);
  // Breakpoints override the variables too, so each query needs the same treatment.
  for (const override of node.style.responsive) materializeDecls(override.style, stats);
  if (node.kind === "element") for (const child of node.children) walk(child, stats);
}

export function materializeFramerVars(site: IRSite): FramerVarStats {
  const stats: FramerVarStats = { materialized: 0, nodes: 0 };
  for (const page of site.pages) walk(page.root, stats);
  return stats;
}
