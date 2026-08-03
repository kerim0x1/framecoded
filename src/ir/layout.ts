/**
 * Layout normalization.
 *
 * Design tools position absolutely-placed layers against their immediate parent frame.
 * CSS doesn't: it resolves them against the nearest *positioned* ancestor. Every adapter
 * inherits that mismatch from its source, so the correction lives here — one pure IR
 * pass, run for both the plugin and published-site paths.
 */
import type { IRNode, IRSite } from "./types.js";

export interface LayoutStats {
  /** Parents given an explicit containing block. */
  containers: number;
  /** Over-constrained boxes whose redundant fixed size was dropped. */
  unpinned: number;
}

function isAbsolute(n: IRNode): boolean {
  return n.style.base["position"] === "absolute";
}

/**
 * `left` + `right` + `width` is over-constrained: CSS keeps the width and ignores one
 * edge, so a box the design meant to stretch stays frozen at its canvas width. Dropping
 * the redundant axis is what lets it track the viewport.
 */
function unpinRedundantSize(n: IRNode): boolean {
  const s = n.style.base;
  if (s["position"] !== "absolute" && s["position"] !== "fixed") return false;
  let changed = false;
  if (s["left"] != null && s["right"] != null && s["width"] != null) {
    delete s["width"];
    changed = true;
  }
  if (s["top"] != null && s["bottom"] != null && s["height"] != null) {
    delete s["height"];
    changed = true;
  }
  return changed;
}

function walk(node: IRNode, stats: LayoutStats): void {
  if (unpinRedundantSize(node)) stats.unpinned++;
  if (node.kind !== "element") return;

  if (!node.style.base["position"] && node.children.some(isAbsolute)) {
    node.style.base["position"] = "relative";
    stats.containers++;
  }
  for (const child of node.children) walk(child, stats);
}

/** Idempotent — safe to run after an adapter has already applied its own fixes. */
export function normalizeLayout(site: IRSite): LayoutStats {
  const stats: LayoutStats = { containers: 0, unpinned: 0 };
  for (const page of site.pages) walk(page.root, stats);
  return stats;
}
