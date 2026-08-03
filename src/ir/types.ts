/**
 * Intermediate Representation (IR)
 * --------------------------------
 * A normalized, framework-agnostic description of a Framer design. Both ingestion
 * adapters produce an `IRSite`; the codegen only ever
 * reads the IR. Keeping the IR small and explicit is what lets one generator serve
 * both the "works today" URL path and the "highest fidelity" plugin path.
 *
 * Style is stored as a map of **kebab-case CSS property → value** so it maps directly
 * onto a generated CSS Module rule with zero translation.
 */

export type CssDecls = Record<string, string>;

export interface ResponsiveOverride {
  /** A full media query, e.g. `(max-width: 809px)`. */
  media: string;
  style: CssDecls;
  /** Pseudo-selector overrides inside this media query, e.g. { ":hover": {…} }. */
  pseudo?: Record<string, CssDecls>;
}

export interface IRStyle {
  /** Base (desktop-canonical) declarations. */
  base: CssDecls;
  /** Pseudo-class/element declarations, e.g. { ":hover": {…}, "::before": {…} }. */
  pseudo: Record<string, CssDecls>;
  /** Media-query overrides, applied in order. */
  responsive: ResponsiveOverride[];
}

/** A browser-native animation captured before Framer's runtime starts it. */
export interface IRAnimation {
  /** Page-load motion starts immediately; in-view motion waits for its element to enter the viewport. */
  trigger: "load" | "in-view" | "tap" | "scroll";
  /** The original WAAPI Keyframe[] or PropertyIndexedKeyframes value. */
  keyframes: unknown;
  /** Serializable KeyframeAnimationOptions. Infinity is stored as the string "Infinity". */
  options: Record<string, unknown>;
  /** Optional responsive guard for breakpoint-specific motion. */
  media?: string;
  /** Stable trigger id for tap-driven animations. */
  source?: string;
  /** Which side of a captured toggle this animation belongs to. */
  phase?: "open" | "close";
}

export interface IRInteractionTarget {
  /** Stable data-framecoded-state id emitted on the target element. */
  id: string;
  closed: CssDecls;
  open: CssDecls;
  /** Native CSS transition timing for each changed property. */
  timings?: Record<string, { duration: number; delay: number; easing: string }>;
  /** Sampled Motion/Framer trajectory for stateful interactions that do not use CSS transitions. */
  openKeyframes?: Array<Record<string, string | number>>;
  closeKeyframes?: Array<Record<string, string | number>>;
  openDuration?: number;
  closeDuration?: number;
}

export interface IRResponsiveInteraction {
  media: string;
  targets: IRInteractionTarget[];
  duration: number;
  easing: string;
}

/** A stateful Framer component captured in both of its rendered states. */
export interface IRInteraction {
  type: "toggle" | "hover";
  targets: IRInteractionTarget[];
  duration: number;
  easing: string;
  /** Tablet/phone state geometry captured at their actual viewport widths. */
  responsive?: IRResponsiveInteraction[];
}

export interface NodeBase {
  id: string;
  /** Semantic HTML tag chosen for this node (section, header, nav, h1, p, a, ul, li, figure…). */
  tag: string;
  /** Class name used in the generated CSS Module (camelCase key into `styles`). */
  className?: string;
  style: IRStyle;
  /** Extra HTML attributes to emit verbatim (e.g. aria-*, data-*, role). */
  attrs: Record<string, string>;
  /** Exact Web Animations API calls observed on this layer. */
  animations?: IRAnimation[];
  /** Closed/open computed-state delta for toggles and parent-hover components. */
  interaction?: IRInteraction;
}

export interface IRElement extends NodeBase {
  kind: "element";
  children: IRNode[];
  /** When set, the element is rendered as an `<a>` (or `<Link>` for internal routes). */
  href?: string;
  hrefTarget?: string;
  /** Marks an internal route link (starts with "/"), so codegen can use TanStack <Link>. */
  internalLink?: boolean;
}

export interface IRText extends NodeBase {
  kind: "text";
  /** Plain text content. May contain inline-formatted runs flattened to text. */
  text: string;
  /** Inline HTML (bold/italic/links) when the text had inline formatting. */
  html?: string;
  href?: string;
  hrefTarget?: string;
  internalLink?: boolean;
}

export interface IRImage extends NodeBase {
  kind: "image";
  src: string;
  alt: string;
  /** True when the alt text was synthesized because the source had none. */
  altGenerated: boolean;
  width?: number;
  height?: number;
  srcset?: string;
  sizes?: string;
  /** Background-image (vs <img>) — rendered as a div with background. */
  asBackground?: boolean;
  /** LCP candidate — render eagerly with high fetch priority instead of lazy. */
  priority?: boolean;
}

export interface IRSvg extends NodeBase {
  kind: "svg";
  /** Raw inline SVG markup. */
  svg: string;
}

export type IRNode = IRElement | IRText | IRImage | IRSvg;

export interface IRFavicon {
  rel: string; // icon | apple-touch-icon | mask-icon
  href: string;
  media?: string;
  type?: string;
  sizes?: string;
  /** Local filename once downloaded into /public. */
  localFile?: string;
}

export interface IRMeta {
  title?: string;
  description?: string;
  canonical?: string;
  robots?: string;
  lang?: string;
  /** og:* values keyed without the `og:` prefix (e.g. { title, description, image, type }). */
  openGraph: Record<string, string>;
  /** twitter:* values keyed without the `twitter:` prefix. */
  twitter: Record<string, string>;
  /** Parsed JSON-LD structured-data blocks found in <head>/<body>. */
  jsonLd: unknown[];
}

export interface IRPage {
  /** Route path, e.g. "/" or "/about" or "/blog/$slug". */
  path: string;
  /** PascalCase component/file name, e.g. "Home", "About". */
  name: string;
  meta: IRMeta;
  root: IRNode;
}

export interface IRColorStyle {
  name: string;
  /** CSS custom-property name, e.g. "--color-primary". */
  varName: string;
  light: string;
  dark?: string;
}

export interface IRFont {
  family: string;
  weights: number[];
  /** Source url(s) for self-hosting, if known. */
  src?: string[];
  /** Google Fonts family when detected. */
  google?: boolean;
}

export interface IRImageAsset {
  /** Original (CDN) URL. */
  url: string;
  /** Local path under /public/assets once downloaded. */
  localFile?: string;
  width?: number;
  height?: number;
}

export interface IRSite {
  /** Project / site display name (drives package.json name, titles fallback). */
  name: string;
  source: {
    type: "published-site" | "plugin";
    origin: string;
  };
  /** Canonical site origin, e.g. "https://example.com". */
  baseUrl?: string;
  pages: IRPage[];
  favicons: IRFavicon[];
  colorStyles: IRColorStyle[];
  fonts: IRFont[];
  /** Global stylesheet text (reset, :root vars, font-face). */
  globalCss: string;
  /**
   * Shared SVG definitions referenced by `<use href="#…">`.
   *
   * Framer keeps every icon's geometry in one hidden block and points at it from each
   * place the icon appears. Without the block the references resolve to nothing and the
   * icons render as empty boxes, so it has to be emitted once per document.
   */
  svgSprite?: string;
  /** All discovered remote image assets (for optional local download). */
  assets: IRImageAsset[];
  /** Default site language. */
  lang: string;
}
