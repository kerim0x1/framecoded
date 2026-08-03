/**
 * Pure, platform-agnostic project builder.
 *
 * Turns an `IRSite` into an in-memory list of files (no filesystem, no network, no
 * formatting). Keeping it pure separates capture from deterministic file generation.
 */
import type { IRSite, IRPage, IRNode, IRAnimation, IRInteraction } from "../ir/types.js";
import { normalizeLayout } from "../ir/layout.js";
import { sanitizeClassNames } from "../ir/classnames.js";
import { beautifyNames } from "../ir/beautify.js";
import { materializeFramerVars } from "../ir/framer-vars.js";
import { consolidateAnimatedTextStyles } from "../ir/animated-text.js";
import { planComponents, generateComponent } from "./component.js";
import { jsxRouteComponentName } from "./jsx.js";
import {
  pageHeadLiteral,
  rootHeadLiteral,
  jsonLdScriptsJsx,
  siteConfigTs,
  seoGeneratorScript,
} from "./seo.js";
import * as T from "./templates.js";
import { enrichImages } from "../enrich/images.js";
import { generateAltText } from "../enrich/alt-text.js";
import { renderReadme } from "./readme.js";

export interface GeneratedFile {
  path: string;
  content: string;
  kind: "tsx" | "css" | "json" | "raw";
}

export interface EnrichStats {
  srcset: number;
  priority: number;
  altGenerated: number;
  altTotal: number;
  containers: number;
  unpinned: number;
  renamedClasses: number;
  beautified: number;
  materializedVars: number;
  animatedGlyphs: number;
}

/** Layout + perf + a11y passes that mutate the IR. Run once, before any asset download. */
export function enrichSite(site: IRSite): EnrichStats {
  // Framer's typography lives in custom properties that nothing reads once its own
  // class-scoped stylesheet is gone. Turn them into real declarations first.
  const vars = materializeFramerVars(site);
  // Naming next: it rewrites class names, and everything downstream reads them.
  const beauty = beautifyNames(site);
  const animatedText = consolidateAnimatedTextStyles(site);
  const renamedClasses = sanitizeClassNames(site);
  const layout = normalizeLayout(site);
  const img = enrichImages(site);
  const alt = generateAltText(site);
  return {
    srcset: img.withSrcset,
    priority: img.priority,
    altGenerated: alt.generated,
    altTotal: alt.total,
    containers: layout.containers,
    unpinned: layout.unpinned,
    renamedClasses,
    beautified: beauty.renamed,
    materializedVars: vars.materialized,
    animatedGlyphs: animatedText.consolidated,
  };
}

export interface BuildResult {
  files: GeneratedFile[];
  components: number;
}

/** Build all project files from the (already-enriched) IR. Pure. */
export function buildProjectFiles(site: IRSite): BuildResult {
  const files: GeneratedFile[] = [];

  // Static project files.
  files.push({ path: "package.json", content: T.packageJson(site.name), kind: "json" });
  files.push({ path: "vite.config.ts", content: T.VITE_CONFIG, kind: "tsx" });
  files.push({ path: "tsconfig.json", content: T.TSCONFIG, kind: "json" });
  files.push({ path: ".gitignore", content: T.GITIGNORE, kind: "raw" });
  files.push({ path: ".env", content: T.ENV_FILE, kind: "raw" });
  files.push({ path: "scripts/generate-seo.mjs", content: seoGeneratorScript(site), kind: "raw" });
  files.push({ path: "src/router.tsx", content: T.ROUTER, kind: "tsx" });
  files.push({ path: "src/config/site.ts", content: siteConfigTs(site), kind: "tsx" });
  files.push({ path: "src/ui/Image.tsx", content: T.IMAGE_COMPONENT, kind: "tsx" });
  files.push({ path: "src/ui/MotionRuntime.tsx", content: T.MOTION_COMPONENT, kind: "tsx" });

  // Styles.
  files.push({ path: "src/styles/global.css", content: globalCss(site), kind: "css" });
  files.push({ path: "src/styles/theme.css", content: themeCss(site), kind: "css" });

  // Root route.
  files.push({ path: "src/routes/__root.tsx", content: rootRoute(site), kind: "tsx" });

  // Pages → routes + components.
  let components = 0;
  for (const page of site.pages) {
    const plan = planComponents(page);
    components += plan.components.length;
    const pageDir = `src/components/${page.name}`;
    for (const def of plan.components) {
      const gen = generateComponent(def, plan.boundaries, plan.instanceProps);
      const componentDir = `${pageDir}/${gen.name}`;
      files.push({ path: `${componentDir}/${gen.name}.tsx`, content: gen.tsx, kind: "tsx" });
      if (gen.hasCss) {
        files.push({ path: `${componentDir}/${gen.name}.module.css`, content: gen.css, kind: "css" });
      }
      files.push({
        path: `${componentDir}/index.ts`,
        content: `export { ${gen.name} } from "./${gen.name}";\n`,
        kind: "tsx",
      });
    }
    files.push({
      path: `${pageDir}/index.ts`,
      content: plan.components.map((component) => `export { ${component.name} } from "./${component.name}";`).join("\n") + "\n",
      kind: "tsx",
    });
    const route = routeFile(page, site, plan.pageComponentName);
    files.push(route.file);
    if (route.motionFile) files.push(route.motionFile);
  }

  // SEO statics are created from VITE_SITE_URL by scripts/generate-seo.mjs.
  files.push({ path: "README.md", content: renderReadme(site), kind: "raw" });

  return { files, components };
}

