import { join } from "node:path";
import { createHash } from "node:crypto";
import type { IRSite, IRNode } from "../ir/types.js";
import { fetchBinary } from "../adapters/published-site/fetch.js";
import { writeFileEnsured } from "../util/fs.js";
import { log } from "../util/log.js";

const EXT_FROM_CT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/gif": "gif",
  "image/avif": "avif",
  "font/woff": "woff",
  "font/woff2": "woff2",
  "application/font-woff": "woff",
  "application/font-woff2": "woff2",
  "application/vnd.ms-fontobject": "eot",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
};

function extFromUrl(url: string): string | undefined {
  let pathname = url.split(/[?#]/, 1)[0] ?? url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    /* keep the path-like input */
  }
  const m = /\.([a-z0-9]{2,8})$/i.exec(pathname);
  return m?.[1]?.toLowerCase();
}

/** Download favicons into <out>/public and rewrite to local paths. */
export async function downloadFavicons(site: IRSite, publicDir: string): Promise<number> {
  let n = 0;
  const usedNames = new Set<string>();
  for (const f of site.favicons) {
    try {
      const { data, contentType } = await fetchBinary(f.href);
      const ext = extFromUrl(f.href) ?? EXT_FROM_CT[contentType.split(";")[0]!.trim()] ?? "png";
      let baseName = "favicon";
      if (/apple-touch/.test(f.rel)) baseName = "apple-touch-icon";
      else if (/mask/.test(f.rel)) baseName = "mask-icon";
      else if (f.media?.includes("dark")) baseName = "favicon-dark";
      else if (f.media?.includes("light")) baseName = "favicon-light";
      let file = `${baseName}.${ext}`;
      let i = 2;
      while (usedNames.has(file)) file = `${baseName}-${i++}.${ext}`;
      usedNames.add(file);
      await writeFileEnsured(join(publicDir, file), data);
      f.localFile = file;
      n++;
    } catch (err) {
      log.warn(`could not download favicon ${f.href}: ${(err as Error).message}`);
    }
  }
  return n;
}

export interface ImageDownloadOptions {
  optimize: boolean;
}

/**
 * Make the visual export self-contained. Responsive images keep every srcset candidate,
 * while fonts, CSS images/masks, media sources and URL-bearing motion states are rewritten
 * to hashed files under <out>/public/assets. Raster optimization remains optional.
 */
export async function downloadImages(
  site: IRSite,
  publicDir: string,
  options: ImageDownloadOptions,
): Promise<number> {
  const sharp = options.optimize ? await loadSharp() : null;
  const context: AssetContext = {
    publicDir,
    sharp,
    pending: new Map(),
    downloaded: new Set(),
  };

  await Promise.all(site.pages.map((page) => localizeNode(page.root, context)));
  site.globalCss = await rewriteCssUrls(site.globalCss, context);

  return context.downloaded.size;
}

interface AssetContext {
  publicDir: string,
  sharp: SharpModule | null,
  pending: Map<string, Promise<string | null>>;
  downloaded: Set<string>;
}

async function localizeUrl(url: string, context: AssetContext): Promise<string | null> {
  const key = url.trim();
  if (!/^https?:\/\//i.test(key)) return null;
  const existing = context.pending.get(key);
  if (existing) return existing;

  const pending = (async () => {
    try {
      const { data, contentType } = await fetchBinary(key);
      const mime = contentType.split(";")[0]!.trim().toLowerCase();
      let ext = extFromUrl(key) ?? EXT_FROM_CT[mime] ?? "bin";
      let bytes: Uint8Array = data;
      if (context.sharp && /^(png|jpg|jpeg)$/i.test(ext)) {
        try {
          bytes = await context.sharp(data).webp({ quality: 82 }).toBuffer();
          ext = "webp";
        } catch {
          /* keep the exact downloaded bytes */
        }
      }

      const stem = assetStem(key);
      const digest = createHash("sha1").update(key).digest("hex").slice(0, 10);
      const file = `assets/${stem}-${digest}.${ext}`;
      await writeFileEnsured(join(context.publicDir, file), bytes);
      context.downloaded.add(file);
      return `/${file}`;
    } catch (err) {
      log.debug(`asset download failed ${key}: ${(err as Error).message}`);
      return null;
    }
  })();
  context.pending.set(key, pending);
  return pending;
}

function assetStem(url: string): string {
  let name = "asset";
  try {
    name = decodeURIComponent(new URL(url).pathname.split("/").pop() || name);
  } catch {
    name = url.split(/[/?#]/).filter(Boolean).pop() || name;
  }
  return (
    name
      .replace(/\.[a-z0-9]{2,8}$/i, "")
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "asset"
  );
}

async function rewriteSrcset(value: string, context: AssetContext): Promise<string> {
  const matches = [...value.matchAll(/https?:\/\/[^\s,]+/gi)];
  if (!matches.length) return value;
  let output = "", cursor = 0;
  for (const match of matches) {
    const index = match.index ?? 0;
    output += value.slice(cursor, index);
    const local = await localizeUrl(match[0], context);
    output += local ?? match[0];
    cursor = index + match[0].length;
  }
  return output + value.slice(cursor);
}

async function rewriteCssUrls(value: string, context: AssetContext): Promise<string> {
  const matches = [...value.matchAll(/url\(\s*(?:(["'])(.*?)\1|([^)]*))\s*\)/gi)];
  if (!matches.length) return value;
  let output = "", cursor = 0;
  for (const match of matches) {
    const remote = (match[2] ?? match[3] ?? "").trim();
    const local = await localizeUrl(remote, context);
    if (!local) continue;
    const index = match.index ?? 0;
    output += value.slice(cursor, index) + `url("${local}")`;
    cursor = index + match[0].length;
  }
  return cursor ? output + value.slice(cursor) : value;
}

async function rewriteDeclarations(
  declarations: Record<string, string>,
  context: AssetContext,
): Promise<void> {
  await Promise.all(
    Object.keys(declarations).map(async (property) => {
      declarations[property] = await rewriteCssUrls(declarations[property]!, context);
    }),
  );
}

async function rewriteUnknownUrls(value: unknown, context: AssetContext): Promise<unknown> {
  if (typeof value === "string") {
    const direct = await localizeUrl(value, context);
    return direct ?? rewriteCssUrls(value, context);
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => rewriteUnknownUrls(item, context)));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    await Promise.all(
      Object.entries(value as Record<string, unknown>).map(async ([key, item]) => {
        output[key] = await rewriteUnknownUrls(item, context);
      }),
    );
    return output;
  }
  return value;
}

async function localizeNode(node: IRNode, context: AssetContext): Promise<void> {
  await rewriteDeclarations(node.style.base, context);
  await Promise.all(Object.values(node.style.pseudo).map((state) => rewriteDeclarations(state, context)));
  await Promise.all(node.style.responsive.map((entry) => rewriteDeclarations(entry.style, context)));

  if (node.animations) {
    await Promise.all(
      node.animations.map(async (animation) => {
        animation.keyframes = await rewriteUnknownUrls(animation.keyframes, context);
      }),
    );
  }
  if (node.interaction) {
    const variants = [node.interaction, ...(node.interaction.responsive ?? [])];
    await Promise.all(
      variants.flatMap((variant) =>
        variant.targets.flatMap((target) => [
          rewriteDeclarations(target.closed, context),
          rewriteDeclarations(target.open, context),
        ]),
      ),
    );
  }

  if (node.kind === "image") {
    const local = await localizeUrl(node.src, context);
    if (local) node.src = local;
    if (node.srcset) node.srcset = await rewriteSrcset(node.srcset, context);
  }

  if (node.kind === "element") {
    const mediaSource = /^(audio|video|source|track|input)$/i.test(node.tag);
    if (mediaSource && node.attrs.src) {
      const local = await localizeUrl(node.attrs.src, context);
      if (local) node.attrs.src = local;
    }
    if (node.tag.toLowerCase() === "video" && node.attrs.poster) {
      const local = await localizeUrl(node.attrs.poster, context);
      if (local) node.attrs.poster = local;
    }
    if (node.tag.toLowerCase() === "source" && node.attrs.srcset) {
      node.attrs.srcset = await rewriteSrcset(node.attrs.srcset, context);
    }
    await Promise.all(node.children.map((child) => localizeNode(child, context)));
  }
}

type SharpModule = (input: Uint8Array) => {
  webp(opts: { quality: number }): { toBuffer(): Promise<Buffer> };
};

async function loadSharp(): Promise<SharpModule | null> {
  try {
    const mod = (await import("sharp")) as unknown as { default: SharpModule };
    return mod.default;
  } catch {
    log.warn("sharp not installed - images will be copied without re-encoding (run `npm i sharp`).");
    return null;
  }
}
