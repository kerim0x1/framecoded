import { Command } from "commander";
import { join, resolve } from "node:path";
import pc from "picocolors";
import { setVerbose, log, type ProgressReporter } from "./util/log.js";
import { ingestPublishedSite } from "./adapters/published-site/index.js";
import { ingestRenderedSite } from "./adapters/rendered-site/index.js";
import { ingestFramerMcpFile } from "./adapters/framer-mcp/index.js";
import { generateProject } from "./codegen/project.js";
import type { IRSite } from "./ir/types.js";
import { dirSize } from "./util/fs.js";

const program = new Command();
let activeProgress: ProgressReporter | undefined;
let interrupting = false;

process.on("SIGINT", () => {
  if (interrupting) process.exit(130);
  interrupting = true;
  if (activeProgress) activeProgress.fail("Export cancelled by user");
  else log.warn("Export cancelled by user");
  process.exit(130);
});

program
  .name("framecoded")
  .description("Convert published Framer websites into clean Next.js, TanStack Start, or Astro projects.")
  .version("0.1.0")
  .showHelpAfterError()
  .showSuggestionAfterError();

program
  .command("export", { isDefault: true })
  .argument("<url>", "URL of a published Framer site")
  .description("Export a published Framer site to an editable framework project")
  .allowExcessArguments(false)
  .option("-o, --out <dir>", "output directory (default: exports/<site-name>)")
  .option("--framework <name>", "output framework: next, tanstack, or astro", "next")
  .option("--no-crawl", "export only the requested page")
  .option("--max-pages <n>", "max pages to crawl", (value) => parseInt(value, 10), 25)
  .option("--target-width <px>", "canonical desktop viewport width", (value) => parseInt(value, 10), 1200)
  .option("--no-download-assets", "keep images, fonts, and media on their remote CDNs")
  .option("--optimize", "re-encode downloaded images to WebP (needs sharp)", false)
  .option("--no-render", "parse static HTML instead of rendering in a browser")
  .option("--verbose", "verbose logging", false)
  .action(async (url: string, opts) => {
    setVerbose(opts.verbose);
    const framework = parseFramework(opts.framework);
    log.intro(`Framer to ${frameworkLabel(framework)}`, url);
    log.info(
      opts.crawl
        ? `Mode: full-site crawl, up to ${opts.maxPages} pages`
        : "Mode: single page (--no-crawl)",
    );
    const progress = log.progress(
      opts.render ? "Rendering responsive Framer pages" : "Fetching and parsing Framer pages",
      2,
      44,
    );
    activeProgress = progress;
    try {
      const site = opts.render
        ? await ingestRenderedSite(url, {
            crawl: opts.crawl,
            maxPages: opts.maxPages,
            onProgress: (message) => progress.stage(message, 2, 44),
          })
        : await ingestPublishedSite(url, {
            crawl: opts.crawl,
            maxPages: opts.maxPages,
            targetWidth: opts.targetWidth,
          });
      progress.update(44, `${site.name} captured`);
      await run(site, { ...opts, framework }, progress);
      activeProgress = undefined;
    } catch (err) {
      fail(err, progress);
    }
  });

program
  .command("from-mcp")
  .argument("<file>", "XML captured through Framer MCP")
  .description("Generate a project from Framer MCP project/node XML")
  .allowExcessArguments(false)
  .option("-o, --out <dir>", "output directory (default: exports/<site-name>)")
  .option("--framework <name>", "output framework: next, tanstack, or astro", "next")
  .option("--no-download-assets", "keep images, fonts, and media on their remote CDNs")
  .option("--optimize", "re-encode downloaded images to WebP (needs sharp)", false)
  .option("--verbose", "verbose logging", false)
  .action(async (file: string, opts) => {
    setVerbose(opts.verbose);
    const framework = parseFramework(opts.framework);
    const source = resolve(file);
    log.intro(`Framer MCP to ${frameworkLabel(framework)}`, source);
    const progress = log.progress("Reading Framer MCP capture", 2, 44);
    activeProgress = progress;
    try {
      const site = await ingestFramerMcpFile(source);
      progress.update(44, `${site.name} captured`);
      await run(site, { ...opts, framework }, progress);
      activeProgress = undefined;
    } catch (err) {
      fail(err, progress);
    }
  });

async function run(
  site: IRSite,
  opts: {
    out?: string;
    framework: "tanstack" | "next" | "astro";
    downloadAssets?: boolean;
    optimize?: boolean;
  },
  progress: ProgressReporter,
) {
  const out = opts.out ?? join("exports", siteFolderName(site));
  const outDir = resolve(out);
  progress.stage("Generating routes, components, styles and assets", 46, 94);
  const result = await generateProject(site, {
    outDir,
    framework: opts.framework,
    downloadAssets: !!opts.downloadAssets,
    optimizeImages: !!opts.optimize,
  });

  progress.stage("Calculating export statistics", 96, 99);
  const outputSize = `${(await dirSize(outDir) / 1024).toFixed(0)} KB`;
  progress.complete(`${site.name} exported`);

  const rows: Array<[string, string | number]> = [
    ["Site", site.name],
    ["Framework", opts.framework],
    ["Pages", result.pages],
    ["Components", result.components],
    ["Files", result.files],
    ["Favicons", result.faviconsDownloaded],
    ["Alt text", `${result.altGenerated} generated`],
    ["Responsive images", result.srcsetGenerated],
  ];
  if (result.imagesLocalized) rows.push(["Localized images", result.imagesLocalized]);
  rows.push(["Output size", outputSize], ["Output path", outDir]);
  log.summary("Export summary", rows);
  log.plain("");
  log.info(`Next: ${pc.cyan(`cd ${out} && npm install && npm run dev`)}`);
}

function parseFramework(value: unknown): "tanstack" | "next" | "astro" {
  const framework = String(value ?? "next").trim().toLowerCase();
  if (framework === "tanstack" || framework === "next" || framework === "astro") return framework;
  throw new Error(`Unknown framework ${JSON.stringify(value)}. Use tanstack, next, or astro.`);
}

function frameworkLabel(framework: "tanstack" | "next" | "astro"): string {
  if (framework === "next") return "Next.js";
  if (framework === "tanstack") return "TanStack Start";
  return "Astro";
}

function siteFolderName(site: IRSite): string {
  let candidate = site.name;
  const origin = site.baseUrl ?? site.source.origin;
  try {
    candidate = new URL(origin).hostname
      .replace(/^www\./i, "")
      .replace(/\.framer\.website$/i, "");
  } catch {
    candidate = candidate.replace(/\.framer\.website$/i, "");
  }
  return (
    candidate
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "site"
  );
}

function fail(err: unknown, progress?: ProgressReporter): never {
  const message = err instanceof Error ? err.message : String(err);
  if (progress) progress.fail(message);
  else log.error(message);
  if (process.env.FRAMECODED_DEBUG) console.error(err);
  process.exit(1);
}

program.parseAsync().catch(fail);
