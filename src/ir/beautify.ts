/**
 * Semantic naming.
 *
 * A published Framer page carries the designer's layer names in `data-framer-name`, and
 * those come through as-is. But plenty of layers were never named, and for those the
 * parser can only fall back to the tag — which is how a page ends up full of `Div101`,
 * `Ul2` and `Variant1`. Those names are correct and useless.
 *
 * This pass renames only the anonymous ones, reading what a human would read: the
 * heading a section contains, the label on a button, the alt text of an image. A node's
 * tag then contributes the suffix, so a `<section>` about pricing becomes
 * `PricingSection` and the list inside it becomes `PricingList`.
 *
 * Pure IR-in / IR-out, so it serves every adapter.
 */
import type { IRNode, IRSite } from "./types.js";
import { toPascalCase, NameRegistry } from "../util/names.js";

/**
 * Names that carry no meaning — either a bare tag or Framer's own scaffolding. Anything
 * matching this is fair game to replace; anything else was chosen by the designer and
 * must survive untouched.
 */
const GENERIC_NAME =
  /^(div|el|span|p|a|ul|ol|li|dl|section|article|aside|figure|frame|container|variant|wrapper|content|group|stack|nav|main|header|footer|img|image|svg|icon|text|item|box|row|col|column|grid|flex|inner|outer|holder|block|elem|node)\d*$/i;

/** Tag → suffix, so the generated name says what the node *is*. */
const ROLE_SUFFIX: Record<string, string> = {
  section: "Section",
  nav: "Nav",
  header: "Header",
  footer: "Footer",
  aside: "Aside",
  article: "Article",
  ul: "List",
  ol: "List",
  li: "Item",
  figure: "Figure",
  form: "Form",
  button: "Button",
  a: "Link",
};

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

export interface BeautifyStats {
  renamed: number;
  /** Names that stayed as-is because the designer had already chosen them. */
  kept: number;
}

function isGeneric(name: string | undefined): boolean {
  if (!name) return true;
  return GENERIC_NAME.test(name.trim());
}

/**
 * Condense a phrase into at most three words of PascalCase.
 *
 * Layer content can be a whole paragraph, and Framer auto-names text layers after their
 * own text, so an unbounded name would be unreadable. Emoji and punctuation are dropped
 * because they can't appear in an identifier.
 */
function condense(phrase: string, maxWords = 3): string {
  let source = phrase.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, " ");
  // Set-in-caps copy ("WELCOME TO", "VIEW PRODUCT") is a styling choice, not an acronym,
  // and carrying it through yields `WELCOMETO`. Only fold when there is no lower-case at
  // all, so a genuine acronym beside normal words ("FAQ Troubleshooting") survives.
  if (!/\p{Ll}/u.test(source)) source = source.toLowerCase();

  const words = source
    .replace(/["'`""'']/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 || /^\d+$/.test(w))
    .slice(0, maxWords);
  return toPascalCase(words.join(" "));
}

/** The first heading inside a subtree — the strongest clue to what a section is about. */
function findHeading(node: IRNode, depth = 0): string | undefined {
  if (depth > 6) return undefined;
  if (node.kind === "text" && HEADING_TAGS.has(node.tag)) return node.text;
  if (node.kind === "element") {
    for (const child of node.children) {
      const found = findHeading(child, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/** Any readable text inside the subtree, used when there's no heading to go on. */
function findText(node: IRNode, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  if (node.kind === "text") return node.text.trim() || undefined;
  if (node.kind === "image") return node.alt?.trim() || undefined;
  if (node.kind === "element") {
    for (const child of node.children) {
      const found = findText(child, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/** Best available label for a node, in descending order of how much it tells us. */
function describe(node: IRNode): string | undefined {
  const heading = findHeading(node);
  if (heading) return condense(heading);

  if (node.kind === "text") return condense(node.text);
  if (node.kind === "image") return node.alt ? condense(node.alt) : undefined;

  // A list is best described by what its items say.
  if (node.kind === "element" && (node.tag === "ul" || node.tag === "ol")) {
    const first = node.children[0];
    if (first) {
      const label = findText(first);
      if (label) return condense(label);
    }
  }

  const text = findText(node);
  return text ? condense(text) : undefined;
}

function rename(node: IRNode, registry: NameRegistry, stats: BeautifyStats): void {
  if (node.className && !isGeneric(node.className)) {
    stats.kept++;
  } else if (node.className) {
    const label = describe(node);
    const suffix = ROLE_SUFFIX[node.tag] ?? "";
    // Avoid "PricingSectionSection" when the content already ends in the role word.
    const base =
      label && suffix && !label.toLowerCase().endsWith(suffix.toLowerCase())
        ? `${label}${suffix}`
        : label || suffix || node.className;
    const next = registry.unique(base || node.className);
    if (next !== node.className) stats.renamed++;
    node.className = next;
  }

  if (node.kind === "element") for (const child of node.children) rename(child, registry, stats);
}

/**
 * Replace anonymous class names with ones derived from content and role.
 *
 * Names are made unique per page, matching how CSS Modules are emitted (one module per
 * component, but component names share one namespace).
 */
export function beautifyNames(site: IRSite): BeautifyStats {
  const stats: BeautifyStats = { renamed: 0, kept: 0 };
  for (const page of site.pages) {
    const registry = new NameRegistry();
    // Seed the registry with names the designer chose, so a generated name can't
    // collide with one and get suffixed into `heroSection2`.
    const seed = (n: IRNode) => {
      if (n.className && !isGeneric(n.className)) registry.unique(n.className);
      if (n.kind === "element") n.children.forEach(seed);
    };
    seed(page.root);
    rename(page.root, registry, stats);
  }
  return stats;
}
