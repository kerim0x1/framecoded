import type { IRFavicon, IRPage, IRSite } from "../ir/types.js";
import type { GeneratedFile } from "./build.js";

export type FrameworkTarget = "tanstack" | "next" | "astro";

const OWNED_FILES = new Set([
  "package.json",
  "vite.config.ts",
  "tsconfig.json",
  "src/router.tsx",
  "src/config/site.ts",
  "README.md",
]);

export function frameworkTarget(value: unknown): FrameworkTarget {
  const target = String(value ?? "next").trim().toLowerCase();
  if (target === "tanstack" || target === "next" || target === "astro") return target;
  throw new Error(`Unknown framework ${JSON.stringify(value)}. Use tanstack, next, or astro.`);
}

export function adaptFrameworkFiles(
  site: IRSite,
  files: GeneratedFile[],
  target: FrameworkTarget,
): GeneratedFile[] {
  if (target === "tanstack") return files;

  const shared = files
    .filter((file) => !OWNED_FILES.has(file.path) && !file.path.startsWith("src/routes/"))
    .map((file) => adaptSharedFile(file, target));

  return target === "next"
    ? [...shared, ...nextFiles(site, files)]
    : [...shared, ...astroFiles(site, files)];
}

function adaptSharedFile(file: GeneratedFile, target: Exclude<FrameworkTarget, "tanstack">): GeneratedFile {
  if (file.path === ".env") {
    return {
      ...file,
      content: file.content.replace(/^VITE_SITE_URL=/m, "SITE_URL="),
    };
  }
  if (file.path === ".gitignore") {
    return { ...file, content: frameworkGitignore(target) };
  }
  if (file.path === "scripts/generate-seo.mjs") {
    return { ...file, content: file.content.replaceAll("VITE_SITE_URL", "SITE_URL") };
  }
  if (file.path.startsWith("src/components/") && file.path.endsWith(".tsx")) {
    return { ...file, content: adaptLinks(file.content, target) };
  }
  return file;
}

function adaptLinks(content: string, target: Exclude<FrameworkTarget, "tanstack">): string {
  const withoutTanStackImport = content.replace(
    /import\s+\{\s*Link\s*\}\s+from\s+["']@tanstack\/react-router["'];?\s*/g,
    target === "next" ? 'import Link from "next/link";\n' : "",
  );
  if (target === "next") {
    return withoutTanStackImport.replace(/<Link\b([^>]*?)\bto=/g, "<Link$1href=");
  }
  return withoutTanStackImport
    .replace(/<Link\b([^>]*?)\bto=/g, "<a$1href=")
    .replace(/<Link\b/g, "<a")
    .replace(/<\/Link>/g, "</a>");
}

function frameworkGitignore(target: Exclude<FrameworkTarget, "tanstack">): string {
  const output = target === "next" ? ".next/\nout/" : ".astro/\ndist/";
  return `node_modules/
${output}.env
.env.*
*.log
.DS_Store
`;
}

function packageName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "framecoded-export";
}

function faviconHref(favicon: IRFavicon): string {
  if (!favicon.localFile) return favicon.href;
  return "/" + favicon.localFile.replace(/^public[\\/]/, "").replaceAll("\\", "/").replace(/^\/+/, "");
}

function routeSegments(path: string): string[] {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.startsWith("$") ? `[${segment.slice(1)}]` : segment);
}

function hasMotionFile(files: GeneratedFile[], page: IRPage): boolean {
  return files.some((file) =>
    file.path === `src/components/${page.name}/${page.name}/${page.name}.motion.ts`,
  );
}

function siteTitle(site: IRSite): string {
  return site.pages.find((page) => page.path === "/")?.meta.title ?? site.name;
}

function siteDescription(site: IRSite): string | undefined {
  return site.pages.find((page) => page.path === "/")?.meta.description;
}

