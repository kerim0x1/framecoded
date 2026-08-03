import type { IRNode, IRStyle, CssDecls } from "../ir/types.js";

export function hasAnyStyle(style: IRStyle): boolean {
  return (
    Object.keys(style.base).length > 0 ||
    Object.keys(style.pseudo).length > 0 ||
    style.responsive.some((r) => Object.keys(r.style).length > 0 || (r.pseudo && Object.keys(r.pseudo).length))
  );
}

/** Depth-first list of nodes (within a subtree) that carry a class + style. */
export function collectStyledNodes(root: IRNode): IRNode[] {
  const out: IRNode[] = [];
  const walk = (n: IRNode) => {
    if (n.className && hasAnyStyle(n.style)) out.push(n);
    if (n.kind === "element") n.children.forEach(walk);
  };
  walk(root);
  return out;
}

function renderDecls(decls: CssDecls, indent = "  "): string {
  const lines: string[] = [];
  for (const [prop, value] of Object.entries(decls)) {
    if (value == null || value === "") continue;
    lines.push(`${indent}${prop}: ${value};`);
  }
  return lines.join("\n");
}

/** Generate the CSS-Module text for a set of nodes (one component's subtree). */
export function generateModuleCss(nodes: IRNode[]): string {
  const blocks: string[] = [];
  const emittedClasses = new Set<string>();
  // Group media overrides so each query gets a single @media block.
  const mediaGroups = new Map<string, string[]>();

  for (const node of nodes) {
    const cls = node.className!;
    // Animated glyph beautification intentionally shares one class across many spans.
    // The declarations are identical, so emit the CSS module rule only once.
    if (emittedClasses.has(cls)) continue;
    emittedClasses.add(cls);
    const { base, pseudo, responsive } = node.style;

    if (Object.keys(base).length) {
      blocks.push(`.${cls} {\n${renderDecls(base)}\n}`);
    }
    for (const [sel, decls] of Object.entries(pseudo)) {
      if (Object.keys(decls).length) blocks.push(`.${cls}${sel} {\n${renderDecls(decls)}\n}`);
    }
    for (const r of responsive) {
      const inner: string[] = [];
      if (Object.keys(r.style).length) inner.push(`  .${cls} {\n${renderDecls(r.style, "    ")}\n  }`);
      if (r.pseudo) {
        for (const [sel, decls] of Object.entries(r.pseudo)) {
          if (Object.keys(decls).length) inner.push(`  .${cls}${sel} {\n${renderDecls(decls, "    ")}\n  }`);
        }
      }
      if (inner.length) {
        const arr = mediaGroups.get(r.media) ?? [];
        arr.push(inner.join("\n"));
        mediaGroups.set(r.media, arr);
      }
    }
  }

  // Emit media groups sorted desktop-first (largest min-width / max-width first).
  const queries = [...mediaGroups.keys()].sort(sortQueriesDesktopFirst);
  for (const q of queries) {
    blocks.push(`@media ${q} {\n${mediaGroups.get(q)!.join("\n")}\n}`);
  }

  return blocks.join("\n\n") + "\n";
}

function sortQueriesDesktopFirst(a: string, b: string): number {
  return queryWeight(b) - queryWeight(a);
}
function queryWeight(q: string): number {
  const min = /min-width:\s*([\d.]+)px/.exec(q);
  const max = /max-width:\s*([\d.]+)px/.exec(q);
  if (min) return parseFloat(min[1]!);
  if (max) return parseFloat(max[1]!) - 100000; // max-width queries after min-width
  return -200000;
}
