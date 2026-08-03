/**
 * Read a page the way a browser sees it.
 *
 * The static adapter re-implements the CSS cascade: it matches every selector against a
 * parsed DOM and sorts by specificity. That reproduction is where the remaining fidelity
 * bugs come from â€” Framer reuses one custom-property name (`--extracted-r6o4lv`) at many
 * scopes with different values, so the right colour depends on getting inheritance
 * exactly right, and content the runtime draws client-side isn't in the source at all.
 *
 * A browser already does all of this correctly. So instead of deriving computed values,
 * this module asks for them: it loads the page, waits for the runtime to settle, and
 * reads `getComputedStyle()` off the live DOM.
 */
import { chromium, type Browser, type Page } from "playwright-core";
import { log } from "../../util/log.js";

/** A DOM element reduced to what codegen needs â€” no live references cross the bridge. */
export interface RenderedNode {
  tag: string;
  attrs: Record<string, string>;
  /** Declarations that differ from the tag's default (or, when inherited, from the parent). */
  styles: Record<string, string>;
  /** Text content, only for elements whose children are all text. */
  text?: string;
  /** Raw markup for `<svg>`, kept verbatim. */
  svg?: string;
  /** `::before` / `::after` declarations, where the element actually has one. */
  pseudo?: Record<string, Record<string, string>>;
  /**
   * Where the browser actually put the box. Never emitted as CSS â€” it exists so that
   * structural decisions can use what the stylesheet doesn't say, such as which words
   * of a split heading shared a line.
   */
  rect?: { top: number; left: number; width: number; height: number };
  /** Web Animations API calls Framer made for this exact element. */
  animations?: CapturedAnimation[];
  /** Stateful interaction owned by this node, when captured through an interaction probe. */
  interaction?: CapturedInteraction;
  children: RenderedNode[];
}

export interface CapturedAnimation {
  trigger: "load" | "in-view" | "tap" | "scroll";
  keyframes: unknown;
  options: Record<string, unknown>;
  source?: string;
  phase?: "open" | "close";
}

export interface CapturedInteraction {
  type: "toggle" | "hover";
  targets: Array<{
    id: string;
    closed: Record<string, string>;
    open: Record<string, string>;
    timings?: Record<string, { duration: number; delay: number; easing: string }>;
    openKeyframes?: Array<Record<string, string | number>>;
    closeKeyframes?: Array<Record<string, string | number>>;
    openDuration?: number;
    closeDuration?: number;
  }>;
  duration: number;
  easing: string;
}

export interface CapturedPage {
  url: string;
  /** Full HTML after hydration, for the existing head/meta extraction. */
  html: string;
  root: RenderedNode;
  /** Framer's shared `#svg-templates` block, if present. */
  svgSprite?: string;
  /** Global rules that cannot be represented per element, notably fonts and keyframes. */
  globalCss: string;
  /** Inherited body paint/type values omitted from descendants by design. */
  bodyStyles: Record<string, string>;
  nodeCount: number;
}

/**
 * Properties worth carrying into the output.
 *
 * `getComputedStyle` exposes several hundred; emitting them all would bury the design in
 * noise and bloat every CSS Module. This is the set that actually describes a Framer
 * layer's box, type and paint.
 */
const CAPTURED_PROPS = [
  // Box + layout
  "display", "position", "top", "right", "bottom", "left",
  "width", "height", "min-width", "max-width", "min-height", "max-height",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "box-sizing", "aspect-ratio", "overflow-x", "overflow-y", "z-index", "visibility",
  "appearance", "-webkit-appearance", "contain", "content-visibility", "isolation",
  "user-select", "-webkit-user-select", "touch-action", "accent-color", "caret-color",
  // Flex + grid
  "flex-direction", "flex-wrap", "flex-grow", "flex-shrink", "flex-basis",
  "justify-content", "align-items", "align-content", "align-self", "justify-self",
  "gap", "row-gap", "column-gap", "order",
  "grid-template-columns", "grid-template-rows", "grid-column", "grid-row", "place-content",
  // Typography
  "color", "font-family", "font-size", "font-weight", "font-style",
  "line-height", "letter-spacing", "text-align", "text-transform", "text-decoration-line",
  "text-decoration-color", "text-decoration-style", "text-underline-offset",
  "white-space", "word-break", "overflow-wrap", "text-overflow", "font-variant-numeric",
  "text-rendering", "-webkit-font-smoothing",
  "-webkit-text-fill-color", "-webkit-text-stroke-color", "-webkit-text-stroke-width",
  "-webkit-line-clamp", "-webkit-box-orient",
  // Paint
  "background-color", "background-image", "background-size", "background-position",
  "background-repeat", "background-clip", "-webkit-background-clip",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "border-top-left-radius", "border-top-right-radius",
  "border-bottom-left-radius", "border-bottom-right-radius",
  "outline-width", "outline-style", "outline-color",
  // Effects
  "box-shadow", "text-shadow", "opacity", "transform", "transform-origin",
  "filter", "backdrop-filter", "mix-blend-mode", "object-fit", "object-position",
  "mask-image", "clip-path", "cursor", "pointer-events",
  // Native interaction/animation declarations. WAAPI motion is captured separately.
  "transition-property", "transition-duration", "transition-delay", "transition-timing-function",
  "transition-behavior",
  "animation-name", "animation-duration", "animation-delay", "animation-timing-function",
  "animation-iteration-count", "animation-direction", "animation-fill-mode", "animation-play-state",
];

/**
 * Inherited properties are compared against the *parent*, not against a tag default.
 *
 * `color` on a heading inside a white-on-dark section legitimately equals its parent's;
 * emitting it on every descendant would repeat the same declaration hundreds of times.
 * Emitting it only where it changes reproduces exactly what the designer set.
 */
const INHERITED = new Set([
  "color", "font-family", "font-size", "font-weight", "font-style",
  "line-height", "letter-spacing", "text-align", "text-transform",
  "white-space", "word-break", "overflow-wrap", "visibility", "cursor",
  "text-shadow", "-webkit-text-fill-color", "font-variant-numeric",
]);

/**
 * Length-valued properties, read from the stylesheet rather than from the render.
 *
 * These are the ones `getComputedStyle` resolves against the current viewport. Taking
 * the used value freezes the layout at whatever width the page was rendered at, so a
 * centred navbar keeps the offset it happened to have and never moves again.
 */
const LAYOUT_PROPS = [
  "width", "height", "min-width", "max-width", "min-height", "max-height",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "top", "right", "bottom", "left",
  "flex-basis", "flex-grow", "flex-shrink",
  "gap", "row-gap", "column-gap", "position", "aspect-ratio",
  "transform", "transform-origin", "transform-box",
  "translate", "rotate", "scale",
  "perspective", "perspective-origin",
  "offset-path", "offset-distance", "offset-rotate", "offset-anchor", "offset-position",
  "grid-template-columns", "grid-template-rows", "grid-template-areas",
  "grid-auto-columns", "grid-auto-rows", "grid-auto-flow",
  "grid-column-start", "grid-column-end", "grid-row-start", "grid-row-end",
  "font-size", "line-height", "letter-spacing", "word-spacing", "text-indent", "vertical-align",
  "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "outline-width", "outline-offset", "column-width", "column-rule-width",
  "scroll-margin-top", "scroll-margin-right", "scroll-margin-bottom", "scroll-margin-left",
  "scroll-padding-top", "scroll-padding-right", "scroll-padding-bottom", "scroll-padding-left",
  "text-decoration-thickness", "text-underline-offset", "shape-margin", "stroke-width",
  "object-position", "background-position", "background-size",
  "mask-position", "mask-size", "-webkit-mask-position", "-webkit-mask-size",
];

/**
 * CSSOM cannot expand a shorthand whose value is an unresolved custom property.
 * Framer commonly emits `padding: var(--token)`, so querying `padding-top` on the
 * authored rule returns an empty string even though the computed padding is non-zero.
 * Preserve these shorthands directly and carry their referenced variables with them.
 */
const LAYOUT_SHORTHANDS = [
  "margin",
  "padding",
  "inset",
  "border-radius",
  "border-width",
  "scroll-margin",
  "scroll-padding",
];

const PSEUDO_SELECTORS = [
  "::before",
  "::after",
  "::marker",
  "::placeholder",
  "::first-letter",
  "::first-line",
  "::file-selector-button",
  "::selection",
  "::backdrop",
];

/**
 * What a decorative overlay needs to look the same â€” its paint, and the insets that
 * position it. `width`/`height` are deliberately absent: they resolve to the pixel size
 * of the box at render time, which pins the overlay instead of letting it stretch, and
 * a border drawn that way shows up as a stray line rather than an outline.
 */
const PSEUDO_PROPS = [
  "position", "top", "right", "bottom", "left",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "border-top-left-radius", "border-top-right-radius",
  "border-bottom-left-radius", "border-bottom-right-radius",
  "background-color", "background-image", "box-shadow", "opacity",
  "transform", "z-index", "pointer-events", "mix-blend-mode",
];

/** Advanced paint/compositing properties are easy to omit from a geometry-oriented list. */
const COMPLETE_CAPTURED_PROPS = [...new Set([
  ...CAPTURED_PROPS,
  "backdrop-filter", "-webkit-backdrop-filter",
  "mix-blend-mode", "background-blend-mode", "isolation",
  "mask-image", "mask-mode", "mask-repeat", "mask-position", "mask-size",
  "mask-origin", "mask-clip", "mask-composite",
  "-webkit-mask-image", "-webkit-mask-repeat", "-webkit-mask-position", "-webkit-mask-size",
  "-webkit-mask-origin", "-webkit-mask-clip", "-webkit-mask-composite",
  "clip-path", "clip-rule",
  "perspective", "perspective-origin", "transform-style", "transform-box", "backface-visibility",
  "offset-path", "offset-distance", "offset-rotate", "offset-anchor", "offset-position",
  "grid-template-columns", "grid-template-rows", "grid-template-areas",
  "grid-auto-columns", "grid-auto-rows", "grid-auto-flow",
  "grid-column-start", "grid-column-end", "grid-row-start", "grid-row-end",
  "font-size", "line-height", "letter-spacing", "word-spacing", "text-indent", "vertical-align",
  "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "outline-width", "outline-offset", "column-width", "column-rule-width",
  "scroll-margin-top", "scroll-margin-right", "scroll-margin-bottom", "scroll-margin-left",
  "scroll-padding-top", "scroll-padding-right", "scroll-padding-bottom", "scroll-padding-left",
  "text-decoration-thickness", "text-underline-offset", "shape-margin", "stroke-width",
  "object-position", "background-position", "background-size",
  "scroll-snap-type", "scroll-snap-align", "scroll-snap-stop",
  "overscroll-behavior", "overscroll-behavior-x", "overscroll-behavior-y",
  "shape-outside", "shape-margin", "image-rendering", "accent-color", "caret-color",
  "list-style-type", "list-style-position", "list-style-image",
])];
const COMPLETE_PSEUDO_PROPS = [...new Set([...PSEUDO_PROPS, ...COMPLETE_CAPTURED_PROPS])];

/** Values that carry no information â€” emitting them would only add noise. */
const PSEUDO_SKIP = ["none", "auto", "normal", "0px", "rgba(0, 0, 0, 0)", "0s", "static"];

/** Elements that are Framer's own chrome, never part of the design. */
const SKIP_TAGS = ["script", "style", "link", "meta", "noscript", "template", "head", "title"];

/**
 * Install before any site JavaScript. Framer uses Element.animate() for appear,
 * scroll-reveal, spring and ticker motion; recording the arguments keeps the exact
 * sampled spring curves instead of trying to infer them from one settled screenshot.
 */