function nextFiles(site: IRSite, sourceFiles: GeneratedFile[]): GeneratedFile[] {
  const files: GeneratedFile[] = [
    { path: "package.json", content: nextPackageJson(site), kind: "json" },
    { path: "next.config.mjs", content: nextConfig(), kind: "raw" },
    { path: "next-env.d.ts", content: nextEnvTypes(), kind: "raw" },
    { path: "tsconfig.json", content: nextTsconfig(), kind: "json" },
    { path: "src/config/site.ts", content: nextSiteConfig(), kind: "tsx" },
    { path: "src/app/layout.tsx", content: nextRootLayout(site), kind: "tsx" },
    { path: "README.md", content: frameworkReadme(site, "next"), kind: "raw" },
  ];

  for (const page of site.pages) {
    const segments = routeSegments(page.path);
    const path = page.path === "/404"
      ? "src/app/not-found.tsx"
      : `src/app/${segments.length ? segments.join("/") + "/" : ""}page.tsx`;
    files.push({ path, content: nextPage(site, page, hasMotionFile(sourceFiles, page)), kind: "tsx" });
  }

  if (!site.pages.some((page) => page.path === "/404")) {
    files.push({ path: "src/app/not-found.tsx", content: nextNotFound(), kind: "tsx" });
  }
  return files;
}

function nextPackageJson(site: IRSite): string {
  return JSON.stringify({
    name: packageName(site.name),
    private: true,
    version: "0.1.0",
    scripts: {
      predev: "node scripts/generate-seo.mjs",
      dev: "next dev",
      prebuild: "node scripts/generate-seo.mjs",
      build: "next build",
      start: "next start",
      typecheck: "tsc --noEmit",
    },
    dependencies: {
      next: "latest",
      react: "latest",
      "react-dom": "latest",
    },
    devDependencies: {
      "@types/node": "latest",
      "@types/react": "latest",
      "@types/react-dom": "latest",
      typescript: "latest",
    },
  });
}

function nextConfig(): string {
  return `/** @type {import("next").NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
`;
}

function nextEnvTypes(): string {
  return `/// <reference types="next" />
/// <reference types="next/image-types/global" />

// Generated by Next.js. Do not edit this file directly.
`;
}

function nextTsconfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: "ES2017",
      lib: ["dom", "dom.iterable", "esnext"],
      allowJs: false,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      module: "esnext",
      moduleResolution: "bundler",
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: "preserve",
      incremental: true,
      plugins: [{ name: "next" }],
      paths: { "@/*": ["./src/*"] },
    },
    include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
    exclude: ["node_modules"],
  });
}

function nextSiteConfig(): string {
  return `import "server-only";

function requiredSiteUrl(value: string | undefined): string {
  try {
    if (!value) throw new Error("missing");
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
    return parsed.toString().replace(/\\/$/, "");
  } catch {
    throw new Error("[framecoded] SITE_URL is required and must be an absolute http(s) URL.");
  }
}

export const SITE_URL = requiredSiteUrl(process.env.SITE_URL);

export function siteUrl(path = "/"): string {
  if (/^https?:\\/\\//i.test(path)) path = new URL(path).pathname;
  return new URL(path.replace(/^\\/+/, ""), SITE_URL + "/").toString();
}

export function siteAssetUrl(value: string): string {
  if (!value || /^(?:data:|blob:)/i.test(value)) return value;
  try { return new URL(value).toString(); } catch { return siteUrl(value); }
}

function rewriteJsonLd(value: unknown): unknown {
  if (typeof value === "string") {
    if (/^https?:\\/\\//i.test(value)) return siteUrl(value);
    return value;
  }
  if (Array.isArray(value)) return value.map(rewriteJsonLd);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, rewriteJsonLd(entry)]),
    );
  }
  return value;
}

export function siteJsonLd(value: unknown): string {
  return JSON.stringify(rewriteJsonLd(value));
}
`;
}

