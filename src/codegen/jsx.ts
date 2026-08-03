import type { IRNode, IRElement, IRText, IRImage, IRSvg } from "../ir/types.js";

const VOID_TAGS = new Set(["img", "br", "hr", "input", "source", "area", "col", "wbr"]);

export interface JsxContext {
  /** Local name of the CSS-module import (usually "styles"). */
  stylesIdent: string;
  /** node.id -> component name, for nodes extracted into their own component. */
  boundaries: Map<string, string>;
  /** The node id currently being rendered as a component root (never treated as a boundary). */
  rootId: string;
  /** Collects which imports the generated JSX needs. */
  uses: { link: boolean; image: boolean };
  /** Child component names referenced from this component (for import generation). */
  childComponents: Set<string>;
  /** Instance node id → props to pass when rendering it as a shared component. */
  instanceProps?: Map<string, Record<string, string>>;
  /** Node id → the prop that replaces its literal content in a repeated template. */
  slots?: Map<string, { name: string; kind: "text" | "image" | "svg" }>;
}

export function renderNode(node: IRNode, ctx: JsxContext): string {
  // Component boundary → emit a reference, unless this is the component's own root.
  if (node.id !== ctx.rootId && ctx.boundaries.has(node.id)) {
    const name = ctx.boundaries.get(node.id)!;
    ctx.childComponents.add(name);
    // One of several siblings sharing a component: pass what makes this one different.
    const props = ctx.instanceProps?.get(node.id);
    if (props && Object.keys(props).length) {
      const attrs = Object.entries(props)
        .map(([k, v]) => strAttr(k, v))
        .join("");
      return `<${name}${attrs} />`;
    }
    return `<${name} />`;
  }
  switch (node.kind) {
    case "text":
      return renderText(node, ctx);
    case "image":
      return renderImage(node, ctx);
    case "svg":
      return renderSvg(node, ctx);
    case "element":
      return renderElement(node, ctx);
  }
}

/** Property access that stays valid whatever the class name looks like.
 *
 * Class names are derived from Framer layer names, and Framer auto-names text layers
 * after their content — so a footer line like "© 2026 Harness Labs, Inc." can yield a
 * name starting with a digit. `styles.2026HarnessLabsInc` is a syntax error that only
 * surfaces at build time, so anything that isn't a plain identifier gets bracketed. */
const JS_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function styleAccess(stylesIdent: string, className: string): string {
  return JS_IDENT.test(className)
    ? `${stylesIdent}.${className}`
    : `${stylesIdent}[${JSON.stringify(className)}]`;
}

function classProp(node: IRNode, ctx: JsxContext): string {
  return node.className ? ` className={${styleAccess(ctx.stylesIdent, node.className)}}` : "";
}

/**
 * A string-valued JSX attribute, emitted in **expression** form (`name={"..."}`).
 * This is always valid even when the value contains quotes/backslashes (e.g. inline
 * data-URI SVGs); prettier collapses the simple cases back to `name="..."`.
 */
function strAttr(name: string, value: string): string {
  return ` ${name}={${JSON.stringify(value)}}`;
}

/**
 * Attributes the link renderers write themselves. Emitting them again from `node.attrs`
 * produces a duplicated JSX attribute (`<a target={"_blank"} … target={"_blank"}>`),
 * which is invalid and only surfaces when the generated project is compiled.
 */
const LINK_OWNED_ATTRS = new Set(["href", "target", "rel"]);

const REACT_ATTR_NAMES: Record<string, string> = {
  autoplay: "autoPlay",
  playsinline: "playsInline",
  readonly: "readOnly",
  tabindex: "tabIndex",
  colspan: "colSpan",
  rowspan: "rowSpan",
  datetime: "dateTime",
  srcset: "srcSet",
  referrerpolicy: "referrerPolicy",
  allowfullscreen: "allowFullScreen",
  frameborder: "frameBorder",
  crossorigin: "crossOrigin",
  minlength: "minLength",
  maxlength: "maxLength",
  inputmode: "inputMode",
  autocomplete: "autoComplete",
  autofocus: "autoFocus",
  novalidate: "noValidate",
  formnovalidate: "formNoValidate",
  usemap: "useMap",
  ismap: "isMap",
};
const BOOLEAN_ATTRS = new Set([
  "autoPlay", "controls", "loop", "muted", "playsInline", "open", "required", "disabled",
  "checked", "selected", "multiple", "readOnly",
  "allowFullScreen", "autoFocus", "noValidate", "formNoValidate", "isMap",
]);

function motionAttr(node: IRNode): string {
  return node.animations?.length ? strAttr("data-framecoded-motion", node.id) : "";
}

function extraAttrs(node: IRNode, isLink = false): string {
  let out = "";
  for (const [k, v] of Object.entries(node.attrs)) {
    if (k === "class" || k === "style") continue;
    if (isLink && LINK_OWNED_ATTRS.has(k)) continue;
    if (k === "data-framecoded-motion") continue;
    const name = k === "for" ? "htmlFor" : REACT_ATTR_NAMES[k.toLowerCase()] ?? k;
    if (BOOLEAN_ATTRS.has(name) && (v === "" || v === "true" || v.toLowerCase() === k.toLowerCase())) {
      out += ` ${name}`;
    } else {
      out += strAttr(name, v);
    }
  }
  return out + motionAttr(node);
}