const MOTION_CAPTURE_SCRIPT = `(function () {
  if (window.__framecodedMotionCaptureInstalled) return;
  window.__framecodedMotionCaptureInstalled = true;
  window.__framecodedMotionTrigger = "load";
  var NativeIntersectionObserver = window.IntersectionObserver;
  if (NativeIntersectionObserver) {
    window.IntersectionObserver = class FramecodedIntersectionObserver extends NativeIntersectionObserver {
      constructor(callback, options) {
        var wrappedCallback = function (entries, observer) {
          var now = performance.now();
          for (var e = 0; e < entries.length; e++) {
            if (!entries[e].isIntersecting) continue;
            var target = entries[e].target;
            if (!target.__framecodedIntersectionEntries) target.__framecodedIntersectionEntries = [];
            target.__framecodedIntersectionEntries.push({ time: now, scrollY: window.scrollY });
          }
          return callback(entries, observer);
        };
        super(wrappedCallback, options);
        var threshold = options && options.threshold;
        this.__framecodedOptions = {
          rootMargin: options && options.rootMargin ? String(options.rootMargin) : "0px",
          threshold: typeof threshold === "number" ? threshold : undefined,
          continuous: Array.isArray(threshold) && threshold.length > 8
        };
      }
      observe(target) {
        if (!target.__framecodedIntersectionOptions) target.__framecodedIntersectionOptions = [];
        target.__framecodedIntersectionOptions.push(this.__framecodedOptions);
        return super.observe(target);
      }
    };
  }

  function capturedViewOptions(element, includeContinuous) {
    var node = element, fallback, ancestorDepth = 0;
    while (node && node !== document.documentElement) {
      var list = node.__framecodedIntersectionOptions || [];
      for (var i = list.length - 1; i >= 0; i--) {
        var options = list[i];
        if (options.continuous && !includeContinuous) continue;
        if (options.continuous) {
          return {
            rootMargin: options.rootMargin,
            threshold: 0,
            ancestorDepth: ancestorDepth,
            entryTimes: (node.__framecodedIntersectionEntries || []).slice()
          };
        }
        if (typeof options.threshold === "number") {
          return {
            rootMargin: options.rootMargin,
            threshold: options.threshold,
            ancestorDepth: ancestorDepth,
            entryTimes: includeContinuous ? (node.__framecodedIntersectionEntries || []).slice() : undefined
          };
        }
        if (!fallback) fallback = {
          rootMargin: options.rootMargin,
          threshold: 0,
          ancestorDepth: ancestorDepth,
          entryTimes: includeContinuous ? (node.__framecodedIntersectionEntries || []).slice() : undefined
        };
      }
      node = node.parentElement;
      ancestorDepth++;
    }
    return fallback;
  }
  window.__framecodedCapturedViewOptions = capturedViewOptions;
  var nativeAnimate = Element.prototype.animate;

  function copy(value) {
    if (typeof value === "number" && !isFinite(value)) return String(value);
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.map(copy);
    if (typeof value === "object") {
      var out = {};
      for (var key in value) {
        try { out[key] = copy(value[key]); } catch (e) {}
      }
      return out;
    }
    return undefined;
  }

  Element.prototype.animate = function (keyframes, options) {
    var normalized = typeof options === "number" ? { duration: options } : (options || {});
    var interactionSource = window.__framecodedInteractionSource;
    var trigger = interactionSource ? "tap" : (window.__framecodedMotionTrigger === "in-view" ? "in-view" : "load");
    var capturedOptions = copy(normalized);
    if (trigger === "in-view") {
      var viewOptions = capturedViewOptions(this);
      if (viewOptions) capturedOptions.__framecodedView = viewOptions;
    }
    var record = {
      trigger: trigger,
      keyframes: copy(keyframes),
      options: capturedOptions,
      source: interactionSource || undefined,
      phase: interactionSource ? window.__framecodedInteractionPhase : undefined
    };
    if (!window.__framecodedIgnoreAnimationCapture) {
      if (!this.__framecodedAnimations) this.__framecodedAnimations = [];
      this.__framecodedAnimations.push(record);
    }
    return nativeAnimate.apply(this, arguments);
  };

  // Framer's layout projection and some perpetual effects bypass WAAPI and mutate
  // inline styles from requestAnimationFrame. Observe those writes from the first
  // script tick so they can be converted to ordinary sampled keyframes later.
  var TIMELINE_PROPS = [
    "transform", "opacity", "filter", "background-color", "background-position",
    "background-image", "background-size", "color", "box-shadow", "text-shadow",
    "border-color", "border-radius", "clip-path", "backdrop-filter", "-webkit-backdrop-filter",
    "mask-position", "mask-size", "-webkit-mask-position", "-webkit-mask-size",
    "translate", "rotate", "scale", "offset-distance", "offset-path",
    "fill", "stroke", "stroke-dasharray", "stroke-dashoffset",
    "width", "height", "top", "right", "bottom", "left"
  ];
  window.__framecodedCapturePreScrollBaseline = function () {
    var elements = document.querySelectorAll("*");
    for (var i = 0; i < elements.length; i++) {
      var element = elements[i], rect = element.getBoundingClientRect();
      if (rect.top < window.innerHeight && rect.bottom > 0) continue;
      var computed = getComputedStyle(element), values = {};
      for (var p = 0; p < TIMELINE_PROPS.length; p++) {
        var prop = TIMELINE_PROPS[p], value = computed.getPropertyValue(prop);
        if (value) values[prop] = value;
      }
      element.__framecodedPreScrollStyle = values;
    }
  };
  var lastValues = new WeakMap();
  var styleObserver = new MutationObserver(function (mutations) {
    if (window.__framecodedIgnoreStyleCapture) return;
    var changed = new Set();
    for (var i = 0; i < mutations.length; i++) {
      var target = mutations[i].target;
      if (target && target.nodeType === 1) changed.add(target);
    }
    changed.forEach(function (element) {
      var values = {}, signature = "";
      for (var p = 0; p < TIMELINE_PROPS.length; p++) {
        var prop = TIMELINE_PROPS[p];
        var value = element.style.getPropertyValue(prop);
        if (value) values[prop] = value;
        signature += prop + ":" + value + ";";
      }
      if (lastValues.get(element) === signature) return;
      lastValues.set(element, signature);
      var timeline = element.__framecodedStyleTimeline || (element.__framecodedStyleTimeline = []);
      // Retain the first state and the newest frames while bounding long-running pages.
      if (timeline.length >= 900) timeline.splice(1, 1);
      timeline.push({
        time: performance.now(),
        scrollY: window.scrollY,
        values: values,
        trigger: window.__framecodedMotionTrigger === "in-view" ? "in-view" : "load",
        source: window.__framecodedInteractionSource || undefined
      });
    });
  });
  styleObserver.observe(document, { subtree: true, attributes: true, attributeFilter: ["style"] });

  // Cursor portals may be mounted by an earlier hover candidate and retain their visible
  // variant for later owners. Preserve the first entrance of each portal structure from
  // page start, before the bounded per-owner probes can consume that one-time animation.
  var cursorTimelines = window.__framecodedCursorTimelines = [];
  var sampledCursorElements = new WeakSet(), lastPointer = null;
  window.addEventListener("pointermove", function (event) {
    lastPointer = { x: event.clientX, y: event.clientY };
  }, { passive: true });
  function cursorHash(value) {
    var hash = 2166136261;
    for (var i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    return (hash >>> 0).toString(36);
  }
  function cursorKey(element) {
    var rect = element.getBoundingClientRect();
    return [
      element.tagName,
      element.getAttribute("data-framer-name") || "",
      String(element.className || ""),
      Math.round(rect.width) + "x" + Math.round(rect.height),
      cursorHash(element.innerHTML || "")
    ].join("|");
  }
  window.__framecodedCursorKey = cursorKey;
  function cursorCandidate(element) {
    if (sampledCursorElements.has(element)) return false;
    var style = getComputedStyle(element), rect = element.getBoundingClientRect();
    if (style.position !== "fixed" || style.pointerEvents !== "none") return false;
    if (rect.width <= 0 || rect.height <= 0 || rect.width > 256 || rect.height > 256) return false;
    var named = /cursor|pointer-events-none/i.test(
      String(element.className || "") + " " + (element.getAttribute("data-framer-name") || "")
    );
    var nearPointer = lastPointer && Math.hypot(
      rect.left + rect.width / 2 - lastPointer.x,
      rect.top + rect.height / 2 - lastPointer.y
    ) <= 96;
    return named || nearPointer;
  }
  function sampleCursor(element) {
    if (!cursorCandidate(element)) return;
    sampledCursorElements.add(element);
    var record = { key: cursorKey(element), opacityFrames: [] }, signature = "";
    cursorTimelines.push(record);
    var started = performance.now();
    function tick(now) {
      if (element.isConnected) {
        var opacity = getComputedStyle(element).opacity;
        if (opacity !== signature) {
          signature = opacity;
          record.opacityFrames.push({ time: Math.max(0, now - started), opacity: opacity });
        }
      }
      if (now - started < 600) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
  function inspectCursorSubtree(node) {
    if (!node || node.nodeType !== 1) return;
    sampleCursor(node);
    var descendants = node.querySelectorAll("*");
    for (var i = 0; i < descendants.length; i++) sampleCursor(descendants[i]);
  }
  var cursorMountObserver = new MutationObserver(function (mutations) {
    var added = [];
    for (var i = 0; i < mutations.length; i++) {
      for (var j = 0; j < mutations[i].addedNodes.length; j++) added.push(mutations[i].addedNodes[j]);
    }
    if (!added.length) return;
    requestAnimationFrame(function () {
      for (var i = 0; i < added.length; i++) inspectCursorSubtree(added[i]);
    });
  });
  cursorMountObserver.observe(document, { subtree: true, childList: true });

  // Scroll-linked Motion values are sampled in a separate, deterministic pass after
  // one-shot in-view reveals have settled. Reading computed styles here also catches
  // transforms assembled from CSS variables rather than written directly inline.
  var scrollSignatures = new WeakMap();
  var contentSignatures = new WeakMap();
  function contentSnapshot(element) {
    var clone = element.cloneNode(true);
    var originals = element.querySelectorAll("*");
    var copies = clone.querySelectorAll("*");
    for (var i = 0; i < copies.length; i++) {
      var original = originals[i], copy = copies[i];
      var href = copy.tagName === "A" ? original.getAttribute("href") : null;
      var target = copy.tagName === "A" ? original.getAttribute("target") : null;
      var rel = copy.tagName === "A" ? original.getAttribute("rel") : null;
      var attributes = Array.prototype.slice.call(copy.attributes || []);
      for (var a = 0; a < attributes.length; a++) copy.removeAttribute(attributes[a].name);
      if (href && !/^javascript:/i.test(href)) copy.setAttribute("href", href);
      if (target) copy.setAttribute("target", target);
      if (rel) copy.setAttribute("rel", rel);
      if (copy.tagName !== "BR") {
        var style = getComputedStyle(original);
        copy.setAttribute(
          "style",
          "color:" + style.color +
            ";opacity:" + style.opacity +
            ";font-family:" + style.fontFamily +
            ";font-size:" + style.fontSize +
            ";font-weight:" + style.fontWeight +
            ";font-style:" + style.fontStyle +
            ";line-height:" + style.lineHeight +
            ";letter-spacing:" + style.letterSpacing +
            ";text-decoration-line:" + style.textDecorationLine +
            ";text-transform:" + style.textTransform +
            ";white-space:" + style.whiteSpace
        );
      }
    }
    var rootStyle = getComputedStyle(element);
    return {
      html: clone.innerHTML,
      color: rootStyle.color,
      opacity: rootStyle.opacity
    };
  }
  window.__framecodedResetScrollCapture = function () {
    scrollSignatures = new WeakMap();
    contentSignatures = new WeakMap();
    var elements = document.body ? document.body.querySelectorAll("*") : [];
    for (var i = 0; i < elements.length; i++) {
      elements[i].__framecodedScrollTimeline = [];
      elements[i].__framecodedContentTimeline = [];
    }
  };
  window.__framecodedRecordScrollFrame = function (followup) {
    if (!document.body) return;
    var recordedScroll = window.scrollY;
    var elements = document.body.querySelectorAll("*");
    for (var i = 0; i < elements.length; i++) {
      var element = elements[i];
      var style = getComputedStyle(element), values = {}, signature = "";
      for (var p = 0; p < TIMELINE_PROPS.length; p++) {
        var prop = TIMELINE_PROPS[p];
        var value = style.getPropertyValue(prop);
        values[prop] = value;
        signature += prop + ":" + value + ";";
      }
      if (scrollSignatures.get(element) !== signature) {
        scrollSignatures.set(element, signature);
        var timeline = element.__framecodedScrollTimeline || (element.__framecodedScrollTimeline = []);
        if (timeline.length >= 900) timeline.splice(1, 1);
        timeline.push({ scrollY: window.scrollY, values: values });
      }
      var tag = element.tagName;
      var richText = element.getAttribute("data-framer-component-type") === "RichTextContainer";
      if ((/^(P|H1|H2|H3|H4|H5|H6|LI|BUTTON|LABEL)$/.test(tag) || richText) && element.innerHTML.length <= 5000) {
        var rawContent = element.innerHTML;
        if (contentSignatures.get(element) !== rawContent) {
          contentSignatures.set(element, rawContent);
          var content = contentSnapshot(element);
          var contentTimeline = element.__framecodedContentTimeline || (element.__framecodedContentTimeline = []);
          if (contentTimeline.length >= 160) contentTimeline.splice(1, 1);
          contentTimeline.push({
            scrollY: window.scrollY,
            html: content.html,
            color: content.color,
            opacity: content.opacity
          });
        }
      }
    }
    if (!followup) {
      setTimeout(function () {
        if (Math.abs(window.scrollY - recordedScroll) < 0.5) {
          window.__framecodedRecordScrollFrame(true);
        }
      }, 32);
    }
  };
})()`;

/**
 * Runs inside the page. Written as a plain string so no build-time helper (esbuild's
 * `__name`, for one) can leak into a context that has never seen it.
 */