function nextRootLayout(site: IRSite): string {
  const links = site.favicons.map((favicon) => `        <link rel=${JSON.stringify(favicon.rel)} href=${JSON.stringify(faviconHref(favicon))}${favicon.type ? ` type=${JSON.stringify(favicon.type)}` : ""}${favicon.sizes ? ` sizes=${JSON.stringify(favicon.sizes)}` : ""}${favicon.media ? ` media=${JSON.stringify(favicon.media)}` : ""} />`).join("\n");
  const sprite = site.svgSprite
    ? `        <div aria-hidden="true" style={{ position: "absolute", width: 0, height: 0, overflow: "hidden", pointerEvents: "none" }} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(site.svgSprite)} }} />\n`
    : "";
  return `import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SITE_URL } from "@/config/site";
import "@/styles/global.css";
import "@/styles/theme.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: ${JSON.stringify(siteTitle(site))},
  ${siteDescription(site) ? `description: ${JSON.stringify(siteDescription(site))},` : ""}
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang=${JSON.stringify(site.lang || "en")}>
      <head>
${links}
      </head>
      <body>
${sprite}        {children}
      </body>
    </html>
  );
}
`;
}

function nextPage(_site: IRSite, page: IRPage, hasMotion: boolean): string {
  const title = page.meta.title ?? page.name;
  const description = page.meta.description;
  const image = page.meta.openGraph.image ?? page.meta.twitter.image;
  const motionImports = hasMotion
    ? `\nimport { MotionRuntime } from "@/ui/MotionRuntime";\nimport { motionDefinitions, interactionDefinitions } from "@/components/${page.name}/${page.name}/${page.name}.motion";`
    : "";
  const motionRuntime = hasMotion
    ? "      <MotionRuntime definitions={motionDefinitions} interactions={interactionDefinitions} />"
    : "";
  return `import type { Metadata } from "next";
import { ${page.name} } from "@/components/${page.name}";
import { siteAssetUrl, siteJsonLd, siteUrl } from "@/config/site";${motionImports}

const structuredData = ${JSON.stringify(page.meta.jsonLd)};

export const metadata: Metadata = {
  title: ${JSON.stringify(title)},
  ${description ? `description: ${JSON.stringify(description)},` : ""}
  alternates: { canonical: siteUrl(${JSON.stringify(page.path)}) },
  openGraph: {
    title: ${JSON.stringify(page.meta.openGraph.title ?? title)},
    ${description ? `description: ${JSON.stringify(page.meta.openGraph.description ?? description)},` : ""}
    url: siteUrl(${JSON.stringify(page.path)}),
    ${image ? `images: [siteAssetUrl(${JSON.stringify(image)})],` : ""}
  },
  twitter: {
    card: "summary_large_image",
    title: ${JSON.stringify(page.meta.twitter.title ?? title)},
    ${description ? `description: ${JSON.stringify(page.meta.twitter.description ?? description)},` : ""}
    ${image ? `images: [siteAssetUrl(${JSON.stringify(image)})],` : ""}
  },
};

export default function Page() {
  return (
    <>
      {structuredData.map((value, index) => (
        <script key={index} type="application/ld+json" dangerouslySetInnerHTML={{ __html: siteJsonLd(value) }} />
      ))}
      <${page.name} />
${motionRuntime}
    </>
  );
}
`;
}

function nextNotFound(): string {
  return `export default function NotFound() {
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem", textAlign: "center" }}>
      <div><h1>404</h1><p>This page could not be found.</p><a href="/">Go home</a></div>
    </main>
  );
}
`;
}

function astroFiles(site: IRSite, sourceFiles: GeneratedFile[]): GeneratedFile[] {
  const files: GeneratedFile[] = [
    { path: "package.json", content: astroPackageJson(site), kind: "json" },
    { path: "astro.config.mjs", content: astroConfig(), kind: "raw" },
    { path: "tsconfig.json", content: astroTsconfig(), kind: "json" },
    { path: "src/env.d.ts", content: astroEnvTypes(), kind: "raw" },
    { path: "src/config/site.ts", content: astroSiteConfig(), kind: "tsx" },
    { path: "src/layouts/SiteLayout.astro", content: astroLayout(site), kind: "raw" },
    { path: "README.md", content: frameworkReadme(site, "astro"), kind: "raw" },
  ];

  for (const page of site.pages) {
    const segments = routeSegments(page.path);
    const path = `src/pages/${segments.length ? segments.join("/") : "index"}.astro`;
    files.push({ path, content: astroPage(page, hasMotionFile(sourceFiles, page)), kind: "raw" });
  }
  if (!site.pages.some((page) => page.path === "/404")) {
    files.push({ path: "src/pages/404.astro", content: astroNotFound(), kind: "raw" });
  }
  return files;
}