function globalCss(site: IRSite): string {
  // In a design export every gap comes from the design's own padding/gap. Any margin a
  // browser adds by default (a <p> carries 1em top and bottom) is spacing nobody drew,
  // so it has to go or the rhythm drifts everywhere text appears.
  const reset = `/* Base reset (framecoded) */
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
h1, h2, h3, h4, h5, h6, p, figure, blockquote, dl, dd, pre { margin: 0; }
ul, ol { margin: 0; padding: 0; }
img, svg, video { display: block; }
[data-framecoded-svg] > svg {
  display: block;
  width: 100%;
  height: 100%;
}
a { color: inherit; text-decoration: none; }
button, input, select, textarea { font: inherit; color: inherit; }
@media (pointer: coarse) {
  [data-framecoded-cursor] { display: none !important; }
}
/* Framer highlights the link for the page you are on, but scopes that rule to its own
   generated class names — which a clean rebuild replaces. Restated here so the active
   nav item keeps its colour. */
a[data-framer-page-link-current] {
  color: var(--framer-link-current-text-color, var(--framer-link-text-color, inherit));
}
${bodyBase(site)}
${hoistedLinkVars(site)}
/* --- Imported global styles from Framer (resets, fonts, keyframes) --- */
`;
  return reset + (site.globalCss || "") + "\n";
}

/**
 * Link colours, lifted to `:root`.
 *
 * Framer declares these inside a rule scoped to its own generated class names. Those
 * class names don't survive a clean rebuild, so the declaration is still in the
 * stylesheet but no longer reaches anything — the active nav link falls back to the
 * body colour. Re-declaring them at the root keeps them inheritable.
 */
function hoistedLinkVars(site: IRSite): string {
  const css = site.globalCss || "";
  const wanted = ["--framer-link-current-text-color", "--framer-link-text-color"];
  const decls: string[] = [];
  for (const name of wanted) {
    const m = new RegExp(`${name}\\s*:\\s*([^;"}]+)`).exec(css);
    if (m?.[1]) decls.push(`  ${name}: ${m[1].trim()};`);
  }
  return decls.length ? `:root {\n${decls.join("\n")}\n}` : "";
}

/** Page base colors from the project's color styles, so the page has the right
 * background and text color even where individual nodes don't set their own. */
function bodyBase(site: IRSite): string {
  const find = (re: RegExp) => site.colorStyles.find((c) => re.test(c.name.toLowerCase()));
  const bg = find(/\b(background|^bg$|surface|base|page)\b/) ?? find(/background|bg/);
  const text = find(/\b(text|foreground|ink|body|content|primary)\b/) ?? find(/text/);
  const decls: string[] = [];
  if (bg) decls.push(`  background-color: var(${bg.varName});`);
  if (text) decls.push(`  color: var(${text.varName});`);
  // Without an inheritable family, any text layer whose font the canvas didn't expose
  // renders in the browser's default serif — conspicuously wrong in a sans-serif design.
  const family = site.fonts[0]?.family;
  if (family) {
    const mono = /\bmono\b|code|courier|consol/i.test(family);
    decls.push(`  font-family: "${family}", ${mono ? "ui-monospace, monospace" : "system-ui, sans-serif"};`);
  }
  if (!decls.length) return "";
  return `body {\n${decls.join("\n")}\n}`;
}

function themeCss(site: IRSite): string {
  const lines: string[] = [
    "/* Color styles imported from Framer. Edit these to recolor the whole site. */",
    ":root {",
  ];
  if (site.colorStyles.length) {
    for (const c of site.colorStyles) lines.push(`  ${c.varName}: ${c.light};`);
  } else {
    lines.push("  /* No shared color styles were detected. */");
  }
  lines.push("}");
  const darks = site.colorStyles.filter((c) => c.dark);
  if (darks.length) {
    lines.push("", "@media (prefers-color-scheme: dark) {", "  :root {");
    for (const c of darks) lines.push(`    ${c.varName}: ${c.dark};`);
    lines.push("  }", "}");
  }
  return lines.join("\n") + "\n";
}

/**
 * The shared icon definitions, emitted once per document.
 *
 * Every icon in the design points at this block by id, so it has to be present and
 * hidden — but not `display: none`, which stops some browsers resolving the reference.
 * A zero-size, clipped element keeps the definitions live without occupying layout.
 */