const EXTRACT_SCRIPT = `(function (config) {
  var CAPTURED = config.props, INHERITED = config.inherited, SKIP = config.skipTags;
  var LAYOUT = config.layout, LAYOUT_SHORTHANDS = config.layoutShorthands || [];
  var PSEUDO = config.pseudo, PSEUDO_PROPS = config.pseudoProps, PSEUDO_SKIP = config.pseudoSkip;
  var AUTHORED_PSEUDOS = {};
  function splitSelectorList(value) {
    var selectors = [], start = 0, round = 0, square = 0, quote = "", escaped = false;
    for (var i = 0; i < value.length; i++) {
      var ch = value[i];
      if (escaped) { escaped = false; continue; }
      if (ch.charCodeAt(0) === 92) { escaped = true; continue; }
      if (quote) { if (ch === quote) quote = ""; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === "(") { round++; continue; }
      if (ch === ")") { if (round) round--; continue; }
      if (ch === "[") { square++; continue; }
      if (ch === "]") { if (square) square--; continue; }
      if (ch === "," && !round && !square) {
        var selector = value.slice(start, i).trim();
        if (selector) selectors.push(selector);
        start = i + 1;
      }
    }
    var tail = value.slice(start).trim();
    if (tail) selectors.push(tail);
    return selectors;
  }
  function conditionalRuleMatches(rule) {
    if (typeof CSSSupportsRule !== "undefined" && rule instanceof CSSSupportsRule) {
      try { return CSS.supports(rule.conditionText || ""); } catch (error) { return false; }
    }
    return true;
  }
  function preserveReferencedVariables(styles, computed, value, seen) {
    seen = seen || {};
    var cursor = 0;
    while ((cursor = value.indexOf("var(", cursor)) !== -1) {
      var start = cursor + 4;
      while (start < value.length) {
        var whitespace = value.charCodeAt(start);
        if (whitespace !== 9 && whitespace !== 10 && whitespace !== 12 && whitespace !== 13 && whitespace !== 32) break;
        start++;
      }
      if (value.slice(start, start + 2) !== "--") { cursor = start; continue; }
      var end = start + 2;
      while (end < value.length) {
        var code = value.charCodeAt(end), character = value[end];
        if (code === 9 || code === 10 || code === 12 || code === 13 || code === 32 || character === "," || character === ")") break;
        end++;
      }
      var name = value.slice(start, end);
      if (name.length > 2 && !seen[name]) {
        seen[name] = true;
        var resolved = computed.getPropertyValue(name).trim();
        if (resolved) {
          styles[name] = resolved;
          preserveReferencedVariables(styles, computed, resolved, seen);
        }
      }
      cursor = end > cursor ? end : cursor + 4;
    }
  }
  for (var pseudoIndex = 0; pseudoIndex < PSEUDO.length; pseudoIndex++) AUTHORED_PSEUDOS[PSEUDO[pseudoIndex]] = [];

  function collectAuthoredPseudos(rules) {
    for (var ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
      var rule = rules[ruleIndex];
      if (rule.media) {
        try {
          if (window.matchMedia(rule.conditionText || rule.media.mediaText).matches) collectAuthoredPseudos(rule.cssRules);
        } catch (error) {}
        continue;
      }
      if (rule.cssRules && !rule.selectorText) {
        if (!conditionalRuleMatches(rule)) continue;
        try { collectAuthoredPseudos(rule.cssRules); } catch (error) {}
        continue;
      }
      if (!rule.selectorText) continue;
      var selectors = splitSelectorList(rule.selectorText);
      for (var selectorIndex = 0; selectorIndex < selectors.length; selectorIndex++) {
        var selector = selectors[selectorIndex].trim();
        for (var supportedIndex = 0; supportedIndex < PSEUDO.length; supportedIndex++) {
          var supported = PSEUDO[supportedIndex], position = selector.indexOf(supported);
          if (position < 0) continue;
          var base = selector.slice(0, position).trim() || "*";
          if (AUTHORED_PSEUDOS[supported].indexOf(base) === -1) AUTHORED_PSEUDOS[supported].push(base);
        }
      }
    }
  }
  for (var sheetIndex = 0; sheetIndex < document.styleSheets.length; sheetIndex++) {
    try { collectAuthoredPseudos(document.styleSheets[sheetIndex].cssRules); } catch (error) {}
  }

  function hasAuthoredPseudo(el, selector) {
    var matchers = AUTHORED_PSEUDOS[selector] || [];
    for (var matcherIndex = 0; matcherIndex < matchers.length; matcherIndex++) {
      try { if (el.matches(matchers[matcherIndex])) return true; } catch (error) {}
    }
    return false;
  }

  function specificity(sel) {
    var ids = (sel.match(/#[\\w-]+/g) || []).length;
    var cls = (sel.match(/\\.[\\w-]+|\\[[^\\]]+\\]|:[\\w-]+/g) || []).length;
    var els = (sel.match(/(^|[\\s>+~])[a-zA-Z][\\w-]*/g) || []).length;
    return ids * 10000 + cls * 100 + els;
  }

  // The *declared* value for a length, not the used one.
  //
  // getComputedStyle resolves everything to pixels, so "width: 100%" comes back as
  // "1200px" and the export freezes at the render width. Selector matching is done by
  // el.matches(), i.e. the browser's own matcher, so only the tiny cascade over a
  // handful of properties is ours â€” no re-implementation of matching.
  function declaredFor(el) {
    var out = {}, best = {};
    function take(rule, sel) {
      var score = specificity(sel);
      var properties = LAYOUT.concat(LAYOUT_SHORTHANDS);
      for (var p = 0; p < properties.length; p++) {
        var prop = properties[p];
        var v = rule.style.getPropertyValue(prop);
        if (!v) continue;
        var s = score + (rule.style.getPropertyPriority(prop) === "important" ? 1000000 : 0);
        if (best[prop] === undefined || s >= best[prop]) { best[prop] = s; out[prop] = v; }
      }
    }
    function scan(rules) {
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        if (r.media) {
          try { if (window.matchMedia(r.conditionText || r.media.mediaText).matches) scan(r.cssRules); } catch (e) {}
          continue;
        }
        if (r.cssRules && !r.selectorText) {
          if (!conditionalRuleMatches(r)) continue;
          try { scan(r.cssRules); } catch (e) {}
          continue;
        }
        if (!r.selectorText) continue;
        var sels = splitSelectorList(r.selectorText);
        for (var s = 0; s < sels.length; s++) {
          var sel = sels[s].trim();
          var ok = false;
          try { ok = el.matches(sel); } catch (e) { ok = false; }
          if (ok) take(r, sel);
        }
      }
    }
    for (var i = 0; i < document.styleSheets.length; i++) {
      try { scan(document.styleSheets[i].cssRules); } catch (e) { /* cross-origin */ }
    }
    // An inline style beats every rule.
    var inlineProperties = LAYOUT.concat(LAYOUT_SHORTHANDS);
    for (var p = 0; p < inlineProperties.length; p++) {
      var inlineProperty = inlineProperties[p];
      var v = el.style.getPropertyValue(inlineProperty);
      if (v) out[inlineProperty] = v;
    }
    return out;
  }

  // Capture direct interactive states such as .button:hover. Descendant-triggered
  // selectors (.card:hover .icon) are skipped because rewriting them as .icon:hover
  // would change the interaction's hit target.
  function interactivePseudosFor(el) {
    var out = {}, best = {};
    var DYNAMIC = /:(hover|focus-visible|focus|active)\\b/g;
    function scan(rules) {
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        if (rule.media) {
          try { if (window.matchMedia(rule.conditionText || rule.media.mediaText).matches) scan(rule.cssRules); } catch (e) {}
          continue;
        }
        if (rule.cssRules && !rule.selectorText) {
          if (!conditionalRuleMatches(rule)) continue;
          try { scan(rule.cssRules); } catch (e) {}
          continue;
        }
        if (!rule.selectorText || !rule.style) continue;
        var selectors = splitSelectorList(rule.selectorText);
        for (var s = 0; s < selectors.length; s++) {
          var selector = selectors[s].trim();
          var matches = Array.from(selector.matchAll(DYNAMIC));
          if (!matches.length) continue;
          var lastBoundary = Math.max(selector.lastIndexOf(" "), selector.lastIndexOf(">"), selector.lastIndexOf("+"), selector.lastIndexOf("~"));
          if (matches.some(function (m) { return (m.index || 0) < lastBoundary; })) continue;
          var plain = selector.replace(DYNAMIC, "");
          var ok = false;
          try { ok = el.matches(plain); } catch (e) {}
          if (!ok) continue;
          var score = specificity(selector);
          for (var m = 0; m < matches.length; m++) {
            var pseudo = ":" + matches[m][1];
            if (!out[pseudo]) { out[pseudo] = {}; best[pseudo] = {}; }
            for (var d = 0; d < rule.style.length; d++) {
              var prop = rule.style[d], value = rule.style.getPropertyValue(prop);
              if (!value || prop === "will-change" || prop === "--framer-will-change-override") continue;
              var weight = score + (rule.style.getPropertyPriority(prop) === "important" ? 1000000 : 0);
              if (best[pseudo][prop] === undefined || weight >= best[pseudo][prop]) {
                best[pseudo][prop] = weight;
                out[pseudo][prop] = value + (rule.style.getPropertyPriority(prop) === "important" ? " !important" : "");
              }
            }
          }
        }
      }
    }
    for (var i = 0; i < document.styleSheets.length; i++) {
      try { scan(document.styleSheets[i].cssRules); } catch (e) {}
    }
    return out;
  }

  function pseudoSpecificity(selector) {
    var withoutWhere = selector.replace(/:where\([^)]*\)/g, "");
    var ids = (withoutWhere.match(/#[\\w-]+/g) || []).length;
    var classLike = (withoutWhere.match(/\.[\\w-]+|\[[^\]]+\]|:(?!:)[\\w-]+(?:\([^)]*\))?/g) || []).length;
    var typeLike = (withoutWhere
      .replace(/#[\\w-]+|\.[\\w-]+|\[[^\]]+\]|::?[\\w-]+(?:\([^)]*\))?/g, " ")
      .match(/(^|[>+~\\s])(?:[a-zA-Z][\\w-]*|\\*)/g) || []).length;
    return ids * 1000000 + classLike * 1000 + typeLike;
  }

  function declaredPseudoFor(el, pseudoSelector) {
    var out = {}, best = {}, order = 0;

    function consider(rule) {
      var selectors = splitSelectorList(rule.selectorText || "");
      for (var selectorIndex = 0; selectorIndex < selectors.length; selectorIndex++) {
        var selector = selectors[selectorIndex];
        var pseudoAt = selector.lastIndexOf(pseudoSelector);
        if (pseudoAt === -1 || selector.slice(pseudoAt + pseudoSelector.length).trim()) continue;
        var hostSelector = selector.slice(0, pseudoAt).trim() || "*";
        try { if (!el.matches(hostSelector)) continue; } catch (e) { continue; }
        var specificity = pseudoSpecificity(hostSelector);
        for (var propIndex = 0; propIndex < LAYOUT.length; propIndex++) {
          var prop = LAYOUT[propIndex];
          var value = rule.style.getPropertyValue(prop);
          if (!value) continue;
          var important = rule.style.getPropertyPriority(prop) === "important" ? 1 : 0;
          var previous = best[prop];
          if (previous && (previous.important > important ||
            (previous.important === important && previous.specificity > specificity) ||
            (previous.important === important && previous.specificity === specificity && previous.order > order))) continue;
          best[prop] = { important: important, specificity: specificity, order: order };
          out[prop] = value + (important ? " !important" : "");
        }
      }
      order++;
    }

    function walk(rules) {
      if (!rules) return;
      for (var ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
        var rule = rules[ruleIndex];
        if (rule.type === 1) { consider(rule); continue; }
        if (rule.type === 4 && window.matchMedia && !window.matchMedia(rule.conditionText).matches) continue;
        if (rule.type === 12 && window.CSS && CSS.supports && !CSS.supports(rule.conditionText)) continue;
        if (rule.cssRules) walk(rule.cssRules);
        else if (rule.styleSheet) {
          try { walk(rule.styleSheet.cssRules); } catch (e) {}
        }
      }
    }

    for (var sheetIndex = 0; sheetIndex < document.styleSheets.length; sheetIndex++) {
      var sheet = document.styleSheets[sheetIndex];
      if (sheet.disabled) continue;
      if (sheet.media && sheet.media.mediaText && window.matchMedia && !window.matchMedia(sheet.media.mediaText).matches) continue;
      try { walk(sheet.cssRules); } catch (e) {}
    }
    return out;
  }

  function materializeInteractivePseudos(el, pseudos, baseline) {
    var resolved = {};
    var originalStyle = el.getAttribute("style");
    for (var pseudo in pseudos) {
      var declarations = pseudos[pseudo];
      for (var prop in declarations) {
        var raw = declarations[prop];
        var important = /!important$/i.test(raw);
        var value = raw.replace(/ !important$/i, "");
        el.style.setProperty(prop, value, important ? "important" : "");
      }

      // Reading after the inline override delegates var() inheritance, fallbacks,
      // shorthands and color-space conversion to the browser that rendered Framer.
      var computed = getComputedStyle(el), delta = {};
      for (var i = 0; i < CAPTURED.length; i++) {
        var capturedProp = CAPTURED[i];
        var computedValue = computed.getPropertyValue(capturedProp);
        if (computedValue && computedValue !== baseline[capturedProp]) delta[capturedProp] = computedValue;
      }
      if (Object.keys(delta).length) resolved[pseudo] = delta;

      if (originalStyle === null) el.removeAttribute("style");
      else el.setAttribute("style", originalStyle);
    }
    return resolved;
  }

  function collectGlobalCss() {
    var chunks = [], seen = {};
    function scan(rules) {
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i], text = rule.cssText || "";
        if (/^@(font-face|(?:-webkit-)?keyframes|property)\\b/i.test(text)) {
          if (!seen[text]) { seen[text] = true; chunks.push(text); }
        } else if (rule.cssRules) {
          try { scan(rule.cssRules); } catch (e) {}
        }
      }
    }
    for (var i = 0; i < document.styleSheets.length; i++) {
      try { scan(document.styleSheets[i].cssRules); } catch (e) {}
    }
    return chunks.join("\\n\\n");
  }

  // One reference element per tag, rendered but invisible, to learn each tag's defaults.
  var sandbox = document.createElement("div");
  sandbox.setAttribute("style", "position:absolute!important;left:-99999px!important;top:0!important;visibility:hidden!important;contain:strict");
  document.body.appendChild(sandbox);
  var defaultsByTag = {};
  function defaultsFor(tag) {
    if (defaultsByTag[tag]) return defaultsByTag[tag];
    var probe;
    try { probe = document.createElement(tag); } catch (e) { probe = document.createElement("div"); }
    sandbox.appendChild(probe);
    var cs = getComputedStyle(probe);
    var map = {};
    for (var i = 0; i < CAPTURED.length; i++) map[CAPTURED[i]] = cs.getPropertyValue(CAPTURED[i]);
    sandbox.removeChild(probe);
    defaultsByTag[tag] = map;
    return map;
  }

  function isChrome(el) {
    var tag = el.tagName.toLowerCase();
    if (SKIP.indexOf(tag) !== -1) return true;
    var id = el.id || "";
    var cls = typeof el.className === "string" ? el.className : "";
    if (id === "__framer-badge-container" || id === "svg-templates") return true;
    if (id.indexOf("__framer-editorbar") === 0 || el.querySelector("#__framer-editorbar-button")) return true;
    if (cls.indexOf("framer-badge") !== -1) return true;
    return false;
  }

  function attrsOf(el) {
    var out = {};
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (a.name === "class" || a.name === "style") continue;
      out[a.name] = a.value;
    }
    return out;
  }

  function onlyText(el) {
    if (!el.childNodes.length) return false;
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType !== 3) return false;
    }
    // Deliberately not trimmed: Framer emits the space between two words of a split
    // heading as its own element, and requiring visible text discards exactly those.
    return (el.textContent || "").length > 0;
  }

  function serializeSvg(el) {
    var clone = el.cloneNode(true);
    var originals = [el].concat(Array.from(el.querySelectorAll("*")));
    var copies = [clone].concat(Array.from(clone.querySelectorAll("*")));
    var paint = [
      "fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity",
      "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "vector-effect",
      "paint-order", "shape-rendering", "stop-color", "stop-opacity", "flood-color",
      "clip-path", "mask-image", "opacity", "transform", "transform-origin",
      "font-family", "font-size", "font-weight"
    ];
    var defaults = {
      "fill-opacity": "1", "stroke": "none", "stroke-opacity": "1",
      "stroke-linecap": "butt", "stroke-linejoin": "miter", "stroke-dasharray": "none",
      "vector-effect": "none", "paint-order": "normal", "shape-rendering": "auto",
      "stop-opacity": "1", "clip-path": "none", "mask-image": "none",
      "opacity": "1", "transform": "none"
    };

    for (var i = 0; i < copies.length; i++) {
      var source = originals[i], target = copies[i];
      if (!source || !target) continue;
      target.removeAttribute("class");
      var attrs = Array.from(target.attributes || []);
      for (var a = 0; a < attrs.length; a++) {
        var name = attrs[a].name.toLowerCase();
        if (name.indexOf("data-framer") === 0 || name === "data-styles-preset") target.removeAttribute(attrs[a].name);
      }
      // The wrapper receives the root SVG's captured box/effect styles. Keeping them
      // inside the injected SVG too would apply transforms and opacity twice.
      if (i === 0) target.removeAttribute("style");
      var style = target.style;
      if (!style) continue;
      for (var old = style.length - 1; old >= 0; old--) {
        var oldName = style[old];
        if (oldName.indexOf("--") === 0 || oldName === "will-change") style.removeProperty(oldName);
      }
      var computed = getComputedStyle(source);
      for (var p = 0; p < paint.length; p++) {
        var prop = paint[p], value = computed.getPropertyValue(prop);
        if (i === 0 && (prop === "opacity" || prop === "transform" || prop === "transform-origin")) continue;
        if (!value || defaults[prop] === value) continue;
        style.setProperty(prop, value);
      }
    }
    return clone.outerHTML;
  }

  function animationProperties(records) {
    var out = {};
    function takeFrames(frames) {
      if (Array.isArray(frames)) {
        for (var i = 0; i < frames.length; i++) {
          var frame = frames[i] || {};
          for (var key in frame) if (key !== "offset" && key !== "easing" && key !== "composite") out[key] = true;
        }
      } else if (frames && typeof frames === "object") {
        for (var key in frames) if (key !== "offset" && key !== "easing" && key !== "composite") out[key] = true;
      }
    }
    for (var i = 0; i < records.length; i++) takeFrames(records[i].keyframes);
    return out;
  }

  function downsample(samples, limit) {
    if (samples.length <= limit) return samples;
    var out = [];
    for (var i = 0; i < limit; i++) {
      out.push(samples[Math.round((samples.length - 1) * i / (limit - 1))]);
    }
    return out;
  }

  function sampledStyleAnimations(el, nativeRecords, skipTimeline) {
    if (skipTimeline) return [];
    var timeline = (el.__framecodedStyleTimeline || []).filter(function (entry) { return !entry.source; });
    if (timeline.length < 3) return [];
    var already = animationProperties(nativeRecords);
    var props = {};
    for (var i = 0; i < timeline.length; i++) {
      for (var prop in timeline[i].values) props[prop] = true;
    }

    var result = [], now = performance.now();
    for (var prop in props) {
      if (already[prop]) continue;
      var samples = [], previous;
      for (var i = 0; i < timeline.length; i++) {
        var value = timeline[i].values[prop];
        if (!value || value === previous) continue;
        previous = value;
        samples.push({
          time: timeline[i].time,
          scrollY: timeline[i].scrollY,
          value: value,
          trigger: timeline[i].trigger
        });
      }
      if (samples.length < 3) continue;

      var capturedViewport = window.__framecodedCapturedViewOptions &&
        window.__framecodedCapturedViewOptions(el, true);
      var entryTimes = capturedViewport && capturedViewport.entryTimes || [];
      var matchedEntry = null, matchedSample = -1;
      for (var entryIndex = 0; entryIndex < entryTimes.length; entryIndex++) {
        for (var sampleIndex = 1; sampleIndex < samples.length; sampleIndex++) {
          if (samples[sampleIndex].time < entryTimes[entryIndex].time) continue;
          if (samples[sampleIndex].time - entryTimes[entryIndex].time > 1000) break;
          matchedEntry = entryTimes[entryIndex];
          matchedSample = sampleIndex;
          break;
        }
      }
      if (matchedEntry && matchedSample > 0) {
        samples = [{
          time: matchedEntry.time,
          scrollY: matchedEntry.scrollY,
          value: samples[matchedSample - 1].value,
          trigger: "in-view"
        }].concat(samples.slice(matchedSample));
      }

      // An initial hidden state is commonly written during hydration, then left alone
      // until IntersectionObserver starts the reveal. Treat the long idle gap as the
      // trigger boundary instead of replaying the reveal during page load.
      var splitAt = -1;
      for (var s = 1; s < samples.length; s++) {
        if (samples[s].trigger === "in-view" && samples[s].time - samples[s - 1].time > 400) {
          splitAt = s;
        }
      }
      if (splitAt > 0) {
        var firstChange = samples[splitAt];
        samples = [{
          time: Math.max(samples[splitAt - 1].time, firstChange.time - 16),
          scrollY: firstChange.scrollY,
          value: samples[splitAt - 1].value,
          trigger: "in-view"
        }].concat(samples.slice(splitAt));
      }

      // MutationObserver runs after Framer has written the first spring frame. For an
      // offscreen reveal that frame can already be opacity .02 / translateY(39px), and
      // fill: both would expose it before IntersectionObserver fires in the export.
      // Use the computed state captured before the scroll probe as the exact first frame.
      var preScrollStyle = el.__framecodedPreScrollStyle;
      if (samples[0].trigger === "in-view" && preScrollStyle && preScrollStyle[prop] !== undefined) {
        samples[0].value = preScrollStyle[prop];
      }

      var distinct = {};
      for (var d = 0; d < samples.length; d++) distinct[samples[d].value] = true;
      if (Object.keys(distinct).length < 2) continue;

      samples = downsample(samples, 80);
      var start = samples[0].time, end = samples[samples.length - 1].time;
      var duration = Math.max(16, end - start);
      var frames = samples.map(function (sample) {
        var frame = { offset: duration ? (sample.time - start) / duration : 1 };
        frame[prop] = sample.value;
        return frame;
      });
      var animationTrigger = samples[0].trigger === "in-view" ? "in-view" : "load";
      var options = {
        duration: duration,
        easing: "linear",
        fill: "both",
        iterations: now - end < 350 && duration > 350 ? "Infinity" : 1
      };
      if (animationTrigger === "in-view" && isFinite(Number(samples[0].scrollY))) {
        var viewportOptions = capturedViewport ? {
          rootMargin: capturedViewport.rootMargin,
          threshold: capturedViewport.threshold,
          ancestorDepth: capturedViewport.ancestorDepth
        } : null;
        options.__framecodedView = viewportOptions || {
          startProgress: Math.max(0, Math.min(1,
            Number(samples[0].scrollY) /
              Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
          ))
        };
      }
      result.push({
        trigger: animationTrigger,
        keyframes: frames,
        options: options
      });
    }
    var stableScrollAnimations = sampledScrollAnimations(el, skipTimeline);
    var scrollProps = {};
    for (var s = 0; s < stableScrollAnimations.length; s++) {
      var scrollFrames = stableScrollAnimations[s].keyframes || [];
      for (var f = 0; f < scrollFrames.length; f++) {
        for (var scrollProp in scrollFrames[f]) {
          if (scrollProp !== "offset" && scrollProp !== "easing" && scrollProp !== "composite") {
            scrollProps[scrollProp] = true;
          }
        }
      }
    }
    return result.filter(function (animation) {
      var frames = animation.keyframes || [];
      for (var i = 0; i < frames.length; i++) {
        for (var prop in frames[i]) {
          if (scrollProps[prop]) return false;
        }
      }
      return true;
    });
  }

  function layoutTop(el) {
    var top = 0, node = el;
    while (node) {
      top += Number(node.offsetTop || 0);
      node = node.offsetParent;
    }
    return top;
  }

  function sampledScrollAnimations(el, skipTimeline) {
    if (skipTimeline) return [];
    var contentAnimations = sampledScrollContentAnimations(el, false);
    var timeline = el.__framecodedScrollTimeline || [];
    if (timeline.length < 3) return contentAnimations;
    var props = {};
    for (var i = 0; i < timeline.length; i++) {
      for (var prop in timeline[i].values) props[prop] = true;
    }

    var result = [], top = layoutTop(el);
    var maximumScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    for (var prop in props) {
      var samples = [], valuesAtScroll = {}, unstable = false;
      for (var i = 0; i < timeline.length; i++) {
        var value = timeline[i].values[prop];
        if (value === undefined || value === null || value === "") continue;
        var scroll = Number(timeline[i].scrollY || 0);
        var key = String(scroll);
        if (valuesAtScroll[key] !== undefined && valuesAtScroll[key] !== value) unstable = true;
        valuesAtScroll[key] = value;
        if (samples.length && samples[samples.length - 1].scroll === scroll) {
          samples[samples.length - 1].value = value;
        } else {
          samples.push({ scroll: scroll, value: value });
        }
      }
      // A property that changes while scrollY is stationary is time-driven, not a
      // scroll MotionValue. It is already handled by native/style timeline capture.
      if (unstable || samples.length < 3) continue;

      var firstChange = -1, lastChange = -1;
      for (var s = 1; s < samples.length; s++) {
        if (samples[s].value !== samples[s - 1].value) {
          if (firstChange < 0) firstChange = s;
          lastChange = s;
        }
      }
      if (firstChange < 0) continue;
      samples = samples.slice(Math.max(0, firstChange - 1), lastChange + 1);
      var distinct = {};
      for (var d = 0; d < samples.length; d++) distinct[samples[d].value] = true;
      if (Object.keys(distinct).length < 2) continue;

      samples = downsample(samples, 80);
      var start = samples[0].scroll, end = samples[samples.length - 1].scroll;
      if (end - start < 2) continue;
      var frames = samples.map(function (sample) {
        var frame = { offset: (sample.scroll - start) / (end - start) };
        frame[prop] = sample.value;
        return frame;
      });
      result.push({
        trigger: "scroll",
        keyframes: frames,
        options: {
          duration: 1000,
          easing: "linear",
          fill: "both",
          iterations: 1,
          __framecodedScroll: {
            startProgress: start / maximumScroll,
            endProgress: end / maximumScroll,
            startOffset: start - top,
            endOffset: end - top
          }
        }
      });
    }
    return result.concat(contentAnimations);
  }

  function sampledScrollContentAnimations(el, skipTimeline) {
    if (skipTimeline) return [];
    var timeline = el.__framecodedContentTimeline || [];
    if (timeline.length < 2) return [];
    var byScroll = {}, unstable = false;
    for (var i = 0; i < timeline.length; i++) {
      var sample = timeline[i];
      var scroll = Number(sample.scrollY || 0);
      var key = String(scroll);
      var signature = String(sample.html || "") + "|" + String(sample.color || "") + "|" + String(sample.opacity || "");
      if (byScroll[key] && byScroll[key].signature !== signature) unstable = true;
      if (!byScroll[key]) byScroll[key] = {
        scroll: scroll,
        signature: signature,
        html: String(sample.html || ""),
        color: String(sample.color || ""),
        opacity: String(sample.opacity || "")
      };
    }
    if (unstable) return [];
    var samples = Object.keys(byScroll).map(function (key) { return byScroll[key]; });
    samples.sort(function (a, b) { return a.scroll - b.scroll; });
    var states = [];
    for (var i = 0; i < samples.length; i++) {
      if (states.length && states[states.length - 1].signature === samples[i].signature) continue;
      states.push(samples[i]);
    }
    if (states.length < 2) return [];
    var maximumScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    return [{
      trigger: "scroll",
      keyframes: [{}],
      options: {
        duration: 1000,
        easing: "linear",
        fill: "both",
        iterations: 1,
        __framecodedContent: {
          samples: states.map(function (state) {
            return {
              progress: Math.max(0, Math.min(1, state.scroll / maximumScroll)),
              html: state.html,
              color: state.color,
              opacity: state.opacity
            };
          })
        }
      }
    }];
  }

  var count = 0;
  function walk(el, parentStyle) {
    var tag = el.tagName.toLowerCase();
    var cs = getComputedStyle(el);

    // An element the browser doesn't render contributes nothing to the design.
    if (cs.display === "none") return null;

    var defaults = defaultsFor(tag);
    var declared = declaredFor(el);
    var styles = {};
    // Shorthands must be emitted before their longhands so an explicitly authored
    // side-specific value can still override the shorthand in the generated rule.
    for (var shorthandIndex = 0; shorthandIndex < LAYOUT_SHORTHANDS.length; shorthandIndex++) {
      var shorthand = LAYOUT_SHORTHANDS[shorthandIndex];
      if (!declared[shorthand]) continue;
      styles[shorthand] = declared[shorthand];
      preserveReferencedVariables(styles, cs, declared[shorthand]);
    }
    for (var i = 0; i < CAPTURED.length; i++) {
      var p = CAPTURED[i];
      // Lengths come from what the author wrote. If nothing declared one, the element
      // was sized by its content or its parent â€” emitting the used pixel value there is
      // exactly what pins the layout to the render width.
      if (LAYOUT.indexOf(p) !== -1) {
        if (declared[p]) {
          styles[p] = declared[p];
          preserveReferencedVariables(styles, cs, declared[p]);
        }
        continue;
      }
      var v = cs.getPropertyValue(p);
      if (!v) continue;
      var baseline = INHERITED.indexOf(p) !== -1
        ? (parentStyle ? parentStyle[p] : defaults[p])
        : defaults[p];
      if (v !== baseline) styles[p] = v;
    }

    var own = {};
    for (var j = 0; j < CAPTURED.length; j++) own[CAPTURED[j]] = cs.getPropertyValue(CAPTURED[j]);

    // Framer draws a layer's border with an ::after overlay rather than a border on the
    // box itself, so a card without its pseudo-element loses its outline entirely.
    var pseudo = materializeInteractivePseudos(el, interactivePseudosFor(el), own);
    for (var q = 0; q < PSEUDO.length; q++) {
      var sel = PSEUDO[q];
      var ps;
      try { ps = getComputedStyle(el, sel); } catch (e) { continue; }
      if (!ps) continue;
      var content = ps.getPropertyValue("content");
      var generatedContent = sel === "::before" || sel === "::after";
      var materialContent = content && content !== "none" && content !== "normal";
      if (generatedContent ? !materialContent : !hasAuthoredPseudo(el, sel)) continue;
      var pd = {};
      var pseudoDeclared = declaredPseudoFor(el, sel);
      for (var z = 0; z < PSEUDO_PROPS.length; z++) {
        var pp = PSEUDO_PROPS[z];
        if (LAYOUT.indexOf(pp) !== -1) {
          if (pseudoDeclared[pp]) {
            pd[pp] = pseudoDeclared[pp];
            preserveReferencedVariables(pd, ps, pseudoDeclared[pp]);
          } else if (pp === "border-top-width" || pp === "border-right-width" || pp === "border-bottom-width" || pp === "border-left-width") {
            var computedBorderWidth = ps.getPropertyValue(pp);
            if (computedBorderWidth) pd[pp] = computedBorderWidth;
          }
          continue;
        }
        var pv = ps.getPropertyValue(pp);
        if (pp === "pointer-events" && pv === "none") { pd[pp] = pv; continue; }
        if (!pv || PSEUDO_SKIP.indexOf(pv) !== -1) continue;
        pd[pp] = pv;
      }
      if (materialContent) pd["content"] = content;
      if (Object.keys(pd).length) pseudo[sel] = pd;
    }

    count++;
    var box = el.getBoundingClientRect();
    var node = { tag: tag, attrs: attrsOf(el), styles: styles, children: [],
      rect: { top: Math.round(box.top + window.scrollY), left: Math.round(box.left),
              width: Math.round(box.width), height: Math.round(box.height) } };
    var classText = typeof el.className === "string" ? el.className : "";
    var inlineText = el.getAttribute("style") || "";
    var followsPointer = el.getAttribute("data-framecoded-cursor") === "true" || cs.position === "fixed" && (
      classText.indexOf("framer-cursor") !== -1 ||
      (classText.indexOf("framer-pointer-events-none") !== -1 && /translate[XY]\\(/.test(inlineText))
    );
    if (followsPointer) {
      node.attrs["data-framecoded-cursor"] = "true";
      // A computed matrix contains the extraction mouse coordinates. Starting in the
      // viewport centre avoids exporting that arbitrary sampled position.
      node.styles["transform"] = "translate(-50%, -50%) translate3d(50vw, 50vh, 0)";
      // Framer keeps the follower hidden until it has a real pointer coordinate.
      node.styles["opacity"] = "0";
    }
    if (Object.keys(pseudo).length) node.pseudo = pseudo;
    var nativeAnimations = el.__framecodedAnimations || [];
    var sampledAnimations = sampledStyleAnimations(el, nativeAnimations, followsPointer);
    var scrollAnimations = sampledScrollAnimations(el, followsPointer);
    if (nativeAnimations.length || sampledAnimations.length || scrollAnimations.length) {
      node.animations = nativeAnimations.concat(sampledAnimations, scrollAnimations);
    }
    if (el.__framecodedInteraction) node.interaction = el.__framecodedInteraction;

    if (tag === "svg") { node.svg = serializeSvg(el); return node; }
    if (onlyText(el)) {
      var rawText = el.textContent || "";
      var computedText = getComputedStyle(el);
      var whiteSpace = computedText.whiteSpace || "normal";
      var whiteSpaceCollapse = computedText.whiteSpaceCollapse || "collapse";
      if (/^(pre|pre-wrap|break-spaces)$/.test(whiteSpace) || /^(preserve|break-spaces)$/.test(whiteSpaceCollapse)) {
        node.text = rawText;
      } else if (whiteSpace === "pre-line" || whiteSpaceCollapse === "preserve-breaks") {
        node.text = rawText.split(/\\r?\\n/).map(function (line) {
          return line.replace(/[ \\t\\f]+/g, " ");
        }).join("\\n");
      } else {
        // Do not use \\s here: it includes NBSP and other semantic Unicode separators.
        node.text = rawText.replace(/[ \\t\\r\\n\\f]+/g, " ");
      }
      return node;
    }

    // Walk *childNodes*, not children: the whitespace between inline elements lives in
    // text nodes, and skipping them concatenates a heading's words into one run
    // ("Websites that guide users" becomes "Websitesthatguideusers").
    for (var k = 0; k < el.childNodes.length; k++) {
      var child = el.childNodes[k];
      if (child.nodeType === 3) {
        var raw = (child.nodeValue || "").replace(/\\s+/g, " ");
        // Keep whitespace-only runs. Framer splits animated headings into one element
        // per letter, and the spaces between words are exactly these nodes â€” dropping
        // them renders "Websitesthatguideusers".
        if (raw) node.children.push({ tag: "#text", attrs: {}, styles: {}, text: raw, children: [] });
        continue;
      }
      if (child.nodeType !== 1 || isChrome(child)) continue;
      var c = walk(child, own);
      if (c) node.children.push(c);
    }

    // Direct text nodes were already collected above. Do not fall back to the parent's
    // full textContent here: it includes text inside intentionally skipped <style>,
    // <script> and <noscript> children and would render source code on the page.
    return node;
  }

  var sprite = document.getElementById("svg-templates");
  var spriteHtml = sprite ? sprite.innerHTML.trim() : "";

  var bodyStyle = {};
  var bcs = getComputedStyle(document.body);
  for (var m = 0; m < CAPTURED.length; m++) bodyStyle[CAPTURED[m]] = bcs.getPropertyValue(CAPTURED[m]);

  var roots = [];
  for (var n = 0; n < document.body.children.length; n++) {
    var top = document.body.children[n];
    if (isChrome(top) || top === sandbox) continue;
    var r = walk(top, bodyStyle);
    if (r) roots.push(r);
  }
  sandbox.remove();

  return { roots: roots, sprite: spriteHtml, count: count, globalCss: collectGlobalCss(), bodyStyles: bodyStyle };
})`;