function astroPackageJson(site: IRSite): string {
  return JSON.stringify({
    name: packageName(site.name),
    private: true,
    version: "0.1.0",
    type: "module",
    scripts: {
      predev: "node scripts/generate-seo.mjs",
      dev: "astro dev",
      prebuild: "node scripts/generate-seo.mjs",
      build: "astro build",
      preview: "astro preview",
      check: "astro check",
    },
    dependencies: {
      "@astrojs/react": "^6.0.1",
      astro: "latest",
      react: "latest",
      "react-dom": "latest",
    },
    devDependencies: {
      "@astrojs/check": "latest",
      "@types/react": "latest",
      "@types/react-dom": "latest",
      typescript: "latest",
    },
  });
}

function astroConfig(): string {
  return `import { defineConfig } from "astro/config";
import react from "@astrojs/react";

export default defineConfig({
  integrations: [react()],
  build: { format: "directory" },
});
`;
}

function astroTsconfig(): string {
  return JSON.stringify({
    extends: "astro/tsconfigs/strict",
    include: [".astro/types.d.ts", "**/*"],
    exclude: ["dist"],
    compilerOptions: {
      jsx: "react-jsx",
      jsxImportSource: "react",
      baseUrl: ".",
      paths: { "@/*": ["src/*"] },
    },
  });
}

function astroEnvTypes(): string {
  return `/// <reference types="astro/client" />
`;
}

function astroSiteConfig(): string {
  return `function requiredSiteUrl(value: string | undefined): string {
  try {
    if (!value) throw new Error("missing");
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
    return parsed.toString().replace(/\\/$/, "");
  } catch {
    throw new Error("[framecoded] SITE_URL is required and must be an absolute http(s) URL.");
  }
}

export const SITE_URL = requiredSiteUrl(import.meta.env.SITE_URL);

export function siteUrl(path = "/"): string {
  if (/^https?:\\/\\//i.test(path)) path = new URL(path).pathname;
  return new URL(path.replace(/^\\/+/, ""), SITE_URL + "/").toString();
}

export function siteAssetUrl(value: string): string {
  if (!value || /^(?:data:|blob:)/i.test(value)) return value;
  try { return new URL(value).toString(); } catch { return siteUrl(value); }
}

function rewriteJsonLd(value: unknown): unknown {
  if (typeof value === "string") {
    if (/^https?:\\/\\//i.test(value)) return siteUrl(value);
    return value;
  }
  if (Array.isArray(value)) return value.map(rewriteJsonLd);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, rewriteJsonLd(entry)]),
    );
  }
  return value;
}

export function siteJsonLd(value: unknown): string {
  return JSON.stringify(rewriteJsonLd(value));
}
`;
}