function svgSpriteJsx(site: IRSite): string {
  if (!site.svgSprite) return "";
  return `
        <div
          aria-hidden="true"
          data-framecoded-svg-sprite="true"
          style={{ position: "absolute", width: 0, height: 0, overflow: "hidden", pointerEvents: "none" }}
          dangerouslySetInnerHTML={{ __html: ${JSON.stringify(site.svgSprite)} }}
        />`;
}

function rootRoute(site: IRSite): string {
  return `import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import "../styles/global.css";
import "../styles/theme.css";

export const Route = createRootRoute({
  head: () => (${rootHeadLiteral(site)}),
  notFoundComponent: () => (
    <main style={{ padding: "4rem 1.5rem", textAlign: "center", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: "2rem", margin: 0 }}>404</h1>
      <p>This page could not be found.</p>
      <a href="/">Go home</a>
    </main>
  ),
  component: RootComponent,
});

function RootComponent() {
  return (
    <html lang=${JSON.stringify(site.lang || "en")}>
      <head>
        <HeadContent />
      </head>
      <body>${svgSpriteJsx(site)}
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
`;
}

function routeFile(
  page: IRPage,
  site: IRSite,
  pageComponentName: string,
): { file: GeneratedFile; motionFile?: GeneratedFile } {
  const segments = page.path === "/" ? [] : page.path.split("/").filter(Boolean);
  const fileBase = segments.length === 0 ? "index" : segments.join("/");
  const path = `src/routes/${fileBase}.tsx`;
  const upDirs = segments.length === 0 ? 1 : segments.length;
  const prefix = "../".repeat(upDirs);
  const importPath = `${prefix}components/${page.name}`;
  const motionImportPath = `${prefix}components/${page.name}/${pageComponentName}/${pageComponentName}.motion`;
  const jsonLd = jsonLdScriptsJsx(page, site);
  const routeName = jsxRouteComponentName(page.name);
  const motions = motionDefinitions(page.root);
  const interactions = interactionDefinitions(page.root);
  const hasRuntime =
    Object.keys(motions).length > 0 || Object.keys(interactions).length > 0 || hasPointerFollower(page.root);
  const motionImport = hasRuntime
    ? `\nimport { MotionRuntime } from ${JSON.stringify(`${prefix}ui/MotionRuntime`)};\nimport { motionDefinitions, interactionDefinitions } from ${JSON.stringify(motionImportPath)};`
    : "";
  const motionRuntime = hasRuntime
    ? "<MotionRuntime definitions={motionDefinitions} interactions={interactionDefinitions} />"
    : "";

  const content = `import { createFileRoute } from "@tanstack/react-router";
import { siteUrl, siteAssetUrl, siteJsonLd } from ${JSON.stringify(`${prefix}config/site`)};
import { ${pageComponentName} } from ${JSON.stringify(importPath)};${motionImport}

export const Route = createFileRoute(${JSON.stringify(page.path)})({
  head: () => (${pageHeadLiteral(page, site)}),
  component: ${routeName},
});

function ${routeName}() {
  return (
    <>
      ${jsonLd}
      <${pageComponentName} />
      ${motionRuntime}
    </>
  );
}
`;
  const file: GeneratedFile = { path, content, kind: "tsx" };
  if (!hasRuntime) return { file };

  const motionContent = `import type { MotionDefinitionMap, InteractionDefinitionMap } from "../../../ui/MotionRuntime";

export const motionDefinitions = ${JSON.stringify(motions)} satisfies MotionDefinitionMap;

export const interactionDefinitions = ${JSON.stringify(interactions)} satisfies InteractionDefinitionMap;
`;
  return {
    file,
    motionFile: {
      path: `src/components/${page.name}/${pageComponentName}/${pageComponentName}.motion.ts`,
      content: motionContent,
      kind: "tsx",
    },
  };
}

function motionDefinitions(root: IRNode): Record<string, IRAnimation[]> {
  const definitions: Record<string, IRAnimation[]> = {};
  const walk = (node: IRNode) => {
    if (node.animations?.length) definitions[node.id] = node.animations;
    if (node.kind === "element") node.children.forEach(walk);
  };
  walk(root);
  return definitions;
}

function interactionDefinitions(root: IRNode): Record<string, IRInteraction> {
  const definitions: Record<string, IRInteraction> = {};
  const walk = (node: IRNode) => {
    const trigger = node.attrs["data-framecoded-trigger"];
    if (trigger && node.interaction) definitions[trigger] = node.interaction;
    if (node.kind === "element") node.children.forEach(walk);
  };
  walk(root);
  return definitions;
}

function hasPointerFollower(root: IRNode): boolean {
  if (root.attrs["data-framecoded-cursor"] === "true") return true;
  return root.kind === "element" && root.children.some(hasPointerFollower);
}