/**
 * Probe Framer toggle components while its runtime is still available. The target page's
 * FAQ changes height, visibility, icon rotation and divider paint, but only the divider
 * goes through Element.animate(); computed-state snapshots preserve the rest.
 */
const TOGGLE_CAPTURE_SCRIPT = `(async function (props) {
  var stateSequence = 0, triggerSequence = 0, seenOwners = [];
  var buttons = Array.from(document.querySelectorAll("button, [role='button'], [tabindex], [data-framer-name]")).filter(function (button) {
    if (button.id === "__framer-editorbar-button" || button.closest(".__framer-badge")) return false;
    if (button.tagName === "A" || button.closest("a") || button.closest("form")) return false;
    var rect = button.getBoundingClientRect(), cs = getComputedStyle(button);
    var name = button.getAttribute("data-framer-name") || "";
    var semantic = button.tagName === "BUTTON" || button.getAttribute("role") === "button";
    var namedTap = /icon|burger|toggle|accordion|faq|open|close/i.test(name);
    var keyboardTap = button.hasAttribute("tabindex") && Number(button.getAttribute("tabindex")) >= 0;
    return rect.width > 0 && rect.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" &&
      (semantic || (namedTap && (cs.cursor === "pointer" || keyboardTap)));
  });
  function depthOf(element) {
    var depth = 0;
    while (element && element !== document.body) { depth++; element = element.parentElement; }
    return depth;
  }
  buttons.sort(function (a, b) {
    var depth = depthOf(b) - depthOf(a);
    if (depth) return depth;
    var ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
    return ar.width * ar.height - br.width * br.height;
  });

  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function activate(element) {
    var rect = element.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    var down = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 1 };
    var up = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 0 };
    if (typeof PointerEvent !== "undefined") {
      element.dispatchEvent(new PointerEvent("pointerdown", Object.assign({ pointerId: 1, pointerType: "mouse", isPrimary: true }, down)));
    }
    element.dispatchEvent(new MouseEvent("mousedown", down));
    if (typeof PointerEvent !== "undefined") {
      element.dispatchEvent(new PointerEvent("pointerup", Object.assign({ pointerId: 1, pointerType: "mouse", isPrimary: true }, up)));
    }
    element.dispatchEvent(new MouseEvent("mouseup", up));
    element.dispatchEvent(new MouseEvent("click", up));
  }
  function ownerOf(button) {
    var node = button;
    while (node && node !== document.body) {
      var name = node.getAttribute("data-framer-name") || "";
      if (/^(open|close)$/i.test(name) || /accordion|faq|closed/i.test(name)) return node;
      node = node.parentElement;
    }
    return button;
  }
  function locatorOf(element) {
    var name = element.getAttribute("data-framer-name") || "";
    var aria = element.getAttribute("aria-label") || "";
    var text = (element.textContent || "").replace(/\s+/g, " ").trim();
    var rect = element.getBoundingClientRect();
    return { tag: element.tagName, name: name, aria: aria, text: text, x: rect.left, y: rect.top };
  }
  function resolveLocator(locator) {
    var candidates = Array.from(document.querySelectorAll(locator.tag)).filter(function (element) {
      var rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= window.innerHeight) return false;
      if (locator.name && element.getAttribute("data-framer-name") !== locator.name) return false;
      if (locator.aria && element.getAttribute("aria-label") !== locator.aria) return false;
      if (locator.text && (element.textContent || "").replace(/\s+/g, " ").trim() !== locator.text) return false;
      return true;
    });
    candidates.sort(function (a, b) {
      var ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
      return Math.abs(ar.left - locator.x) + Math.abs(ar.top - locator.y) -
        Math.abs(br.left - locator.x) - Math.abs(br.top - locator.y);
    });
    return candidates[0] || null;
  }
  function structuralPath(element) {
    var parts = [], node = element;
    while (node && node !== document.body) {
      var index = 0, sibling = node;
      while ((sibling = sibling.previousElementSibling)) index++;
      parts.push(index);
      node = node.parentElement;
    }
    return parts.reverse().join(".");
  }
  function elementAtPath(path) {
    if (!path) return null;
    var node = document.body, parts = path.split(".");
    for (var i = 0; node && i < parts.length; i++) node = node.children[Number(parts[i])];
    return node || null;
  }
  function identify(source) {
    var nodes = Array.from(document.body.querySelectorAll("*"));
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].__framecodedStatePath = structuralPath(nodes[i]);
      if (!nodes[i].hasAttribute("data-framecoded-state")) {
        nodes[i].setAttribute("data-framecoded-state", source + "s" + stateSequence++);
      }
    }
    return nodes;
  }
  function snapshot(nodes) {
    var out = {};
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!node.isConnected) continue;
      var id = node.getAttribute("data-framecoded-state");
      if (!id) continue;
      var cs = getComputedStyle(node), style = {};
      for (var p = 0; p < props.length; p++) {
        var value = cs.getPropertyValue(props[p]);
        if (value) style[props[p]] = value;
      }
      out[id] = style;
    }
    return out;
  }
  function timingOf(nodes, source) {
    for (var i = 0; i < nodes.length; i++) {
      var records = nodes[i].__framecodedAnimations || [];
      for (var j = records.length - 1; j >= 0; j--) {
        var record = records[j];
        if (record.source !== source || record.phase !== "open") continue;
        return {
          duration: Number(record.options.duration) || 500,
          easing: typeof record.options.easing === "string" ? record.options.easing : "ease"
        };
      }
    }
    return { duration: 500, easing: "cubic-bezier(.2,.8,.2,1)" };
  }

  var motionProps = props.filter(function (prop) {
    return /^(transform|translate|rotate|scale|opacity|filter|backdrop-filter|clip-path|width|height|min-width|min-height|max-width|max-height|left|right|top|bottom|inset|background-color|color|border.*(?:color|radius|width)|box-shadow|visibility)$/.test(prop);
  });
  var scrollPropertyCache = new WeakMap();
  function scrollProperties(node) {
    if (scrollPropertyCache.has(node)) return scrollPropertyCache.get(node);
    var timeline = node.__framecodedScrollTimeline || [], result = {};
    if (timeline.length >= 3) {
      for (var p = 0; p < motionProps.length; p++) {
        var prop = motionProps[p], byScroll = {}, values = {}, unstable = false;
        for (var i = 0; i < timeline.length; i++) {
          var value = timeline[i].values && timeline[i].values[prop];
          if (value === undefined) continue;
          var key = String(Number(timeline[i].scrollY || 0));
          if (byScroll[key] !== undefined && byScroll[key] !== value) unstable = true;
          byScroll[key] = value;
          values[value] = true;
        }
        var scrollPositions = Object.keys(byScroll).length;
        if (((!unstable && scrollPositions >= 3) || scrollPositions >= 8) && Object.keys(values).length >= 2) {
          result[prop] = true;
        }
      }
    }
    scrollPropertyCache.set(node, result);
    return result;
  }
  function captureTimeline(nodes, minimumDuration, maximumDuration) {
    var frames = {}, signatures = {}, started = performance.now(), lastChange = started;
    var quietWindow = 240;
    function read(at) {
      var changed = false;
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (!node.isConnected) continue;
        var id = node.getAttribute("data-framecoded-state");
        if (!id) continue;
        var cs = getComputedStyle(node), style = {}, signature = "", ignored = scrollProperties(node);
        for (var p = 0; p < motionProps.length; p++) {
          var prop = motionProps[p], value = cs.getPropertyValue(prop);
          if (ignored[prop]) continue;
          if (!value) continue;
          style[prop] = value;
          signature += prop + ":" + value + ";";
        }
        if (signatures[id] === signature) continue;
        signatures[id] = signature;
        changed = true;
        (frames[id] || (frames[id] = [])).push({ at: at, style: style });
      }
      if (changed) lastChange = performance.now();
    }
    read(0);
    return new Promise(function (resolve) {
      function tick(now) {
        var elapsed = Math.min(maximumDuration, now - started);
        read(elapsed);
        var stable = now - lastChange >= quietWindow;
        if (elapsed < minimumDuration || (elapsed < maximumDuration && !stable)) requestAnimationFrame(tick);
        else resolve({ duration: elapsed, frames: frames });
      }
      requestAnimationFrame(tick);
    });
  }
  function changedTimelineProperties(entries) {
    var changed = {}, first = entries && entries[0] && entries[0].style;
    if (!first) return changed;
    for (var i = 1; i < entries.length; i++) {
      for (var prop in entries[i].style) {
        if (entries[i].style[prop] !== first[prop]) changed[prop] = true;
      }
    }
    return changed;
  }
  function keyframesOf(entries, properties, duration, finalStyle) {
    if (!entries || entries.length < 2 || !Object.keys(properties).length) return undefined;
    var frames = [];
    for (var i = 0; i < entries.length; i++) {
      var frame = { offset: Math.max(0, Math.min(1, entries[i].at / duration)) };
      for (var prop in properties) frame[prop] = entries[i].style[prop] || finalStyle[prop];
      frames.push(frame);
    }
    if (frames[frames.length - 1].offset < 1) {
      var finalFrame = { offset: 1 };
      for (var prop in properties) finalFrame[prop] = finalStyle[prop];
      frames.push(finalFrame);
    }
    return frames;
  }
  function reversedKeyframes(frames) {
    if (!frames || !frames.length) return undefined;
    return frames.slice().reverse().map(function (frame) {
      var reversed = {};
      for (var prop in frame) reversed[prop] = frame[prop];
      reversed.offset = 1 - Number(frame.offset || 0);
      return reversed;
    });
  }

  for (var b = 0; b < buttons.length && b < 16; b++) {
    var button = buttons[b], owner = ownerOf(button);
    if (!owner) continue;
    if (seenOwners.indexOf(owner) !== -1) continue;
    seenOwners.push(owner);
    var existingSource = owner.getAttribute("data-framecoded-trigger");
    var previousInteraction = owner.__framecodedInteraction;
    var buttonLocator = locatorOf(button);
    var source = existingSource || "t" + triggerSequence++;
    var trigger = owner, addedRole = false;
    trigger.setAttribute("data-framecoded-trigger", source);
    trigger.setAttribute("aria-expanded", "false");
    if (trigger.tagName !== "BUTTON" && !trigger.hasAttribute("role")) {
      trigger.setAttribute("role", "button");
      addedRole = true;
    }
    var nodes = identify(source);
    var closed = snapshot(nodes);

    window.__framecodedInteractionSource = source;
    window.__framecodedInteractionPhase = "open";
    window.__framecodedIgnoreAnimationCapture = true;
    // Framer springs frequently keep updating inline transforms after their nominal
    // WAAPI animation has finished. Record until the rendered state is actually quiet
    // so the generated endpoint is the settled component state rather than a transient.
    var openTimelinePromise = captureTimeline(nodes, 480, 1500);
    activate(button);
    var openTimeline = await openTimelinePromise;
    var open = snapshot(nodes);

    window.__framecodedInteractionPhase = "close";
    button = button.isConnected ? button : resolveLocator(buttonLocator) || button;
    var closeTimelinePromise = captureTimeline(nodes, 480, 1500);
    activate(button);
    var closeTimeline = await closeTimelinePromise;
    window.__framecodedInteractionSource = undefined;
    window.__framecodedInteractionPhase = undefined;
    window.__framecodedIgnoreAnimationCapture = false;

    var targets = [], kept = {};
    var ids = Object.keys(closed);
    var nodesById = {};
    for (var nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
      var nodeId = nodes[nodeIndex].getAttribute("data-framecoded-state");
      if (nodeId) nodesById[nodeId] = nodes[nodeIndex];
    }
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i], before = closed[id], after = open[id];
      if (!after) continue;
      var closedDelta = {}, openDelta = {};
      var ignoredProperties = nodesById[id] ? scrollProperties(nodesById[id]) : {};
      var openEntries = openTimeline.frames[id] || [];
      var closeEntries = closeTimeline.frames[id] || [];
      var sampledProperties = changedTimelineProperties(openEntries);
      var closeProperties = changedTimelineProperties(closeEntries);
      for (var closeProp in closeProperties) sampledProperties[closeProp] = true;
      for (var p = 0; p < props.length; p++) {
        var prop = props[p];
        if (ignoredProperties[prop]) continue;
        if (before[prop] !== after[prop] || sampledProperties[prop]) {
          closedDelta[prop] = before[prop];
          openDelta[prop] = after[prop];
        }
      }
      if (Object.keys(openDelta).length) {
        var openKeyframes = keyframesOf(openEntries, sampledProperties, openTimeline.duration, after);
        var closeKeyframes = keyframesOf(closeEntries, sampledProperties, closeTimeline.duration, before);
        if (!closeKeyframes && openKeyframes) closeKeyframes = reversedKeyframes(openKeyframes);
        targets.push({
          id: id,
          closed: closedDelta,
          open: openDelta,
          openKeyframes: openKeyframes,
          closeKeyframes: closeKeyframes,
          openDuration: openTimeline.duration,
          closeDuration: closeTimeline.duration
        });
        kept[id] = true;
      }
    }
    var timing = timingOf(nodes, source);

    for (var n = 0; n < nodes.length; n++) {
      var stateId = nodes[n].getAttribute("data-framecoded-state");
      if (stateId && stateId.indexOf(source + "s") === 0 && !kept[stateId]) nodes[n].removeAttribute("data-framecoded-state");
      if (stateId && kept[stateId] && !nodes[n].isConnected) {
        var replacement = elementAtPath(nodes[n].__framecodedStatePath);
        if (replacement) replacement.setAttribute("data-framecoded-state", stateId);
      }
    }
    if (!trigger.isConnected) {
      var finalButton = resolveLocator(buttonLocator);
      var finalTrigger = finalButton && ownerOf(finalButton);
      if (finalTrigger) {
        trigger = finalTrigger;
        trigger.setAttribute("data-framecoded-trigger", source);
        trigger.setAttribute("aria-expanded", "false");
        if (addedRole && !trigger.hasAttribute("role")) trigger.setAttribute("role", "button");
      }
    }
    if (targets.length) {
      trigger.__framecodedInteraction = {
        type: "toggle",
        targets: targets,
        duration: timing.duration,
        easing: timing.easing
      };
    } else {
      if (existingSource) trigger.__framecodedInteraction = previousInteraction;
      else trigger.removeAttribute("data-framecoded-trigger");
      trigger.removeAttribute("aria-expanded");
      if (addedRole) trigger.removeAttribute("role");
    }
  }
  window.__framecodedIgnoreAnimationCapture = false;
})`;