function renderElement(node: IRElement, ctx: JsxContext): string {
  const children = node.children.map((c) => renderNode(c, ctx)).join("");

  // Internal link → TanStack <Link to=…>; external → <a href=…>.
  if (node.tag === "a" && node.href) {
    if (node.internalLink) {
      ctx.uses.link = true;
      return `<Link${strAttr("to", node.href)}${classProp(node, ctx)}${extraAttrs(node, true)}>${children}</Link>`;
    }
    return `<a${strAttr("href", node.href)}${linkTargetEl(node)}${classProp(node, ctx)}${extraAttrs(node, true)}>${children}</a>`;
  }

  if (VOID_TAGS.has(node.tag)) {
    return `<${node.tag}${classProp(node, ctx)}${extraAttrs(node)} />`;
  }
  return `<${node.tag}${classProp(node, ctx)}${extraAttrs(node)}>${children}</${node.tag}>`;
}

function renderText(node: IRText, ctx: JsxContext): string {
  const tag = node.tag === "a" && node.href ? "a" : node.tag;
  const openTagIsLink = node.tag === "a" && node.href;

  // In a shared template this text is whatever the instance passes in.
  const slot = ctx.slots?.get(node.id);
  if (slot && !openTagIsLink) {
    return `<${tag}${classProp(node, ctx)}${extraAttrs(node)}>{props.${slot.name}}</${tag}>`;
  }

  if (node.html) {
    const inner = `dangerouslySetInnerHTML={{ __html: ${JSON.stringify(node.html)} }}`;
    if (openTagIsLink) {
      if (node.internalLink) {
        ctx.uses.link = true;
        return `<Link${strAttr("to", node.href!)}${classProp(node, ctx)}${extraAttrs(node, true)} ${inner} />`;
      }
      return `<a${strAttr("href", node.href!)}${linkTarget(node)}${classProp(node, ctx)}${extraAttrs(node, true)} ${inner} />`;
    }
    return `<${tag}${classProp(node, ctx)}${extraAttrs(node)} ${inner} />`;
  }

  const text = escapeJsxText(node.text);
  if (openTagIsLink) {
    if (node.internalLink) {
      ctx.uses.link = true;
      return `<Link${strAttr("to", node.href!)}${classProp(node, ctx)}${extraAttrs(node, true)}>${text}</Link>`;
    }
    return `<a${strAttr("href", node.href!)}${linkTarget(node)}${classProp(node, ctx)}${extraAttrs(node, true)}>${text}</a>`;
  }
  return `<${tag}${classProp(node, ctx)}${extraAttrs(node)}>${text}</${tag}>`;
}

function linkTarget(node: IRText): string {
  return node.hrefTarget ? `${strAttr("target", node.hrefTarget)} rel="noopener noreferrer"` : "";
}
function linkTargetEl(node: IRElement): string {
  return node.hrefTarget ? `${strAttr("target", node.hrefTarget)} rel="noopener noreferrer"` : "";
}

function normalizeSrc(src: string): string {
  // Framer inlines small SVG icons as raw (unencoded) data URIs. Percent-encode the
  // SVG payload so it is a valid data URI in any context.
  const m = /^data:image\/svg\+xml,(.*)$/s.exec(src);
  if (m && m[1] && m[1].includes("<")) {
    return "data:image/svg+xml," + encodeURIComponent(m[1]);
  }
  return src;
}

function renderImage(node: IRImage, ctx: JsxContext): string {
  ctx.uses.image = true;
  const slot = ctx.slots?.get(node.id);
  const src = slot ? ` src={props.${slot.name}}` : strAttr("src", normalizeSrc(node.src));
  const attrs: string[] = [src, strAttr("alt", node.alt)];
  if (node.width) attrs.push(` width={${node.width}}`);
  if (node.height) attrs.push(` height={${node.height}}`);
  // A slot image varies per instance, but `srcSet` would still describe the template's
  // picture — and the browser prefers `srcSet` over `src`, so every instance would show
  // the first one's image. Without a responsive set for the incoming URL, `src` has to
  // stand alone.
  if (!slot) {
    if (node.srcset) attrs.push(strAttr("srcSet", node.srcset));
    if (node.sizes) attrs.push(strAttr("sizes", node.sizes));
  }
  if (node.priority) attrs.push(` priority`);
  return `<Image${classProp(node, ctx)}${motionAttr(node)}${attrs.join("")} />`;
}

function renderSvg(node: IRSvg, ctx: JsxContext): string {
  // Inline SVG kept verbatim via a transparent wrapper so React needn't camelCase attrs.
  const slot = ctx.slots?.get(node.id);
  const markup = slot ? `props.${slot.name}` : JSON.stringify(node.svg);
  return `<span${classProp(node, ctx)}${motionAttr(node)} data-framecoded-svg="true" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ${markup} }} />`;
}

/** A valid React component name for a page's route wrapper, e.g. "Home" -> "HomeRoute". */
export function jsxRouteComponentName(pageName: string): string {
  const base = pageName.replace(/[^A-Za-z0-9]/g, "") || "Page";
  const safe = /^[A-Za-z]/.test(base) ? base : "Page" + base;
  return `${safe}Route`;
}

function escapeJsxText(s: string): string {
  // In JSX text, only { } < > & need care; wrap in expression to be safe for braces.
  if (/[{}<>]/.test(s)) return `{${JSON.stringify(s)}}`;
  return s.replace(/&/g, "&amp;");
}
