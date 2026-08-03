import type { IRSite, IRPage, IRNode, IRImage } from "../ir/types.js";

const FRAMER_CDN = "framerusercontent.com";
const DEFAULT_WIDTHS = [480, 768, 1080, 1440, 1920];

export interface ImageEnrichResult {
  withSrcset: number;
  priority: number;
}

/**
 * Generate responsive srcset/sizes for Framer-hosted images using the CDN's
 * on-the-fly resize params (`?width=` / `?scale-down-to=`), mark the first
 * image of each page as the LCP (priority) image, and add intrinsic dimensions.
 */
export function enrichImages(site: IRSite): ImageEnrichResult {
  let withSrcset = 0;
  let priority = 0;
  for (const page of site.pages) {
    let first = true;
    forEachImage(page.root, (img) => {
      if (first) {
        img.priority = true;
        priority++;
        first = false;
      }
      if (!img.srcset && isFramerCdn(img.src)) {
        const built = buildSrcset(img);
        if (built) {
          img.srcset = built.srcset;
          if (!img.sizes) img.sizes = built.sizes;
          withSrcset++;
        }
      }
    });
  }
  return { withSrcset, priority };
}

function isFramerCdn(url: string): boolean {
  return url.includes(FRAMER_CDN);
}

function buildSrcset(img: IRImage): { srcset: string; sizes: string } | null {
  const natural = img.width && img.width > 0 ? img.width : undefined;
  let widths = natural
    ? [Math.round(natural / 2), natural, natural * 2].filter((w) => w >= 64)
    : DEFAULT_WIDTHS;
  // Cap to a sane max and dedupe.
  widths = [...new Set(widths.map((w) => Math.min(w, 2400)))].sort((a, b) => a - b);
  if (!widths.length) return null;

  const srcset = widths.map((w) => `${withWidth(img.src, w)} ${w}w`).join(", ");
  const sizes = natural ? `(max-width: ${natural}px) 100vw, ${natural}px` : "100vw";
  return { srcset, sizes };
}

function withWidth(url: string, width: number): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("scale-down-to");
    u.searchParams.set("width", String(width));
    // Keep aspect ratio: drop fixed height so the CDN scales proportionally to width.
    u.searchParams.delete("height");
    return u.toString();
  } catch {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}width=${width}`;
  }
}

function forEachImage(node: IRNode, fn: (img: IRImage) => void): void {
  if (node.kind === "image") fn(node);
  if (node.kind === "element") for (const c of node.children) forEachImage(c, fn);
}

export function collectAllImages(page: IRPage): IRImage[] {
  const out: IRImage[] = [];
  forEachImage(page.root, (img) => out.push(img));
  return out;
}