/**
 * Find CSS selectors where hovering an owner changes a descendant. Direct pseudo
 * declarations are materialized by the normal extractor; this probe covers Framer's
 * card effects such as nested image scale, overlays, labels and rotating arrow icons.
 */
const HOVER_PREPARE_SCRIPT = `(function (props) {
  var probes = {}, candidates = [];

  function addCandidate(element) {
    if (!element || element === document.documentElement || element === document.body) return;
    if (candidates.indexOf(element) !== -1) return;
    if (element.hasAttribute("data-framecoded-trigger")) return;
    if (element.closest("#__framer-editorbar, #__framer-badge-container, .__framer-badge")) return;
    var rect = element.getBoundingClientRect(), cs = getComputedStyle(element);
    if (rect.width <= 0 || rect.height <= 0 || cs.display === "none" || cs.visibility === "hidden") return;
    if (!element.querySelector("*")) return;
    candidates.push(element);
  }

  function inspectRules(rules) {
    for (var r = 0; r < rules.length; r++) {
      var rule = rules[r];
      if (rule.media) {
        try {
          if (!window.matchMedia(rule.conditionText || rule.media.mediaText).matches) continue;
        } catch (error) { continue; }
      }
      if (typeof CSSSupportsRule !== "undefined" && rule instanceof CSSSupportsRule) {
        try { if (!CSS.supports(rule.conditionText || "")) continue; } catch (error) { continue; }
      }
      if (rule.cssRules) {
        try { inspectRules(rule.cssRules); } catch (error) {}
      }
      if (!rule.selectorText) continue;
      var selectors = (function (value) {
        var out = [], start = 0, round = 0, square = 0, quote = "", escaped = false;
        for (var i = 0; i < value.length; i++) {
          var ch = value[i];
          if (escaped) { escaped = false; continue; }
          if (ch.charCodeAt(0) === 92) { escaped = true; continue; }
          if (quote) { if (ch === quote) quote = ""; continue; }
          if (ch === '"' || ch === "'") { quote = ch; continue; }
          if (ch === "(") { round++; continue; }
          if (ch === ")") { if (round) round--; continue; }
          if (ch === "[") { square++; continue; }
          if (ch === "]") { if (square) square--; continue; }
          if (ch === "," && !round && !square) {
            var part = value.slice(start, i).trim();
            if (part) out.push(part);
            start = i + 1;
          }
        }
        var tail = value.slice(start).trim();
        if (tail) out.push(tail);
        return out;
      })(rule.selectorText);
      for (var s = 0; s < selectors.length; s++) {
        var selector = selectors[s], hover = selector.indexOf(":hover");
        if (hover < 0) continue;
        var tail = selector.slice(hover + 6), first = tail.charAt(0);
        if (!(first === " " || first === "\\t" || first === "\\n" || first === ">" || first === "+" || first === "~")) continue;
        var ownerSelector = selector.slice(0, hover).trim();
        if (!ownerSelector) continue;
        try {
          var owners = document.querySelectorAll(ownerSelector);
          for (var o = 0; o < owners.length; o++) addCandidate(owners[o]);
        } catch (error) {}
      }
    }
  }
  for (var s = 0; s < document.styleSheets.length; s++) {
    try { inspectRules(document.styleSheets[s].cssRules); } catch (error) {}
  }

  // Framer component variants often switch through JavaScript and therefore have no
  // readable descendant :hover rule. Probe semantic interactive owners as a bounded
  // fallback; unchanged candidates are discarded by the before/after snapshot pass.
  var interactive = document.querySelectorAll(
    'a[href], button, summary, label, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])'
  );
  for (var interactiveIndex = 0; interactiveIndex < interactive.length; interactiveIndex++) {
    addCandidate(interactive[interactiveIndex]);
  }

  candidates = candidates.filter(function (candidate) {
    return !candidates.some(function (other) { return other !== candidate && candidate.contains(other); });
  }).slice(0, 32);

  function identityOf(element) {
    var identity = element.getAttribute("href") || element.getAttribute("data-framer-name") ||
      element.getAttribute("aria-label") || element.id || String(element.className || "");
    return element.tagName.toLowerCase() + "|" + identity;
  }
  function sourceOf(element) {
    var identity = identityOf(element), peers = Array.from(document.querySelectorAll(element.tagName)).filter(function (peer) {
      return identityOf(peer) === identity;
    });
    var value = identity + "|" + peers.indexOf(element), hash = 2166136261;
    for (var i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    return "h" + (hash >>> 0).toString(36);
  }
  function styleOf(element) {
    var cs = getComputedStyle(element), style = {};
    for (var p = 0; p < props.length; p++) {
      var value = cs.getPropertyValue(props[p]);
      if (value) style[props[p]] = value;
    }
    return style;
  }
  function collect(root, source) {
    var out = {};
    function visit(element, path) {
      var id = source + "s" + (path ? path.split(".").join("_") : "root");
      element.setAttribute("data-framecoded-state", id);
      out[path] = { id: id, style: styleOf(element) };
      var children = element.children;
      for (var i = 0; i < children.length; i++) visit(children[i], path ? path + "." + i : String(i));
    }
    visit(root, "");
    return out;
  }

  var sources = [];
  for (var c = 0; c < candidates.length; c++) {
    var root = candidates[c], source = sourceOf(root);
    root.setAttribute("data-framecoded-trigger", source);
    probes[source] = {
      root: root,
      before: collect(root, source),
      targets: [],
      timelines: {},
      duration: 0,
      easing: "ease",
      knownElements: [],
      pointer: null,
      cursorRecords: [],
      cursorClones: []
    };
    sources.push(source);
  }

  window.__framecodedStartHoverTimeline = function (source, phase, duration) {
    var probe = probes[source];
    if (!probe) return;
    var root = probe.root && probe.root.isConnected ? probe.root : document.querySelector("[data-framecoded-trigger='" + source + "']");
    if (!root) return;

    if (phase === "open") {
      probe.knownElements = new Set(Array.from(document.querySelectorAll("*")));
      probe.pointer = null;
      probe.cursorRecords = [];
      probe.cursorClones = [];
    }

    // Preparing all probes happens while the document is at the top. Refresh the
    // baseline only after this owner has entered the viewport and its reveal settled,
    // otherwise an in-view transition is incorrectly baked into the hover state.
    if (phase === "open") probe.before = collect(root, source);

    var frames = {}, signatures = {}, started = 0, lastChange = 0, finished = false, resolveTimeline;
    var promise = new Promise(function (resolve) { resolveTimeline = resolve; });
    var timeline = { frames: frames, duration: duration, promise: promise };
    probe.timelines[phase] = timeline;

    function recordCursors(now) {
      if (phase !== "open" || !probe.pointer) return;
      var known = probe.knownElements || new Set(), records = probe.cursorRecords || (probe.cursorRecords = []);
      var currentElements = Array.from(document.querySelectorAll("*"));
      for (var cursorIndex = 0; cursorIndex < currentElements.length; cursorIndex++) {
        var cursorElement = currentElements[cursorIndex];
        if (known.has ? known.has(cursorElement) : known.indexOf(cursorElement) !== -1) continue;
        var cursorStyle = getComputedStyle(cursorElement), cursorRect = cursorElement.getBoundingClientRect();
        if (cursorStyle.position !== "fixed" || cursorStyle.pointerEvents !== "none") continue;
        if (cursorRect.width <= 0 || cursorRect.height <= 0 || cursorRect.width > 256 || cursorRect.height > 256) continue;
        var cursorDistance = Math.hypot(
          cursorRect.left + cursorRect.width / 2 - probe.pointer.x,
          cursorRect.top + cursorRect.height / 2 - probe.pointer.y
        );
        var cursorClass = String(cursorElement.className || "");
        if (cursorDistance > 96 && !/cursor|pointer-events-none/i.test(cursorClass)) continue;
        var existingRecord = null;
        for (var recordIndex = 0; recordIndex < records.length; recordIndex++) {
          if (records[recordIndex].element === cursorElement) { existingRecord = records[recordIndex]; break; }
        }
        if (!existingRecord) {
          existingRecord = { element: cursorElement, opacityFrames: [], opacitySignature: "" };
          records.push(existingRecord);
        }
      }
      for (var sampleIndex = 0; sampleIndex < records.length; sampleIndex++) {
        var cursorRecord = records[sampleIndex], sampledCursor = cursorRecord.element;
        if (!sampledCursor || !sampledCursor.isConnected) continue;
        var sampledOpacity = getComputedStyle(sampledCursor).opacity;
        if (cursorRecord.opacitySignature === sampledOpacity) continue;
        cursorRecord.opacitySignature = sampledOpacity;
        lastChange = now;
        cursorRecord.opacityFrames.push({
          time: Math.max(0, now - started),
          opacity: sampledOpacity
        });
      }
    }

    function record(now) {
      var changed = false;
      function visit(element, path) {
        var values = styleOf(element), signature = JSON.stringify(values);
        if (signatures[path] !== signature) {
          signatures[path] = signature;
          changed = true;
          (frames[path] || (frames[path] = [])).push({
            time: Math.max(0, now - started),
            values: values
          });
        }
        var children = element.children;
        for (var i = 0; i < children.length; i++) visit(children[i], path ? path + "." + i : String(i));
      }
      visit(root, "");
      if (changed) lastChange = now;
    }

    // Store the stable state before the pointer event, then start the clock from the
    // event itself. Starting it before Playwright moves the pointer bakes automation
    // latency into every exported curve and makes otherwise identical easing feel slow.
    var baselineTime = performance.now();
    started = baselineTime;
    record(baselineTime);
    started = 0;
    var eventName = phase === "open" ? "pointerenter" : "pointerleave";
    var fallback;
    function begin(event) {
      if (started) return;
      root.removeEventListener(eventName, begin);
      if (fallback) clearTimeout(fallback);
      if (phase === "open" && event && isFinite(event.clientX) && isFinite(event.clientY)) {
        probe.pointer = { x: event.clientX, y: event.clientY };
      }
      started = performance.now();
      lastChange = started;
      if (phase === "open") requestAnimationFrame(cursorTick);
      requestAnimationFrame(tick);
    }
    function cursorTick(now) {
      if (finished) return;
      recordCursors(now);
      if (!finished) requestAnimationFrame(cursorTick);
    }
    function tick(now) {
      record(now);
      var elapsed = now - started;
      var stable = elapsed >= 520 && now - lastChange >= 180;
      if (elapsed >= duration || stable) {
        finished = true;
        timeline.duration = Math.max(16, elapsed);
        resolveTimeline(timeline);
        return;
      }
      requestAnimationFrame(tick);
    }
    root.addEventListener(eventName, begin, { once: true });
    // A full-viewport owner may already contain the pointer and therefore cannot emit
    // another enter/leave. Keep the capture bounded while preserving the event-aligned
    // path for ordinary components.
    fallback = setTimeout(begin, 150);
  };
  window.__framecodedWaitHoverTimeline = function (source, phase) {
    var probe = probes[source], timeline = probe && probe.timelines && probe.timelines[phase];
    return timeline ? timeline.promise : Promise.resolve();
  };
  window.__framecodedHoverProbes = probes;
  return sources;
})`;

