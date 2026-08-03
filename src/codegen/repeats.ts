/**
 * Repeated structures → one component with props.
 *
 * A testimonial grid arrives as twelve sibling subtrees with the same shape and
 * different content. Emitted verbatim that becomes `Card` … `Card12`: twelve files and
 * twelve stylesheets that differ only in a few strings. Nobody would write it that way,
 * and changing the card means changing twelve files.
 *
 * The shape is compared by *structure* — element tags and the kind of each leaf — while
 * the leaves' values are ignored. Leaves whose value differs between instances become
 * props; leaves that are identical everywhere stay baked into the template.
 */
import type { IRNode } from "../ir/types.js";
import { toCamelCase } from "../util/names.js";

export type SlotKind = "text" | "image" | "svg";

export interface RepeatSlot {
  /** Child-index path from the template root to the leaf. */
  path: number[];
  kind: SlotKind;
  /** Prop name on the generated component. */
  name: string;
}

export interface RepeatInstance {
  node: IRNode;
  /** Prop name → value, in the same order as `slots`. */
  values: Record<string, string>;
}

export interface RepeatGroup {
  /** The instance whose markup and styling the component is built from. */
  template: IRNode;
  instances: RepeatInstance[];
  slots: RepeatSlot[];
  /** Suggested component name, derived from the template. */
  name: string;
}

/**
 * What a subtree *is*, ignoring what it says.
 *
 * Leaves collapse to their kind so two cards match even though one holds a two-path
 * icon and the other a clipped group — the icon is a slot, not a difference in shape.
 */
