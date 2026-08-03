import type { IRSite, IRNode, IRImage, IRText } from "../ir/types.js";
import { toKebabCase } from "../util/names.js";
import { log } from "../util/log.js";

const GENERIC = new Set([
  "image", "img", "el", "div", "icon", "frame", "box", "container", "section",
  "wrapper", "group", "graphic", "media", "asset", "bg", "background", "cover",
]);

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

export interface AltResult {
  generated: number;
  total: number;
}

/**
 * Fill in alt text for any <img> missing it. Deterministic and offline:
 * derives a label from the Framer layer name (carried on className) and the
 * nearest heading/text context. Framer image filenames are opaque hashes, so
 * they are intentionally not used.
 */
export function generateAltText(site: IRSite): AltResult {
  let generated = 0;
  let total = 0;
  for (const page of site.pages) {
    walk(page.root, "", (img, heading) => {
      total++;
      if (img.alt && img.alt.trim()) return;
      const alt = deriveAlt(img, heading, site.name);
      img.alt = alt;
      img.altGenerated = true;
      generated++;
    });
  }
  return { generated, total };
}

function deriveAlt(img: IRImage, nearestHeading: string, siteName: string): string {
  const fromName = humanizeClass(img.className);
  if (fromName) {
    // Combine a meaningful layer name with section context when both exist.
    if (nearestHeading && !sameish(fromName, nearestHeading)) {
      return clamp(`${fromName} — ${nearestHeading}`);
    }
    return clamp(fromName);
  }
  if (nearestHeading) return clamp(nearestHeading);
  return clamp(`${siteName} image`);
}

function humanizeClass(className?: string): string | null {
  if (!className) return null;
  const words = toKebabCase(className).replace(/-\d+$/, "").split("-").filter(Boolean);
  if (!words.length) return null;
  if (words.every((w) => GENERIC.has(w) || /^\d+$/.test(w))) return null;
  const text = words.filter((w) => !/^\d+$/.test(w)).join(" ").trim();
  if (!text) return null;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function walk(node: IRNode, heading: string, fn: (img: IRImage, heading: string) => void): void {
  let current = heading;
  if (node.kind === "text" && HEADING_TAGS.has(node.tag) && node.text.trim()) {
    current = node.text.trim();
  }
  if (node.kind === "image") fn(node, current);
  if (node.kind === "element") {
    // The nearest heading propagates to following siblings within the same parent.
    let localHeading = current;
    for (const child of node.children) {
      if (child.kind === "text" && HEADING_TAGS.has(child.tag) && child.text.trim()) {
        localHeading = child.text.trim();
      }
      walk(child, localHeading, fn);
    }
  }
}

function sameish(a: string, b: string): boolean {
  return a.toLowerCase().trim() === b.toLowerCase().trim();
}

function clamp(s: string, max = 125): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}