const HOVER_SNAPSHOT_SCRIPT = `(function (source, props) {
  var probes = window.__framecodedHoverProbes || {}, probe = probes[source];
  if (!probe) return;
  var root = probe.root && probe.root.isConnected ? probe.root : document.querySelector("[data-framecoded-trigger='" + source + "']");
  if (!root) return;

  function milliseconds(value) {
    return String(value || "0s").split(",").reduce(function (max, part) {
      part = part.trim();
      var parsed = parseFloat(part) || 0;
      return Math.max(max, part.slice(-2) === "ms" ? parsed : parsed * 1000);
    }, 0);
  }
  function splitList(value) {
    var parts = [], current = "", depth = 0, input = String(value || "");
    for (var i = 0; i < input.length; i++) {
      var character = input.charAt(i);
      if (character === "(") depth++;
      if (character === ")") depth = Math.max(0, depth - 1);
      if (character === "," && depth === 0) {
        parts.push(current.trim());
        current = "";
      } else {
        current += character;
      }
    }
    parts.push(current.trim());
    return parts;
  }
  function timeAt(value, index) {
    var parts = splitList(value || "0s");
    var part = parts[index % parts.length].trim(), parsed = parseFloat(part) || 0;
    return part.slice(-2) === "ms" ? parsed : parsed * 1000;
  }
  function timingFor(cs, property) {
    var properties = splitList(cs.transitionProperty || "all");
    var index = properties.indexOf(property);
    if (index < 0) index = properties.indexOf("all");
    if (index < 0 || properties[index] === "none") return { duration: 0, delay: 0, easing: "linear" };
    var easings = splitList(cs.transitionTimingFunction || "ease");
    return {
      duration: timeAt(cs.transitionDuration, index),
      delay: timeAt(cs.transitionDelay, index),
      easing: easings[index % easings.length].trim()
    };
  }
  function styleOf(element) {
    var cs = getComputedStyle(element), style = {};
    for (var p = 0; p < props.length; p++) {
      var value = cs.getPropertyValue(props[p]);
      if (value) style[props[p]] = value;
    }
    return style;
  }
  function changedTimelineProperties(entries) {
    var changed = {}, first = entries && entries.length ? entries[0].values : {};
    for (var i = 1; entries && i < entries.length; i++) {
      var values = entries[i].values;
      for (var prop in values) {
        if (prop.indexOf("transition-") === 0 || prop.indexOf("animation-") === 0) continue;
        if (values[prop] !== first[prop]) changed[prop] = true;
      }
    }
    return changed;
  }
  function keyframesOf(entries, properties, duration, terminal) {
    if (!entries || entries.length < 2 || !Object.keys(properties).length) return undefined;
    var frames = [], lastSignature = "";
    for (var i = 0; i < entries.length; i++) {
      var frame = {}, values = entries[i].values;
      for (var prop in properties) if (values[prop] !== undefined) frame[prop] = values[prop];
      var signature = JSON.stringify(frame);
      if (signature === lastSignature && i !== entries.length - 1) continue;
      lastSignature = signature;
      frame.offset = Math.max(0, Math.min(1, entries[i].time / Math.max(1, duration)));
      frames.push(frame);
    }
    var finalFrame = { offset: 1 };
    for (var property in properties) if (terminal[property] !== undefined) finalFrame[property] = terminal[property];
    if (!frames.length || frames[frames.length - 1].offset < 1 || JSON.stringify(frames[frames.length - 1]) !== JSON.stringify(finalFrame)) {
      frames.push(finalFrame);
    }
    return frames;
  }
  var after = {}, elements = {};
  function visit(element, path) {
    elements[path] = element;
    after[path] = styleOf(element);
    var children = element.children;
    for (var i = 0; i < children.length; i++) visit(children[i], path ? path + "." + i : String(i));
  }
  visit(root, "");

  var timeline = probe.timelines && probe.timelines.open;
  var targets = [], duration = 0, easing = "ease", paths = Object.keys(probe.before);
  for (var i = 0; i < paths.length; i++) {
    var path = paths[i];
    if (!after[path]) continue;
    var beforeEntry = probe.before[path], before = beforeEntry.style, current = after[path];
    var closed = {}, open = {};
    var openEntries = timeline && timeline.frames[path] || [];
    var sampledProperties = changedTimelineProperties(openEntries);
    for (var p = 0; p < props.length; p++) {
      var prop = props[p];
      if (prop.indexOf("transition-") === 0 || prop.indexOf("animation-") === 0) continue;
      if (before[prop] !== current[prop] || sampledProperties[prop]) {
        closed[prop] = before[prop];
        open[prop] = current[prop];
      }
    }
    if (!Object.keys(open).length) continue;
    var cs = getComputedStyle(elements[path]);
    var timings = {}, changedProperties = Object.keys(open);
    for (var t = 0; t < changedProperties.length; t++) {
      var changedProperty = changedProperties[t], timing = timingFor(cs, changedProperty);
      timings[changedProperty] = timing;
      duration = Math.max(duration, timing.duration + Math.max(0, timing.delay));
    }
    targets.push({
      id: beforeEntry.id,
      path: path,
      closed: closed,
      open: open,
      timings: timings,
      sampledProperties: sampledProperties,
      openKeyframes: keyframesOf(openEntries, sampledProperties, timeline ? timeline.duration : 0, current),
      openDuration: timeline ? timeline.duration : 0
    });
    if (cs.transitionTimingFunction) easing = splitList(cs.transitionTimingFunction)[0].trim();
  }
  probe.targets = targets;
  probe.duration = duration;
  probe.easing = easing;

  // Framer cursor components are often React portals: pointerenter mounts a fixed DOM
  // subtree outside the hovered card and pointerleave removes it again. They therefore
  // cannot be found by the normal subtree snapshot. Detect newly mounted pointer-centred
  // fixed layers while they are alive, clone their complete visual subtree, and keep the
  // clone hidden until the generated runtime activates it for this exact hover owner.
  function cursorOpacityTimeline(record) {
    var entries = record && record.opacityFrames || [];
    if (entries.length < 2) return null;
    var duration = Math.max(1, entries[entries.length - 1].time);
    var frames = [{ offset: 0, opacity: entries[0].opacity }];
    for (var i = 0; i < entries.length; i++) {
      var offset = Math.max(0, Math.min(1, entries[i].time / duration));
      var previous = frames[frames.length - 1];
      if (previous && previous.offset === offset && previous.opacity === entries[i].opacity) continue;
      frames.push({ offset: offset, opacity: entries[i].opacity });
    }
    if (frames[frames.length - 1].offset < 1) {
      frames.push({ offset: 1, opacity: entries[entries.length - 1].opacity });
    }
    return { duration: duration, frames: frames };
  }
  var known = probe.knownElements || new Set(), pointer = probe.pointer, cursorRecords = probe.cursorRecords || [];
  if (pointer) {
    var currentElements = Array.from(document.querySelectorAll("*"));
    for (var cursorIndex = 0; cursorIndex < currentElements.length; cursorIndex++) {
      var cursorElement = currentElements[cursorIndex];
      if (known.has ? known.has(cursorElement) : known.indexOf(cursorElement) !== -1) continue;
      var cursorStyle = getComputedStyle(cursorElement), cursorRect = cursorElement.getBoundingClientRect();
      if (cursorStyle.position !== "fixed" || cursorStyle.pointerEvents !== "none") continue;
      if (cursorRect.width <= 0 || cursorRect.height <= 0 || cursorRect.width > 256 || cursorRect.height > 256) continue;
      var cursorDistance = Math.hypot(
        cursorRect.left + cursorRect.width / 2 - pointer.x,
        cursorRect.top + cursorRect.height / 2 - pointer.y
      );
      if (cursorDistance > 12) continue;
      var cursorRecord = null;
      for (var recordIndex = 0; recordIndex < cursorRecords.length; recordIndex++) {
        if (cursorRecords[recordIndex].element === cursorElement) { cursorRecord = cursorRecords[recordIndex]; break; }
      }
      var cursorKey = window.__framecodedCursorKey && window.__framecodedCursorKey(cursorElement);
      var sharedRecords = window.__framecodedCursorTimelines || [];
      for (var sharedIndex = 0; sharedIndex < sharedRecords.length; sharedIndex++) {
        var sharedRecord = sharedRecords[sharedIndex];
        if (sharedRecord.key !== cursorKey) continue;
        if (!cursorRecord || (sharedRecord.opacityFrames || []).length > (cursorRecord.opacityFrames || []).length) {
          cursorRecord = sharedRecord;
        }
      }
      var opacityTimeline = cursorOpacityTimeline(cursorRecord);
      var cursorClone = cursorElement.cloneNode(true);
      cursorClone.setAttribute("data-framecoded-cursor", "true");
      cursorClone.setAttribute("data-framecoded-cursor-source", source);
      cursorClone.setAttribute("data-framecoded-cursor-follow", "direct");
      cursorClone.setAttribute("data-framecoded-cursor-duration", String(Math.round(opacityTimeline ? opacityTimeline.duration : 0)));
      if (opacityTimeline) {
        cursorClone.setAttribute("data-framecoded-cursor-opacity", JSON.stringify(opacityTimeline.frames));
      }
      cursorClone.setAttribute("aria-hidden", "true");
      cursorClone.style.opacity = "0";
      cursorClone.style.transform = "translate(-50%, -50%) translate3d(50vw, 50vh, 0)";
      probe.cursorClones.push(cursorClone);
    }
  }
})`;