function astroLayout(site: IRSite): string {
  const favicons = JSON.stringify(site.favicons.map((favicon) => ({
    rel: favicon.rel,
    href: faviconHref(favicon),
    ...(favicon.type ? { type: favicon.type } : {}),
    ...(favicon.sizes ? { sizes: favicon.sizes } : {}),
    ...(favicon.media ? { media: favicon.media } : {}),
  })));
  return `---
import "@/styles/global.css";
import "@/styles/theme.css";

interface Props {
  title: string;
  description?: string;
  canonical: string;
  robots?: string;
  openGraph?: Record<string, string>;
  twitter?: Record<string, string>;
}

const { title, description, canonical, robots, openGraph = {}, twitter = {} } = Astro.props;
const favicons = ${favicons};
const svgSprite = ${JSON.stringify(site.svgSprite ?? "")};
---
<!doctype html>
<html lang=${JSON.stringify(site.lang || "en")}>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="generator" content="framecoded (from Framer)" />
    <title>{title}</title>
    {description && <meta name="description" content={description} />}
    {robots && <meta name="robots" content={robots} />}
    <link rel="canonical" href={canonical} />
    {favicons.map((favicon) => <link {...favicon} />)}
    {Object.entries(openGraph).map(([property, content]) => <meta property={\`og:\${property}\`} content={content} />)}
    {Object.entries(twitter).map(([name, content]) => <meta name={\`twitter:\${name}\`} content={content} />)}
  </head>
  <body>
    {svgSprite && <div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden;pointer-events:none" set:html={svgSprite} />}
    <slot />
  </body>
</html>
`;
}

function astroPage(page: IRPage, hasMotion: boolean): string {
  const motionImports = hasMotion
    ? `\nimport { MotionRuntime } from "@/ui/MotionRuntime";\nimport { motionDefinitions, interactionDefinitions } from "@/components/${page.name}/${page.name}/${page.name}.motion";`
    : "";
  const motionRuntime = hasMotion
    ? "  <MotionRuntime client:load definitions={motionDefinitions} interactions={interactionDefinitions} />"
    : "";
  return `---
import SiteLayout from "@/layouts/SiteLayout.astro";
import { ${page.name} } from "@/components/${page.name}";
import { siteAssetUrl, siteJsonLd, siteUrl } from "@/config/site";${motionImports}

const title = ${JSON.stringify(page.meta.title ?? page.name)};
const description = ${JSON.stringify(page.meta.description)};
const openGraph = ${JSON.stringify(page.meta.openGraph)};
const twitter = ${JSON.stringify(page.meta.twitter)};
openGraph.url = siteUrl(${JSON.stringify(page.path)});
if (openGraph.image) openGraph.image = siteAssetUrl(openGraph.image);
if (twitter.image) twitter.image = siteAssetUrl(twitter.image);
const structuredData = ${JSON.stringify(page.meta.jsonLd)};
---
<SiteLayout
  title={title}
  description={description}
  canonical={siteUrl(${JSON.stringify(page.path)})}
  robots=${JSON.stringify(page.meta.robots)}
  openGraph={openGraph}
  twitter={twitter}
>
  {structuredData.map((value) => <script type="application/ld+json" set:html={siteJsonLd(value)} />)}
  <${page.name} />
${motionRuntime}
</SiteLayout>
`;
}

function astroNotFound(): string {
  return `---
import SiteLayout from "@/layouts/SiteLayout.astro";
import { siteUrl } from "@/config/site";
---
<SiteLayout title="404" canonical={siteUrl("/404")}>
  <main style="min-height:100vh;display:grid;place-items:center;padding:2rem;text-align:center">
    <div><h1>404</h1><p>This page could not be found.</p><a href="/">Go home</a></div>
  </main>
</SiteLayout>
`;
}

function frameworkReadme(site: IRSite, target: Exclude<FrameworkTarget, "tanstack">): string {
  const label = target === "next" ? "Next.js App Router" : "Astro with React";
  const buildOutput = target === "next" ? ".next/" : "dist/";
  return `# ${site.name}

Generated by **framecoded** as a ${label} project. The React components, CSS Modules,
responsive breakpoints, assets and captured motion remain editable source code.

## Start

\`\`\`bash
npm install
npm run dev
\`\`\`

## Domain and SEO

Replace the placeholder in \`.env\` with the public deployment domain:

\`\`\`env
SITE_URL=https://your-domain.com
\`\`\`

There is no fallback. The value drives canonical URLs, Open Graph, JSON-LD,
\`robots.txt\`, and \`sitemap.xml\`.

## Build

\`\`\`bash
npm run build
\`\`\`

Build output: \`${buildOutput}\`.
`;
}
