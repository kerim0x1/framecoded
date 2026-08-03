/** Naming helpers: route paths, component names, CSS class identifiers. */

const RESERVED = new Set([
  "do","if","in","for","let","new","try","var","case","else","enum","null","this",
  "true","void","with","class","const","false","super","throw","while","yield",
  "import","export","default","function","return",
]);

export function toPascalCase(input: string): string {
  const words = input
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let out = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  if (!out) out = "Page";
  if (/^\d/.test(out)) out = "P" + out;
  return out;
}

export function toCamelCase(input: string): string {
  const p = toPascalCase(input);
  let out = p.charAt(0).toLowerCase() + p.slice(1);
  if (RESERVED.has(out)) out = out + "_";
  if (/^\d/.test(out)) out = "_" + out;
  return out || "el";
}

export function toKebabCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

/**
 * Derive a clean route path + a PascalCase page name from a URL pathname.
 *  "/"            -> { path: "/", name: "Home" }
 *  "/about"       -> { path: "/about", name: "About" }
 *  "/blog/post-1" -> { path: "/blog/post-1", name: "BlogPost1" }
 */
export function routeFromPathname(pathname: string): { path: string; name: string } {
  let p = pathname.replace(/\/+$/, "");
  if (p === "" || p === "/") return { path: "/", name: "Home" };
  if (!p.startsWith("/")) p = "/" + p;
  const segs = p.split("/").filter(Boolean);
  const name = toPascalCase(segs.join(" ")) || "Page";
  return { path: p, name };
}

/** A small, stable, deduplicating counter for generating unique class names. */
export class NameRegistry {
  private counts = new Map<string, number>();
  private used = new Set<string>();

  unique(base: string): string {
    let candidate = base && /[a-zA-Z]/.test(base) ? base : "el";
    candidate = toCamelCase(candidate);
    if (!this.used.has(candidate)) {
      this.used.add(candidate);
      return candidate;
    }
    const n = (this.counts.get(candidate) ?? 1) + 1;
    this.counts.set(candidate, n);
    const next = `${candidate}${n}`;
    this.used.add(next);
    return next;
  }
}
