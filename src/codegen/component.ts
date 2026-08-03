import type { IRNode, IRPage } from "../ir/types.js";
import { hasAnyStyle, generateModuleCss } from "./css.js";
import { renderNode, type JsxContext } from "./jsx.js";
import { toPascalCase } from "../util/names.js";
import { findRepeats, nodeAtPath, type RepeatSlot } from "./repeats.js";

export interface ComponentDef {
  name: string;
  root: IRNode;
  /** Set when this component stands in for a group of repeated siblings. */
  slots?: RepeatSlot[];
}

export interface ComponentPlan {
  pageComponentName: string;
  components: ComponentDef[];
  boundaries: Map<string, string>;
  /** Instance node id → the props that instance passes to its shared component. */
  instanceProps: Map<string, Record<string, string>>;
}

export interface SplitOptions {
  /** Min subtree node count for a child to become its own component. */
  threshold: number;
  /** Smaller named Framer groups still deserve a reusable, discoverable file. */
  namedThreshold: number;
  /** Hard cap on number of components per page. */
  maxComponents: number;
}

const DEFAULT_SPLIT: SplitOptions = { threshold: 24, namedThreshold: 12, maxComponents: 48 };

export function subtreeSize(node: IRNode): number {
  let n = 1;
  if (node.kind === "element") for (const c of node.children) n += subtreeSize(c);
  return n;
}

function subtreeHasAnimations(node: IRNode): boolean {
  if (node.animations?.length) return true;
  return node.kind === "element" && node.children.some(subtreeHasAnimations);
}

const GENERIC_COMPONENT_NAME =
  /^(?:div|el|span|frame|container|variant|wrapper|content|group|stack|box|row|col|column|inner|outer|holder|block|elem|node|desktop|tablet|mobile|phone|breakpoint|desktopvariant|tabletvariant|mobilevariant|phonevariant)\d*$/i;

const SEMANTIC_REGION_TAGS = new Set(["section", "header", "nav", "footer", "aside"]);

/** A useful Framer/semantic layer name, rather than generated DOM scaffolding. */
function isNamedBoundary(node: IRNode): boolean {
  const name = node.className?.trim();
  return Boolean(name && name.length > 2 && !GENERIC_COMPONENT_NAME.test(name));
}

function shouldExtract(node: IRNode, opts: SplitOptions): boolean {
  if (node.kind !== "element") return false;
  const size = subtreeSize(node);
  return size >= opts.threshold || (isNamedBoundary(node) && size >= opts.namedThreshold);
}

/**
 * CSS Modules require one class name to represent one declaration set inside a file.
 * Beautified Framer names are human-readable but not guaranteed unique: a section and
 * a nested variant wrapper can both become `services2`, causing the wrapper to inherit
 * the section's padding, gap, and responsive rules. Uniquify once at page scope before
 * component boundaries are planned; repeated-component matching intentionally ignores
 * class names and therefore remains unaffected.
 */
function ensureUniqueClassNames(root: IRNode): void {
  const used = new Set<string>();
  const nextSuffix = new Map<string, number>();

  const walk = (node: IRNode) => {
    if (node.className) {
      const base = node.className;
      let candidate = base;
      if (used.has(candidate)) {
        let suffix = nextSuffix.get(base) ?? 2;
        do candidate = `${base}${suffix++}`;
        while (used.has(candidate));
        nextSuffix.set(base, suffix);
        node.className = candidate;
      }
      used.add(candidate);
    }
    if (node.kind === "element") node.children.forEach(walk);
  };

  walk(root);
}

/**
 * A node that exists only to wrap the thing below it.
 *
 * Framer nests layout frames several deep, so extracting purely by subtree size yields
 * files whose whole body is `<div><Section7 /></div>`. That's a file to open, name and
 * navigate for no information. The wrapper still renders — it just stays inline in its
 * parent, so the DOM is unchanged and only the real content becomes a component.
 */
function isPassThrough(node: IRNode, opts: SplitOptions): boolean {
  if (node.kind !== "element") return false;
  // A named boundary is useful even when Framer placed one layout wrapper below it.
  if (isNamedBoundary(node)) return false;
  const children = node.children;
  if (children.length !== 1) return false;
  const only = children[0]!;
  // Only skip when the child is substantial enough to be extracted in its own right;
  // otherwise nothing downstream would become a component and the section is lost.
  return shouldExtract(only, opts);
}