const HOVER_FINALIZE_SCRIPT = `(function (source) {
  var probes = window.__framecodedHoverProbes || {}, probe = probes[source];
  if (!probe) return;
  var root = probe.root && probe.root.isConnected ? probe.root : document.querySelector("[data-framecoded-trigger='" + source + "']");
  if (!root) { delete probes[source]; return; }

  var elements = {};
  function visit(element, path) {
    elements[path] = element;
    var state = element.getAttribute("data-framecoded-state");
    if (state && state.indexOf(source + "s") === 0) element.removeAttribute("data-framecoded-state");
    var children = element.children;
    for (var i = 0; i < children.length; i++) visit(children[i], path ? path + "." + i : String(i));
  }
  visit(root, "");

  function keyframesOf(entries, properties, duration, terminal) {
    if (!entries || entries.length < 2 || !Object.keys(properties).length) return undefined;
    var frames = [], lastSignature = "";
    for (var i = 0; i < entries.length; i++) {
      var frame = {}, values = entries[i].values;
      for (var prop in properties) if (values[prop] !== undefined) frame[prop] = values[prop];
      var signature = JSON.stringify(frame);
      if (signature === lastSignature && i !== entries.length - 1) continue;
      lastSignature = signature;
      frame.offset = Math.max(0, Math.min(1, entries[i].time / Math.max(1, duration)));
      frames.push(frame);
    }
    var finalFrame = { offset: 1 };
    for (var property in properties) if (terminal[property] !== undefined) finalFrame[property] = terminal[property];
    if (!frames.length || frames[frames.length - 1].offset < 1 || JSON.stringify(frames[frames.length - 1]) !== JSON.stringify(finalFrame)) {
      frames.push(finalFrame);
    }
    return frames;
  }
  function reversedKeyframes(frames) {
    if (!frames || !frames.length) return undefined;
    return frames.slice().reverse().map(function (frame) {
      var reversed = {};
      for (var prop in frame) reversed[prop] = frame[prop];
      reversed.offset = 1 - Number(frame.offset || 0);
      return reversed;
    });
  }

  var kept = [];
  var closeTimeline = probe.timelines && probe.timelines.close;
  for (var i = 0; i < probe.targets.length; i++) {
    var target = probe.targets[i], element = elements[target.path];
    if (!element) continue;
    element.setAttribute("data-framecoded-state", target.id);
    var closeEntries = closeTimeline && closeTimeline.frames[target.path] || [];
    var closeKeyframes = keyframesOf(
      closeEntries,
      target.sampledProperties || {},
      closeTimeline ? closeTimeline.duration : 0,
      target.closed
    );
    if (!closeKeyframes && target.openKeyframes) closeKeyframes = reversedKeyframes(target.openKeyframes);
    kept.push({
      id: target.id,
      closed: target.closed,
      open: target.open,
      timings: target.timings,
      openKeyframes: target.openKeyframes,
      closeKeyframes: closeKeyframes,
      openDuration: target.openDuration,
      closeDuration: closeTimeline ? closeTimeline.duration : target.openDuration
    });
  }
  var cursorClones = probe.cursorClones || [];
  for (var cursorIndex = 0; cursorIndex < cursorClones.length; cursorIndex++) {
    root.appendChild(cursorClones[cursorIndex]);
  }
  if (kept.length) {
    root.__framecodedInteraction = {
      type: "hover",
      targets: kept,
      duration: probe.duration,
      easing: probe.easing
    };
  } else if (!cursorClones.length) {
    root.removeAttribute("data-framecoded-trigger");
  }
  delete probes[source];
})`;

