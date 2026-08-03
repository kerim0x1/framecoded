import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { IRSite } from "../ir/types.js";
import { writeFileEnsured, ensureDir } from "../util/fs.js";
import { log } from "../util/log.js";
import { formatTsx, formatCss, formatJson } from "./format.js";
import { downloadFavicons, downloadImages } from "./assets.js";
import { buildProjectFiles, enrichSite, type GeneratedFile } from "./build.js";
import { adaptFrameworkFiles, type FrameworkTarget } from "./framework.js";

export interface GenerateOptions {
  outDir: string;
  downloadAssets: boolean;
  optimizeImages: boolean;
  framework?: FrameworkTarget;
}

export interface GenerateResult {
  files: number;
  components: number;
  pages: number;
  faviconsDownloaded: number;
  imagesLocalized: number;
  altGenerated: number;
  srcsetGenerated: number;
}

export async function generateProject(site: IRSite, options: GenerateOptions): Promise<GenerateResult> {
  const { outDir } = options;
  const publicDir = join(outDir, "public");

  // Exports are reproducible snapshots. Keeping an older generated tree here leaves
  // stale routes, assets, and component folders behind when the new export contains
  // fewer pages or uses a stricter component planner. Only Framecoded-owned trees are
  // reset; repository metadata and unrelated top-level files remain untouched.
  await Promise.all(
    [join(outDir, "src"), publicDir].map((dir) => rm(dir, { recursive: true, force: true })),
  );

  // 1. Enrich the IR (perf + a11y) — before any asset download, since downloads mutate the IR.
  const enrich = enrichSite(site);
  log.success(
    `Layout: ${enrich.containers} containing block(s) added, ${enrich.unpinned} over-constrained box(es) freed` +
      (enrich.renamedClasses ? `, ${enrich.renamedClasses} invalid class name(s) fixed` : ""),
  );
  log.success(`Images: ${enrich.srcset} got responsive srcset, ${enrich.priority} marked LCP-priority`);
  log.success(`Alt text: generated for ${enrich.altGenerated}/${enrich.altTotal} image(s)`);

  // 2. Assets (favicons always; images on request) — mutate the IR before building files.
  const faviconsDownloaded = await downloadFavicons(site, publicDir);
  let imagesLocalized = 0;
  if (options.downloadAssets) {
    log.step("Downloading images into /public/assets...");
    imagesLocalized = await downloadImages(site, publicDir, { optimize: options.optimizeImages });
    log.success(`Localized ${imagesLocalized} image(s)`);
  }

  // 3. Build the project files (pure), then format + write.
  const built = buildProjectFiles(site);
  const files = adaptFrameworkFiles(site, built.files, options.framework ?? "next");
  const components = built.components;
  await ensureDir(outDir);
  for (const f of files) {
    const content = await formatByKind(f);
    await writeFileEnsured(join(outDir, f.path), content);
  }

  return {
    files: files.length,
    components,
    pages: site.pages.length,
    faviconsDownloaded,
    imagesLocalized,
    altGenerated: enrich.altGenerated,
    srcsetGenerated: enrich.srcset,
  };
}

async function formatByKind(f: GeneratedFile): Promise<string> {
  try {
    if (f.kind === "tsx") return await formatTsx(f.content);
    if (f.kind === "css") return await formatCss(f.content);
    if (f.kind === "json") return await formatJson(f.content);
  } catch {
    /* fall through to raw */
  }
  return f.content.endsWith("\n") ? f.content : f.content + "\n";
}
