<div align="center">

# FRAMECODED

### Escape the canvas.<br />Keep the craft.

Export published Framer websites into clean, modular and editable **Next.js**
projects with responsive layouts, local assets, SEO and Motion animations
included. TanStack Start and Astro are supported too.

[![Version](https://img.shields.io/npm/v/framecoded?style=flat-square&color=111111)](https://www.npmjs.com/package/framecoded)
[![Node](https://img.shields.io/badge/Node.js-20%2B-43853d?style=flat-square)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-f05a47?style=flat-square)](#license)
[![Creator](https://img.shields.io/badge/creator-kerim0x1-111111?style=flat-square)](https://kerim0x1.com)

[Watch video](#video) | [Quick start](#quick-start) | [How it works](#how-it-works) | [CLI](#cli-reference)

</div>

---

## Video

<p align="center">
  <a href="https://www.youtube.com/watch?v=ykRd-C1uWo8">
    <img src="https://img.youtube.com/vi/ykRd-C1uWo8/maxresdefault.jpg" alt="Watch Framecoded on YouTube" width="640" />
  </a>
</p>

<p align="center">
  <a href="https://www.youtube.com/watch?v=ykRd-C1uWo8"><strong>Watch Framecoded on YouTube</strong></a>
</p>

## Why Framecoded?

Framer is a great place to design and ship. But when a project outgrows the
canvas, moving it into a real codebase should not mean rebuilding every page
from zero.

Framecoded crawls a published Framer website, observes its responsive layouts,
collects its assets and turns the result into a project you can open, edit,
extend and deploy yourself.

> [!IMPORTANT]
> Webflow and Figma support is currently in development. Framer is the supported
> source today, so please be aware that Webflow and Figma imports are not ready
> for production use yet.

No iframe. No screenshot pretending to be a website. No permanent dependency
on the original Framer deployment.

## What you get

| | Capability | Result |
|---|---|---|
| **01** | Responsive capture | Layouts are inspected across desktop, tablet and mobile viewports. |
| **02** | Clean modular components | Every route is split into semantic React sections while internal Framer wrappers stay inline. |
| **03** | Local assets | Images, fonts and other discovered assets are collected into the generated project. |
| **04** | Motion support | Supported Framer transitions and interactions are preserved with web-native animation output. |
| **05** | Multi-page export | Linked pages can be crawled and generated as framework-native routes. |
| **06** | SEO foundation | Metadata, canonical URLs, Open Graph data, `robots.txt` and `sitemap.xml` are generated. |
| **07** | Framework choice | Export the same captured site to Next.js, TanStack Start or Astro. |

## Quick start

### Requirements

- Node.js 20 or newer
- npm
- A Chromium-based browser available to the renderer

### Run without installing

```bash
npx framecoded export https://example.framer.website/
```

### Install globally

```bash
npm install --global framecoded
framecoded export https://example.framer.website/
```

### Update an existing installation

```bash
npm install --global framecoded@latest
```

You can always run the newest release without a global installation:

```bash
npx framecoded@latest export https://example.framer.website/
```

The default target is Next.js. Choose another framework with
`--framework`:

```bash
framecoded export https://example.framer.website/ --framework tanstack
framecoded export https://example.framer.website/ --framework astro
```

Exports are written to `exports/<site-name>/` by default. The site name is
derived from the source hostname. Use `--out` when you want full control:

```bash
framecoded export https://example.framer.website/ \
  --framework next \
  --out exports/my-website
```

## Framework targets

| Target | Flag | Site URL variable |
|---|---|---|
| **Next.js App Router (default)** | `--framework next` | `SITE_URL` |
| TanStack Start | `--framework tanstack` | `VITE_SITE_URL` |
| Astro with React | `--framework astro` | `SITE_URL` |

Each generated project contains its own `.env` file with a placeholder domain.
Replace it before deploying:

```env
SITE_URL=https://your-domain.com
```

TanStack Start uses:

```env
VITE_SITE_URL=https://your-domain.com
```

There is intentionally no hidden fallback to the original Framer domain. The
configured value is the source of truth for canonical URLs, Open Graph,
structured data, `robots.txt` and `sitemap.xml`.

## Deploy Next.js to Vercel

Every default Framecoded export is a standalone Next.js project. The easiest
deployment workflow is to place that generated code in a new GitHub repository
and import the repository into Vercel.

### 1. Export the website

```bash
framecoded export https://example.framer.website/ --out exports/my-website
```

Your complete Next.js project is now inside `exports/my-website/`.

### 2. Create an empty GitHub repository

Create a new repository on [GitHub](https://github.com/new). Keep it empty and
do not add a README, `.gitignore` or license during creation.

### 3. Transfer the exported code

Copy everything **inside** `exports/my-website/` into the new repository. Do not
copy the `my-website` folder as another nested directory. `package.json` must be
located directly at the repository root.

Open a terminal in that repository and push the files:

```bash
git init
git add .
git commit -m "Initial Framecoded export"
git branch -M main
git remote add origin https://github.com/USERNAME/REPOSITORY.git
git push -u origin main
```

Replace `USERNAME` and `REPOSITORY` with the values from the empty GitHub
repository you created.

### 4. Import the repository into Vercel

1. Open [vercel.com/new](https://vercel.com/new).
2. Connect GitHub if it is not connected yet.
3. Select the repository containing the exported code.
4. Confirm that Vercel detected **Next.js** as the Framework Preset.
5. Add `SITE_URL` under **Environment Variables** and enter your production domain.
6. Click **Deploy**.

That is it. Vercel installs the dependencies, builds the Next.js project and
publishes it. Every future push to the `main` branch automatically creates a new
production deployment.

If you do not have a custom domain yet, deploy once, copy the assigned
`https://your-project.vercel.app` URL, set it as `SITE_URL` in Vercel and deploy
again. This ensures canonical URLs, Open Graph data, `robots.txt` and
`sitemap.xml` use the correct public domain.

## How it works

```text
Published Framer site
        |
        v
Responsive browser capture
        |
        v
Framework-independent site model
        |
        +----------------+----------------+
        |                |                |
        v                v                v
      Next.js      TanStack Start       Astro
```

Framecoded separates capture from generation. The source website is converted
into a framework-independent representation first, then passed to the selected
output adapter. This keeps the exporter extensible and avoids coupling every
new source to every supported framework.

Generated projects are organized around routes, reusable components, scoped
styles and local assets. Exact folders vary by framework, but the result is
normal application code intended to be changed after export.

Each exported route receives its own component namespace at
`src/components/<PageName>/`. Framecoded extracts meaningful page regions such
as `Nav`, `HeroSection`, `PricingSection`, `FaqSection` and `Footer`, while
keeping implementation wrappers inside their owning section. Re-running an
export resets the generated `src` and `public` trees first, so components and
assets from an older export cannot remain in the project.

## CLI reference

```text
framecoded export <url> [options]
```

| Option | Description |
|---|---|
| `--framework next\|tanstack\|astro` | Select the generated framework. Defaults to Next.js. |
| `--out <directory>` | Set a custom output directory. |
| `--no-crawl` | Export only the supplied page. |
| `--max-pages <number>` | Limit how many linked pages are captured. |

Import an existing Framecoded MCP document with:

```text
framecoded from-mcp <xml> [--framework tanstack|next|astro] [--out <directory>]
```

During development, commands can be run through the built entry point:

```bash
node dist/cli.js export https://example.framer.website/ --out exports/example
```

## Repository structure

```text
src/                 exporter and code generator source
desktop/             desktop application
exports/<site-name>/ generated websites
dist/                compiled CLI
```

## Development

```bash
git clone https://github.com/kerim0x1/framecoded.git
cd framecoded
npm install
npm run typecheck
npm run build
node dist/cli.js --help
```

The `prepack` script runs type checking and creates `dist/cli.js` automatically
before npm packages or publishes a release.

## A note about generated components

> [!NOTE]
> Framer can render separate DOM trees for Desktop, Tablet and Mobile. Framecoded
> detects matching breakpoint trees and folds them into one semantic component.
> Ambiguous variants are deliberately kept separate rather than risking a broken
> responsive layout.

The same modular planner runs independently for every crawled page. It keeps the
page root readable, extracts only genuine semantic regions and avoids nested
wrapper chains such as `Section -> Content -> Content2 -> Title`. Desktop,
Tablet and Mobile styling remains inside the resulting component through scoped
media queries instead of producing separate breakpoint component folders.

The responsive merge pass compares Framer names, headings, text and asset
signals, element structure and sibling position. Confident matches become one
React component with media-query overrides, so an About section can remain
`AboutUsSection` across every breakpoint. When two variants cannot be matched
safely, Framecoded still prioritizes visual fidelity and preserves both branches.

Animations are generated with [Motion](https://motion.dev/), the same animation
library used by Framer. This keeps supported transitions and interactions close
to the original while leaving them editable inside the exported React code.

## Current scope

Framecoded aims for a strong, editable baseline rather than an opaque byte-for-
byte copy. Highly custom embeds, third-party scripts and uncommon Framer runtime
behavior may still need manual adjustment after export.

Framecoded performs browser-based website reconstruction and code migration. It
analyzes the HTML, CSS, assets and responsive layout publicly delivered to a
normal browser, converts that result into a framework-independent model and
generates new application code from it. It does not decompile the Framer editor,
bypass access controls or copy Framer's private source code.

Only export websites and assets you own or have permission to use. Framecoded
is an independent project and is not affiliated with Framer.

## Built by Kerim

Framecoded is developed by [kerim0x1](https://kerim0x1.com), a 20-year-old
developer who loves Framer, but believes getting stuck inside a visual builder
should never mean starting over.

## License

Released under the MIT License.
