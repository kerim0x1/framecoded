import type { IRNode, IRSite, IRStyle } from "./types.js";

export interface AnimatedTextStats {
  /** Animated glyph nodes moved onto a shared, readable style class. */
  consolidated: number;
  /** Distinct animated-glyph style classes retained. */
  classes: number;
}

/**
 * Framer splits animated headings into one span per character. Those spans need their
 * own motion ids, but their typography is usually identical; keeping a generated class
 * per letter makes both TSX and CSS unreadable for no visual benefit.
 *
 * Share class names only when the full base/pseudo/responsive style is byte-identical.
 * Motion remains on the individual node and therefore keeps its exact delay/keyframes.
 */
export function consolidateAnimatedTextStyles(site: IRSite): AnimatedTextStats {
  const used = new Set<string>();
  for (const page of site.pages) walk(page.root, (node) => node.className && used.add(node.className));

  const classes = new Map<string, string>();
  let consolidated = 0;

  for (const page of site.pages) {
    walk(page.root, (node) => {
      if (node.kind !== "text" || node.tag !== "span" || !node.animations?.length || !node.className) return;
      // Per-character spans are the noisy case. Longer animated text blocks remain
      // semantically named after their Framer layer.
      if ([...node.text].length > 2) return;
      const signature = styleSignature(node.style);
      let shared = classes.get(signature);
      if (!shared) {
        shared = uniqueClass("animatedGlyph", used);
        classes.set(signature, shared);
      }
      if (node.className !== shared) {
        node.className = shared;
        consolidated++;
      }
    });
  }

  return { consolidated, classes: classes.size };
}

function styleSignature(style: IRStyle): string {
  return JSON.stringify(style);
}

function uniqueClass(base: string, used: Set<string>): string {
  let name = base;
  let index = 2;
  while (used.has(name)) name = `${base}${index++}`;
  used.add(name);
  return name;
}

function walk(node: IRNode, visit: (node: IRNode) => void): void {
  visit(node);
  if (node.kind === "element") node.children.forEach((child) => walk(child, visit));
}