function stableValue(value: unknown): string {
  if (value === undefined) return "u";
  if (value === null) return "n";
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Everything that affects how this node renders, excluding identity, children, and the
 * leaf value that can safely become a component prop. Structure-only matching used to
 * merge cards with different alignment, responsive styles, hrefs, or image metadata and
 * then render every instance with the first card's CSS.
 */
function renderInvariant(node: IRNode): string {
  const record = node as unknown as Record<string, unknown>;
  const ignored = new Set(["id", "className", "kind", "tag", "children", "text", "src", "svg"]);
  return Object.keys(record)
    .filter((key) => !ignored.has(key))
    .sort()
    .map((key) => `${key}:${stableValue(record[key])}`)
    .join(";");
}

function signature(node: IRNode, depth = 0): string {
  if (depth > 12) return "…";
  const invariant = renderInvariant(node);
  switch (node.kind) {
    case "text":
      return `t{${invariant}}`;
    case "image":
      return `i{${invariant}}`;
    case "svg":
      return `s{${invariant}}`;
    default:
      return `${node.tag}{${invariant}}(${node.children.map((c) => signature(c, depth + 1)).join(",")})`;
  }
}

interface Leaf {
  path: number[];
  node: IRNode;
}

function leaves(node: IRNode, path: number[] = [], out: Leaf[] = []): Leaf[] {
  if (node.kind === "element") {
    node.children.forEach((child, i) => leaves(child, [...path, i], out));
  } else {
    out.push({ path, node });
  }
  return out;
}

function leafValue(node: IRNode): string {
  switch (node.kind) {
    case "text":
      return node.text;
    case "image":
      return node.src;
    case "svg":
      return node.svg;
    default:
      return "";
  }
}

function leafKind(node: IRNode): SlotKind | null {
  if (node.kind === "text") return "text";
  if (node.kind === "image") return "image";
  if (node.kind === "svg") return "svg";
  return null;
}

/** A readable prop name, preferring the layer's own name over a positional one. */
function slotName(node: IRNode, kind: SlotKind, index: number, used: Set<string>): string {
  const fromClass = node.className ? toCamelCase(node.className.replace(/\d+$/, "")) : "";
  const fallback = kind === "image" ? "image" : kind === "svg" ? "icon" : "text";
  let base = fromClass && fromClass.length > 1 ? fromClass : `${fallback}${index + 1}`;
  base = base.replace(/[^A-Za-z0-9]/g, "") || `${fallback}${index + 1}`;
  if (/^\d/.test(base)) base = fallback + base;
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}${n++}`;
  used.add(name);
  return name;
}

function componentName(node: IRNode): string {
  const raw = node.className ?? "";
  const cleaned = raw.replace(/\d+$/, "");
  const pascal = cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : "";
  return /^[A-Za-z][A-Za-z0-9]*$/.test(pascal) && pascal.length > 1 ? pascal : "Item";
}

export interface RepeatOptions {
  /** Fewest siblings that justify extracting a shared component. */
  minInstances: number;
  /** Smallest subtree worth sharing — tiny repeats are noise, not structure. */
  minSize: number;
}

const DEFAULTS: RepeatOptions = { minInstances: 3, minSize: 6 };

function subtreeSize(node: IRNode): number {
  let n = 1;
  if (node.kind === "element") for (const c of node.children) n += subtreeSize(c);
  return n;
}

/**
 * Find sibling groups worth turning into one component.
 *
 * Only siblings are considered: two cards in different sections may look alike but
 * belong to different parts of the page, and merging them would couple things the
 * designer kept apart.
 */
export function findRepeats(root: IRNode, options: Partial<RepeatOptions> = {}): RepeatGroup[] {
  const opts = { ...DEFAULTS, ...options };
  const groups: RepeatGroup[] = [];
  const claimed = new Set<string>();

  const visit = (node: IRNode) => {
    if (node.kind !== "element") return;

    const bySignature = new Map<string, IRNode[]>();
    for (const child of node.children) {
      if (child.kind !== "element") continue;
      if (subtreeSize(child) < opts.minSize) continue;
      const sig = signature(child);
      const bucket = bySignature.get(sig);
      if (bucket) bucket.push(child);
      else bySignature.set(sig, [child]);
    }

    for (const siblings of bySignature.values()) {
      if (siblings.length < opts.minInstances) continue;
      if (siblings.some((s) => claimed.has(s.id))) continue;

      const group = buildGroup(siblings);
      if (!group) continue;
      groups.push(group);
      for (const s of siblings) claimed.add(s.id);
    }

    for (const child of node.children) visit(child);
  };

  visit(root);
  return groups;
}

function buildGroup(siblings: IRNode[]): RepeatGroup | null {
  const template = siblings[0]!;
  const perInstance = siblings.map((s) => leaves(s));
  const count = perInstance[0]!.length;
  if (perInstance.some((l) => l.length !== count)) return null;

  const used = new Set<string>();
  const slots: RepeatSlot[] = [];

  for (let i = 0; i < count; i++) {
    const kind = leafKind(perInstance[0]![i]!.node);
    if (!kind) continue;
    const values = perInstance.map((l) => leafValue(l[i]!.node));
    // Identical everywhere → part of the template, not a prop.
    if (values.every((v) => v === values[0])) continue;
    slots.push({
      path: perInstance[0]![i]!.path,
      kind,
      name: slotName(perInstance[0]![i]!.node, kind, slots.length, used),
    });
  }

  // Nothing varies: the siblings are genuinely identical, so a plain component with no
  // props already covers them — still worth sharing.
  const instances: RepeatInstance[] = siblings.map((node, si) => {
    const values: Record<string, string> = {};
    for (const slot of slots) {
      const leaf = perInstance[si]!.find((l) => samePath(l.path, slot.path));
      values[slot.name] = leaf ? leafValue(leaf.node) : "";
    }
    return { node, values };
  });

  return { template, instances, slots, name: componentName(template) };
}

function samePath(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Look up the node sitting at `path` inside `root`, if any. */
export function nodeAtPath(root: IRNode, path: number[]): IRNode | undefined {
  let cur: IRNode | undefined = root;
  for (const i of path) {
    if (!cur || cur.kind !== "element") return undefined;
    cur = cur.children[i];
  }
  return cur;
}