export function planComponents(page: IRPage, options: Partial<SplitOptions> = {}): ComponentPlan {
  ensureUniqueClassNames(page.root);
  const opts = { ...DEFAULT_SPLIT, ...options };
  const boundaries = new Map<string, string>();
  const instanceProps = new Map<string, Record<string, string>>();
  const components: ComponentDef[] = [];
  const used = new Set<string>(["Image", "Link", "Page"]);

  const nameFor = (node: IRNode, fallbackIndex: number): string => {
    let base = node.className ? toPascalCase(node.className) : "";
    if (!base || base.length < 2) base = `Section${fallbackIndex}`;
    base = base.replace(/^\d+/, "");
    if (!base) base = `Section${fallbackIndex}`;
    let name = base;
    let i = 2;
    while (used.has(name)) name = `${base}${i++}`;
    used.add(name);
    return name;
  };

  const pageComponentName = nameFor({ ...page.root, className: page.name } as IRNode, 1);
  const rootDef: ComponentDef = { name: pageComponentName, root: page.root };
  components.push(rootDef);

  // Repeated siblings become one shared component before anything else is extracted, so
  // the size-based split can't carve twelve near-identical cards into twelve files.
  for (const group of findRepeats(page.root)) {
    // Separate animated instances can carry staggered delays or different triggers.
    // Folding them into one template would collapse their unique motion ids.
    if (group.instances.some((instance) => subtreeHasAnimations(instance.node))) continue;
    let name = group.name;
    let i = 2;
    while (used.has(name)) name = `${group.name}${i++}`;
    used.add(name);

    components.push({ name, root: group.template, slots: group.slots });
    for (const instance of group.instances) {
      boundaries.set(instance.node.id, name);
      instanceProps.set(instance.node.id, instance.values);
    }
  }

  // Split only at real page regions. Recursively splitting every named Framer layer
  // creates wrapper chains such as Section -> Content -> Content2 -> Title and can
  // easily produce hundreds of files without making the output more maintainable.
  // A sole root child is the page shell rather than a useful component boundary.
  const pageShellId =
    page.root.kind === "element" && page.root.children.length === 1
      ? page.root.children[0]?.id
      : undefined;
  let idx = 0;
  extractChildren(page.root);

  function extractChildren(node: IRNode) {
    if (node.kind !== "element") return;
    for (const child of node.children) {
      if (components.length >= opts.maxComponents) return;
      if (boundaries.has(child.id)) continue;
      const semanticRegion =
        child.kind === "element" && SEMANTIC_REGION_TAGS.has(child.tag.toLowerCase());
      if (
        semanticRegion &&
        child.id !== pageShellId &&
        shouldExtract(child, opts) &&
        !isPassThrough(child, opts)
      ) {
        const name = nameFor(child, ++idx);
        boundaries.set(child.id, name);
        components.push({ name, root: child });
      } else {
        // Keep layout scaffolding inline while searching for the next real region.
        extractChildren(child);
      }
    }
  }

  return { pageComponentName, components, boundaries, instanceProps };
}

export interface GeneratedComponent {
  name: string;
  tsx: string;
  css: string;
  hasCss: boolean;
}

export function generateComponent(
  def: ComponentDef,
  boundaries: Map<string, string>,
  instanceProps: Map<string, Record<string, string>> = new Map(),
): GeneratedComponent {
  const styledNodes = collectStyledBounded(def.root, boundaries, def.root.id);
  const css = generateModuleCss(styledNodes);
  const hasCss = styledNodes.length > 0;

  // Resolve each slot's path to the node that will render it as a prop instead of a
  // literal. Paths are used rather than ids so the same template works for every
  // instance, which have their own node ids.
  const slots = new Map<string, RepeatSlot>();
  for (const slot of def.slots ?? []) {
    const node = nodeAtPath(def.root, slot.path);
    if (node) slots.set(node.id, slot);
  }

  const ctx: JsxContext = {
    stylesIdent: "styles",
    boundaries,
    rootId: def.root.id,
    uses: { link: false, image: false },
    childComponents: new Set(),
    instanceProps,
    slots,
  };
  const jsx = renderNode(def.root, ctx);

  const imports: string[] = [];
  if (hasCss) imports.push(`import styles from "./${def.name}.module.css";`);
  if (ctx.uses.image) imports.push(`import { Image } from "../../../ui/Image";`);
  if (ctx.uses.link) imports.push(`import { Link } from "@tanstack/react-router";`);
  for (const child of [...ctx.childComponents].sort()) {
    imports.push(`import { ${child} } from "../${child}";`);
  }

  const propNames = (def.slots ?? []).map((s) => s.name);
  const propsType = propNames.length
    ? `\nexport interface ${def.name}Props {\n${(def.slots ?? [])
        .map((s) => `  /** ${s.kind === "svg" ? "Inline SVG markup" : s.kind === "image" ? "Image URL" : "Text"} */\n  ${s.name}: string;`)
        .join("\n")}\n}\n`
    : "";
  const signature = propNames.length ? `props: ${def.name}Props` : "";

  const tsx = `${imports.join("\n")}
${propsType}
export function ${def.name}(${signature}) {
  return (
    ${jsx}
  );
}
`;
  return { name: def.name, tsx, css, hasCss };
}

function collectStyledBounded(root: IRNode, boundaries: Map<string, string>, rootId: string): IRNode[] {
  const out: IRNode[] = [];
  const walk = (n: IRNode) => {
    if (n.id !== rootId && boundaries.has(n.id)) return; // belongs to a child component
    if (n.className && hasAnyStyle(n.style)) out.push(n);
    if (n.kind === "element") n.children.forEach(walk);
  };
  walk(root);
  return out;
}