const HOVER_CLEANUP_SCRIPT = `(function (source) {
  var probes = window.__framecodedHoverProbes || {}, probe = probes[source];
  var root = probe && probe.root && probe.root.isConnected ? probe.root : document.querySelector("[data-framecoded-trigger='" + source + "']");
  if (root) {
    root.removeAttribute("data-framecoded-trigger");
    var nodes = [root].concat(Array.from(root.querySelectorAll("*")));
    for (var i = 0; i < nodes.length; i++) {
      var state = nodes[i].getAttribute("data-framecoded-state");
      if (state && state.indexOf(source + "s") === 0) nodes[i].removeAttribute("data-framecoded-state");
    }
  }
  delete probes[source];
})`;

async function captureHoverInteractions(
  page: Page,
  onProgress?: (message: string) => void,
): Promise<void> {
  const sources = (await page.evaluate(
    `${HOVER_PREPARE_SCRIPT}(${JSON.stringify(COMPLETE_CAPTURED_PROPS)})`,
  )) as string[];

  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    const source = sources[sourceIndex]!;
    onProgress?.(`capturing hover ${sourceIndex + 1}/${sources.length}`);
    try {
      const trigger = page.locator(`[data-framecoded-trigger="${source}"]`);
      await trigger.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      const box = await trigger.boundingBox();
      const viewport = page.viewportSize() ?? { width: 1200, height: 1000 };
      const outside = [
        { x: 1, y: 1 },
        { x: Math.max(1, viewport.width - 2), y: 1 },
        { x: 1, y: Math.max(1, viewport.height - 2) },
        { x: Math.max(1, viewport.width - 2), y: Math.max(1, viewport.height - 2) },
      ].find((point) =>
        !box ||
        point.x < box.x ||
        point.x > box.x + box.width ||
        point.y < box.y ||
        point.y > box.y + box.height,
      ) ?? { x: 1, y: 1 };
      // Scrolling can move the owner underneath a stationary pointer and settle its
      // hover variant before capture starts. Re-establish a genuine outside baseline
      // after layout has stabilized, then align the timeline to the next pointerenter.
      await page.mouse.move(outside.x, outside.y);
      await page.waitForTimeout(64);
      await page.evaluate(`window.__framecodedInteractionSource=${JSON.stringify(source)};window.__framecodedInteractionPhase="open";window.__framecodedIgnoreAnimationCapture=true`);
      await page.evaluate(`window.__framecodedStartHoverTimeline(${JSON.stringify(source)},"open",900)`);
      await trigger.hover({ force: true });
      await page.evaluate(`window.__framecodedWaitHoverTimeline(${JSON.stringify(source)},"open")`);
      await page.evaluate(`${HOVER_SNAPSHOT_SCRIPT}(${JSON.stringify(source)},${JSON.stringify(COMPLETE_CAPTURED_PROPS)})`);
      await page.evaluate(`window.__framecodedInteractionPhase="close"`);
      await page.evaluate(`window.__framecodedStartHoverTimeline(${JSON.stringify(source)},"close",900)`);
      await page.mouse.move(outside.x, outside.y);
      await page.evaluate(`window.__framecodedWaitHoverTimeline(${JSON.stringify(source)},"close")`);
      await page.evaluate(`${HOVER_FINALIZE_SCRIPT}(${JSON.stringify(source)})`);
    } catch {
      await page.evaluate(`${HOVER_CLEANUP_SCRIPT}(${JSON.stringify(source)})`).catch(() => undefined);
    } finally {
      await page.evaluate(`window.__framecodedInteractionSource=undefined;window.__framecodedInteractionPhase=undefined;window.__framecodedIgnoreAnimationCapture=false`).catch(() => undefined);
    }
  }
  await page.evaluate(`window.scrollTo(0,0)`);
}

export interface CaptureOptions {
  /** Viewport width to render at. */
  width: number;
  /** Extra settle time after network idle, for entrance animations. */
  settleMs?: number;
  /** Component interactions only need to be captured once per responsive page group. */
  captureInteractions?: boolean;
  onProgress?: (message: string) => void;
}

/** Open a browser, hand it to `fn`, and always close it again. */
export async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  let browser: Browser;
  try {
    browser = await chromium.launch({ channel: "msedge" });
  } catch {
    try {
      browser = await chromium.launch({ channel: "chrome" });
    } catch (err) {
      throw new Error(
        `Could not start a browser for rendering (${(err as Error).message}). ` +
          `Install Microsoft Edge or Google Chrome, or re-run with --no-render to use the static parser.`,
      );
    }
  }
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

/**
 * Read the page-level responsive boundaries from the CSS Framer actually loaded.
 *
 * Framer projects can add arbitrary breakpoints (for example a 1440px wide-desktop
 * variant), so a fixed Desktop / Tablet / Phone list silently misses real designs.
 * Rules are limited to the page's own Framer scope to avoid treating a nested component's
 * private media query as a full-page breakpoint.
 */
export async function discoverResponsiveBreakpoints(browser: Browser, url: string): Promise<number[]> {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 1000 },
    deviceScaleFactor: 1,
  });
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 });
    const conditions = await page.evaluate(() => {
      const scopes = new Set<string>();
      for (const token of document.body.classList) {
        if (token.startsWith("framer-body-")) {
          scopes.add(token);
          const rootToken = token.match(/(framer-[A-Za-z0-9]+)$/)?.[1];
          if (rootToken) scopes.add(rootToken);
        }
      }

      const root =
        document.querySelector("[data-framer-root]") ??
        document.querySelector("#main > [class]") ??
        document.body.firstElementChild;
      if (root) {
        for (const token of root.classList) {
          if (/^framer-[A-Za-z0-9]+$/.test(token)) scopes.add(token);
        }
      }

      const found = new Set<string>();
      const relevant = (cssText: string): boolean => {
        for (const scope of scopes) if (cssText.includes(`.${scope}`)) return true;
        return scopes.size === 0 && /\.framer-[\w-]+\s+\.hidden-[\w-]+/.test(cssText);
      };

      const scan = (rules: CSSRuleList): void => {
        for (let index = 0; index < rules.length; index++) {
          const rule = rules[index] as CSSRule & {
            conditionText?: string;
            media?: MediaList;
            cssRules?: CSSRuleList;
          };
          const cssText = rule.cssText || "";
          const condition = rule.conditionText ?? rule.media?.mediaText;
          if (condition && relevant(cssText)) found.add(condition);
          if (rule.cssRules) {
            try { scan(rule.cssRules); } catch { /* inaccessible nested sheet */ }
          }
        }
      };

      for (const sheet of document.styleSheets) {
        try { scan(sheet.cssRules); } catch { /* cross-origin sheet */ }
      }

      // Framer normally inlines page CSS. Keep a text fallback for browsers that expose
      // the style element but not its CSSRuleList.
      if (found.size === 0) {
        for (const style of document.querySelectorAll("style")) {
          const cssText = style.textContent || "";
          if (!relevant(cssText)) continue;
          const media = /@media\s*([^\{]+)\{/g;
          let match: RegExpExecArray | null;
          while ((match = media.exec(cssText))) found.add(match[1]!.trim());
        }
      }

      return [...found];
    });

    const boundaries = new Set<number>();
    for (const condition of conditions) {
      const minimums = condition.matchAll(/min-width\s*:\s*([\d.]+)px/gi);
      for (const match of minimums) {
        const boundary = Math.round(Number(match[1]));
        if (boundary >= 240 && boundary <= 3840) boundaries.add(boundary);
      }
      const maximums = condition.matchAll(/max-width\s*:\s*([\d.]+)px/gi);
      for (const match of maximums) {
        const boundary = Math.floor(Number(match[1])) + 1;
        if (boundary >= 240 && boundary <= 3840) boundaries.add(boundary);
      }
    }
    return [...boundaries].sort((a, b) => a - b);
  } catch (error) {
    log.debug(`Could not discover responsive breakpoints for ${url}: ${(error as Error).message}`);
    return [];
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Load `url` at one viewport width and read back the rendered tree. */
export async function capturePage(
  browser: Browser,
  url: string,
  options: CaptureOptions,
): Promise<CapturedPage> {
  const page: Page = await browser.newPage({
    viewport: { width: options.width, height: 1000 },
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(10_000);
  try {
    await page.addInitScript(MOTION_CAPTURE_SCRIPT);
    options.onProgress?.("loading document");
    await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 });
    await page.evaluate(`window.__framecodedCapturePreScrollBaseline()`);
    // Walk the document rather than jumping straight to the bottom: IntersectionObserver
    // callbacks for intermediate sections need a rendered frame in which to fire.
    options.onProgress?.("replaying in-view animations");
    await page.evaluate(`(async function(){
      window.__framecodedMotionTrigger = "in-view";
      var step = Math.max(320, Math.floor(window.innerHeight * .72));
      var height = Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement.scrollHeight);
      var maximum = Math.max(0, height - window.innerHeight);
      var samples = maximum > 0 ? Math.min(96, Math.max(1, Math.ceil(maximum / step))) : 0;
      for (var sample = 0; sample <= samples; sample++) {
        var y = samples ? Math.round(maximum * sample / samples) : 0;
        window.scrollTo(0, y);
        await new Promise(function(resolve){ setTimeout(resolve, 45); });
      }
    })()`);
    await page.waitForTimeout(options.settleMs ?? 2500);

    // With all one-shot reveals settled, sample only scroll-linked computed values.
    // Existing document-timeline animations are paused so time cannot masquerade as
    // scroll progress; a repeated top sample rejects remaining rAF perpetual effects.
    options.onProgress?.("sampling scroll-linked motion");
    await page.evaluate(`(async function(){
      window.__framecodedIgnoreStyleCapture = true;
      window.__framecodedIgnoreAnimationCapture = true;
      var paused = [];
      var animations = document.getAnimations();
      for (var i = 0; i < animations.length; i++) {
        if (animations[i].playState !== "running") continue;
        try { animations[i].pause(); paused.push(animations[i]); } catch (error) {}
      }
      window.scrollTo(0, 0);
      await new Promise(function(resolve){ setTimeout(resolve, 700); });
      window.__framecodedResetScrollCapture();
      window.__framecodedMotionTrigger = "scroll";
      window.__framecodedRecordScrollFrame();
      await new Promise(function(resolve){ setTimeout(resolve, 160); });
      window.__framecodedRecordScrollFrame();
      var maximum = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      var step = Math.max(80, Math.floor(window.innerHeight * .12));
      var samples = maximum > 0 ? Math.min(96, Math.max(1, Math.ceil(maximum / step))) : 0;
      for (var sample = 1; sample < samples; sample++) {
        var y = Math.round(maximum * sample / samples);
        window.scrollTo(0, y);
        await new Promise(function(resolve){ setTimeout(resolve, 48); });
        window.__framecodedRecordScrollFrame();
      }
      if (maximum > 0) {
        window.scrollTo(0, maximum);
        await new Promise(function(resolve){ setTimeout(resolve, 64); });
        window.__framecodedRecordScrollFrame();
      }
      window.__framecodedMotionTrigger = "load";
      window.scrollTo(0, 0);
      await new Promise(function(resolve){ setTimeout(resolve, 700); });
      for (var i = 0; i < paused.length; i++) {
        try { paused[i].play(); } catch (error) {}
      }
      window.__framecodedIgnoreStyleCapture = false;
      window.__framecodedIgnoreAnimationCapture = false;
    })()`);

    if (options.captureInteractions !== false) {
      options.onProgress?.("discovering component interactions");
      await captureHoverInteractions(page, options.onProgress);
      options.onProgress?.("capturing toggle interactions");
      await page.evaluate(`${TOGGLE_CAPTURE_SCRIPT}(${JSON.stringify(COMPLETE_CAPTURED_PROPS)})`);
    }

    // Interaction probes scroll through the document and can leave sticky/fixed chrome in
    // its transient "scrolled away" state. Restore the real first-paint position and let
    // Framer's layout projection settle before computed styles become the exported CSS.
    // Keep that reset out of the captured timelines, then briefly reopen style sampling so
    // genuinely perpetual rAF effects still retain a recent sample.
    await page.evaluate(`(async function () {
      window.__framecodedIgnoreStyleCapture = true;
      window.__framecodedIgnoreAnimationCapture = true;
      window.__framecodedMotionTrigger = "load";
      window.scrollTo(0, 0);
      await new Promise(function (resolve) { setTimeout(resolve, 700); });
      window.__framecodedIgnoreStyleCapture = false;
      await new Promise(function (resolve) { setTimeout(resolve, 64); });
      window.__framecodedIgnoreStyleCapture = true;
    })()`);

    // Computed style includes the current WAAPI sample. A long entrance animation can
    // still be halfway through when the normal settle timeout expires, which would bake
    // that transient opacity/transform into the generated base CSS. Pin finite document-
    // timeline animations at their endpoint without calling finish() (and therefore
    // without firing Framer completion callbacks). Infinite and scroll-driven motion is
    // replayed by MotionRuntime and must keep its captured lifecycle.
    await page.evaluate(`(function () {
      var animations = document.getAnimations();
      for (var i = 0; i < animations.length; i++) {
        var animation = animations[i];
        if (animation.timeline && document.timeline && animation.timeline !== document.timeline) continue;
        var effect = animation.effect;
        if (!effect || typeof effect.getComputedTiming !== "function") continue;
        var timing = effect.getComputedTiming(), endTime = Number(timing.endTime);
        if (!isFinite(endTime)) continue;
        try {
          animation.pause();
          animation.currentTime = endTime;
        } catch (error) {}
      }
    })()`);

    options.onProgress?.("extracting rendered layout");
    const html = await page.content();
    const result = (await page.evaluate(`${EXTRACT_SCRIPT}(${JSON.stringify({
      props: COMPLETE_CAPTURED_PROPS,
      inherited: [...INHERITED],
      skipTags: SKIP_TAGS,
      layout: LAYOUT_PROPS,
      layoutShorthands: LAYOUT_SHORTHANDS,
      pseudo: PSEUDO_SELECTORS,
      pseudoProps: COMPLETE_PSEUDO_PROPS,
      pseudoSkip: PSEUDO_SKIP,
    })})`)) as {
      roots: RenderedNode[];
      sprite: string;
      count: number;
      globalCss: string;
      bodyStyles: Record<string, string>;
    };

    const root: RenderedNode =
      result.roots.length === 1
        ? result.roots[0]!
        : { tag: "div", attrs: {}, styles: {}, children: result.roots };

    log.debug(`rendered ${url} @${options.width}px - ${result.count} nodes`);
    return {
      url: page.url(),
      html,
      root,
      svgSprite: result.sprite || undefined,
      globalCss: result.globalCss,
      bodyStyles: result.bodyStyles,
      nodeCount: result.count,
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}
