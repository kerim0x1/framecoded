/**
 * Class-name sanitation.
 *
 * Class names come from Framer layer names, and Framer auto-names text layers after
 * their own content — so a footer line like "© 2026 Harness Labs, Inc." can produce a
 * name starting with a digit. That is invalid as a CSS selector *and* as a JS property
 * access, and it fails at build time in the generated project rather than at export.
 *
 * Adapters that build names through `NameRegistry` already emit valid ones; this pass
 * is the safety net for hand-written, older, or third-party IR JSON.
 */
import type { IRNode, IRSite } from "./types.js";
import { toCamelCase } from "../util/names.js";

/** A CSS identifier may not start with a digit (nor with `-` + digit). */
const VALID_CLASS = /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/;

function walk(node: IRNode, visit: (n: IRNode) => void): void {
  visit(node);
  if (node.kind === "element") for (const child of node.children) walk(child, visit);
}

/** Rewrites invalid class names in place. Returns how many were changed. */
export function sanitizeClassNames(site: IRSite): number {
  let fixed = 0;
  for (const page of site.pages) {
    // Seed with the names already in use so a rewrite can't collide with a valid one.
    const used = new Set<string>();
    walk(page.root, (n) => {
      if (n.className && VALID_CLASS.test(n.className)) used.add(n.className);
    });

    walk(page.root, (n) => {
      if (!n.className || VALID_CLASS.test(n.className)) return;
      const base = toCamelCase(n.className) || "el";
      let candidate = base;
      let i = 2;
      while (used.has(candidate)) candidate = `${base}${i++}`;
      used.add(candidate);
      n.className = candidate;
      fixed++;
    });
  }
  return fixed;
}
