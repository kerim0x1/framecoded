/** Static files for the generated TanStack Start project (embedded for a self-contained CLI). */

export const VITE_CONFIG = `import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";

// TanStack Start (Vite plugin). The plugin wires SSR + the Nitro server build and
// generates src/routeTree.gen.ts from the files in src/routes.
export default defineConfig({
  server: { port: 3000 },
  plugins: [tanstackStart(), nitro(), viteReact()],
});
`;

export const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src", "vite.config.ts"]
}
`;

export const GITIGNORE = `node_modules/
.output/
.nitro/
.tanstack/
dist/
*.log
.env
.env.*
.DS_Store
src/routeTree.gen.ts
`;

export const ENV_FILE = `# Replace this placeholder with the public production domain.
# It is used by canonical URLs, Open Graph, JSON-LD, robots.txt and sitemap.xml.
VITE_SITE_URL=https://your-domain.com

# Optional custom backend / API base URL.
VITE_API_BASE_URL=http://localhost:8080
`;

/** Optimized image component: lazy by default, eager + high priority for LCP. */
export const IMAGE_COMPONENT = `import type { ImgHTMLAttributes } from "react";

export interface ImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  /** Mark as the LCP image: load eagerly with high fetch priority. */
  priority?: boolean;
}

/**
 * Drop-in <img> with sensible performance defaults:
 *  - lazy loading + async decoding (off the critical path) by default
 *  - eager + fetchPriority="high" when \`priority\` is set (hero/LCP images)
 *  - width/height should be provided to prevent layout shift (CLS)
 */
export function Image({ priority, loading, decoding, fetchPriority, ...rest }: ImageProps) {
  return (
    <img
      {...rest}
      loading={loading ?? "eager"}
      decoding={decoding ?? "async"}
      fetchPriority={fetchPriority ?? (priority ? "high" : undefined)}
    />
  );
}
`;

/** Browser-native replay for motion captured from Framer's Element.animate() calls. */
export const MOTION_COMPONENT = `"use client";

import { useEffect, useLayoutEffect, useReducer } from "react";

export interface MotionDefinition {
  trigger: "load" | "in-view" | "tap" | "scroll";
  keyframes: unknown;
  options: Record<string, unknown>;
  media?: string;
  source?: string;
  phase?: "open" | "close";
}

export type MotionDefinitionMap = Record<string, MotionDefinition[]>;

export interface InteractionDefinition {
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
  responsive?: Array<{
    media: string;
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
  }>;
}

export type InteractionDefinitionMap = Record<string, InteractionDefinition>;

function animationOptions(options: Record<string, unknown>): KeyframeAnimationOptions {
  const normalized = { ...options };
  if (normalized.iterations === "Infinity") normalized.iterations = Infinity;
  delete normalized.__framecodedView;
  delete normalized.__framecodedScroll;
  delete normalized.__framecodedContent;
  return normalized as KeyframeAnimationOptions;
}

function waapiProperty(property: string): string {
  if (
    property === "offset" ||
    property === "easing" ||
    property === "composite" ||
    property.startsWith("--") ||
    !property.includes("-")
  ) {
    return property;
  }
  const vendorNormalized = property.replace(/^-([a-z]+)-/, (_, vendor: string) => vendor + "-");
  return vendorNormalized.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function waapiKeyframes(keyframes: unknown): Keyframe[] | PropertyIndexedKeyframes {
  const normalize = (frame: Record<string, unknown>) => {
    const normalized: Record<string, unknown> = {};
    for (const [property, value] of Object.entries(frame)) {
      normalized[waapiProperty(property)] = value;
    }
    return normalized;
  };
  if (Array.isArray(keyframes)) {
    return keyframes.map((frame) => normalize(frame as Record<string, unknown>)) as Keyframe[];
  }
  if (keyframes && typeof keyframes === "object") {
    return normalize(keyframes as Record<string, unknown>) as PropertyIndexedKeyframes;
  }
  return [];
}

function createAnimation(element: HTMLElement, definition: MotionDefinition): Animation | null {
  try {
    return element.animate(
      waapiKeyframes(definition.keyframes),
      animationOptions(definition.options),
    );
  } catch {
    return null;
  }
}

function activeInteraction(definition: InteractionDefinition): InteractionDefinition {
  let active = definition;
  for (const responsive of definition.responsive ?? []) {
    if (!window.matchMedia(responsive.media).matches) continue;
    active = { type: definition.type, ...responsive };
  }
  return active;
}

type MotionBootstrapEntry = {
  id: string;
  index: number;
  element: HTMLElement;
  animation: Animation;
};

declare global {
  interface Window {
    __framecodedMotionBootstrap?: { entries: MotionBootstrapEntry[] };
  }
}

function keyframeEdge(keyframes: unknown, last: boolean): Record<string, unknown> {
  let frame: Record<string, unknown> = {};
  if (Array.isArray(keyframes)) {
    const candidate = keyframes[last ? keyframes.length - 1 : 0];
    if (candidate && typeof candidate === "object") frame = { ...candidate };
  } else if (keyframes && typeof keyframes === "object") {
    for (const [property, value] of Object.entries(keyframes as Record<string, unknown>)) {
      frame[property] = Array.isArray(value) ? value[last ? value.length - 1 : 0] : value;
    }
  }
  delete frame.offset;
  delete frame.easing;
  delete frame.composite;
  return frame;
}

function normalizedFrame(frame: Record<string, unknown>): Record<string, unknown> {
  const normalized = waapiKeyframes([frame]);
  return Array.isArray(normalized)
    ? (normalized[0] as Record<string, unknown>)
    : frame;
}

function visualFrameScore(frame: Record<string, unknown>): number {
  let score = 0;
  const opacity = Number(frame.opacity);
  if (Number.isFinite(opacity)) score += opacity * 10_000;
  const transform = String(frame.transform ?? "");
  if (!transform || transform === "none") score += 1_000;
  else {
    const values = transform.match(/-?\\d*\\.?\\d+/g)?.map(Number) ?? [];
    score -= values.reduce((total, value) => total + Math.abs(value), 0);
  }
  const filter = String(frame.filter ?? "");
  if (!filter || filter === "none" || /blur\\(0(?:px)?\\)/.test(filter)) score += 100;
  return score;
}

function stableFrame(definition: MotionDefinition, preferFirst = false): Record<string, unknown> {
  const first = keyframeEdge(definition.keyframes, false);
  if (preferFirst) return first;
  const last = keyframeEdge(definition.keyframes, true);
  return visualFrameScore(last) >= visualFrameScore(first) ? last : first;
}

function createFrozenAnimation(
  element: HTMLElement,
  definition: MotionDefinition,
  preferFirst: boolean,
): Animation | null {
  try {
    const frame = normalizedFrame(stableFrame(definition, preferFirst));
    const animation = element.animate([frame, frame], { duration: 1, fill: "both" });
    animation.pause();
    animation.currentTime = 1;
    return animation;
  } catch {
    return null;
  }
}

function motionBootstrapScript(definitions: MotionDefinitionMap): string {
  const compact: Record<
    string,
    Array<{
      index: number;
      media?: string;
      first: Record<string, unknown>;
      reduced: Record<string, unknown>;
    }>
  > = {};
  for (const [id, motions] of Object.entries(definitions)) {
    const entries = motions.flatMap((motion, index) => {
      if (motion.trigger === "tap") return [];
      return [{
        index,
        ...(motion.media ? { media: motion.media } : {}),
        first: normalizedFrame(keyframeEdge(motion.keyframes, false)),
        reduced: normalizedFrame(stableFrame(motion,
          motion.options.iterations === "Infinity" || motion.options.iterations === Infinity)),
      }];
    });
    if (entries.length) compact[id] = entries;
  }
  const serialized = JSON.stringify(compact).replace(/</g, "\\\\u003c");
  return '(function(){try{var groups=' + serialized +
    ';var reduced=window.matchMedia("(prefers-reduced-motion: reduce)").matches;var entries=[];var nodes=document.querySelectorAll("[data-framecoded-motion]");for(var id in groups){var motions=groups[id],activeMedia;for(var i=0;i<motions.length;i++){if(motions[i].media&&window.matchMedia(motions[i].media).matches)activeMedia=motions[i].media;}for(var i=0;i<motions.length;i++){var motion=motions[i];if(activeMedia?motion.media!==activeMedia:motion.media)continue;var frame=reduced?motion.reduced:motion.first;if(!frame||!Object.keys(frame).length)continue;for(var n=0;n<nodes.length;n++){var element=nodes[n];if(element.getAttribute("data-framecoded-motion")!==id)continue;try{var animation=element.animate([frame,frame],{duration:86400000,fill:"both"});animation.pause();animation.currentTime=0;entries.push({id:id,index:motion.index,element:element,animation:animation});}catch(error){}}}}window.__framecodedMotionBootstrap={entries:entries};}catch(error){}})();';
}

export function MotionRuntime({
  definitions,
  interactions = {},
}: {
  definitions: MotionDefinitionMap;
  interactions?: InteractionDefinitionMap;
}) {
  const [responsiveRevision, refreshResponsiveRuntime] = useReducer(
    (revision: number) => revision + 1,
    0,
  );

  useLayoutEffect(() => {
    const media = new Set<string>(["(prefers-reduced-motion: reduce)"]);
    for (const motions of Object.values(definitions)) {
      for (const motion of motions) if (motion.media) media.add(motion.media);
    }
    for (const interaction of Object.values(interactions)) {
      for (const responsive of interaction.responsive ?? []) media.add(responsive.media);
    }

    const queries = [...media].map((query) => window.matchMedia(query));
    let refreshTimer = 0;
    const scheduleRefresh = () => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(refreshResponsiveRuntime, 80);
    };
    for (const query of queries) query.addEventListener("change", scheduleRefresh);
    window.addEventListener("resize", scheduleRefresh, { passive: true });

    return () => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      for (const query of queries) query.removeEventListener("change", scheduleRefresh);
      window.removeEventListener("resize", scheduleRefresh);
    };
  }, [definitions, interactions]);

  useEffect(() => {
    const running: Animation[] = [];
    const observers: IntersectionObserver[] = [];
    const listenerCleanups: Array<() => void> = [];
    const tapMotions = new Map<
      string,
      Array<{ element: HTMLElement; definition: MotionDefinition }>
    >();
    const scrollMotions: Array<{
      element: HTMLElement;
      animation: Animation;
      definition: MotionDefinition;
    }> = [];
    const scrollContents: Array<{
      element: HTMLElement;
      definition: MotionDefinition;
      lastIndex: number;
      initialHtml: string;
      initialColor: string;
      initialOpacity: string;
    }> = [];
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const perpetualVisibilityTarget = (element: HTMLElement): HTMLElement => {
      const targetRect = element.getBoundingClientRect();
      const horizontallyVisible =
        targetRect.width > 0 && targetRect.right > 0 && targetRect.left < window.innerWidth;
      if (horizontallyVisible) return element;

      // Framer tickers position their animated track entirely beyond the left or right
      // edge and translate duplicated items through a visible wrapper. Observing the
      // track itself therefore never intersects. Use the nearest horizontally visible
      // box while retaining vertical viewport pausing through IntersectionObserver.
      let ancestor = element.parentElement;
      while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
        const rect = ancestor.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < window.innerWidth) {
          return ancestor;
        }
        ancestor = ancestor.parentElement;
      }
      return element;
    };

    for (const [id, motions] of Object.entries(definitions)) {
      // Responsive captures are appended desktop -> tablet -> phone. Multiple max-width
      // queries match on a phone, so the last matching group is the narrowest and wins.
      let activeMedia: string | undefined;
      for (const motion of motions) {
        if (motion.media && window.matchMedia(motion.media).matches) activeMedia = motion.media;
      }
      const activeMotions = motions
        .map((motion, index) => ({ motion, index }))
        .filter(({ motion }) => activeMedia ? motion.media === activeMedia : !motion.media);
      const elements = document.querySelectorAll<HTMLElement>(
        "[data-framecoded-motion='" + id + "']",
      );
      for (const element of elements) {
        for (const { motion, index: motionIndex } of activeMotions) {
          if (motion.trigger === "tap" && motion.source) {
            const list = tapMotions.get(motion.source) ?? [];
            list.push({ element, definition: motion });
            tapMotions.set(motion.source, list);
            continue;
          }
          const bootstrapEntries = window.__framecodedMotionBootstrap?.entries;
          if (bootstrapEntries) {
            for (let index = bootstrapEntries.length - 1; index >= 0; index--) {
              const entry = bootstrapEntries[index]!;
              if (entry.id !== id || entry.index !== motionIndex || entry.element !== element) continue;
              entry.animation.cancel();
              bootstrapEntries.splice(index, 1);
            }
          }
          const perpetual =
            motion.options.iterations === "Infinity" || motion.options.iterations === Infinity;
          const contentTimeline = motion.options.__framecodedContent as
            | { samples?: Array<{ progress?: number; html?: string; color?: string; opacity?: string }> }
            | undefined;
          if (motion.trigger === "scroll" && contentTimeline?.samples?.length) {
            if (!reduced) {
              scrollContents.push({
                element,
                definition: motion,
                lastIndex: -1,
                initialHtml: element.innerHTML,
                initialColor: element.style.color,
                initialOpacity: element.style.opacity,
              });
            }
            continue;
          }
          if (motion.trigger === "scroll") {
            const animation = createAnimation(element, motion);
            if (!animation) continue;
            animation.pause();
            const duration = Number(motion.options.duration ?? 1000) || 1000;
            animation.currentTime = reduced ? duration : 0;
            running.push(animation);
            if (!reduced) scrollMotions.push({ element, animation, definition: motion });
            continue;
          }
          if (reduced) {
            const frozen = createFrozenAnimation(element, motion, perpetual);
            if (frozen) running.push(frozen);
            continue;
          }

          const animation = createAnimation(element, motion);
          if (!animation) continue;
          running.push(animation);

          if (perpetual) {
            animation.pause();
            animation.currentTime = 0;
            const observer = new IntersectionObserver(
              (entries) => {
                const visible = entries.some((entry) => entry.isIntersecting);
                if (visible) animation.play();
                else animation.pause();
              },
              { threshold: 0, rootMargin: "160px 0px" },
            );
            observer.observe(perpetualVisibilityTarget(element));
            observers.push(observer);
            continue;
          }

          if (motion.trigger === "in-view") {
            animation.pause();
            animation.currentTime = 0;
            const viewport = motion.options.__framecodedView as
              | {
                  rootMargin?: string;
                  threshold?: number;
                  startProgress?: number;
                  ancestorDepth?: number;
                }
              | undefined;
            const hasCapturedObserver =
              viewport?.rootMargin !== undefined ||
              viewport?.threshold !== undefined ||
              Number(viewport?.ancestorDepth ?? 0) > 0;
            if (!hasCapturedObserver && Number.isFinite(viewport?.startProgress)) {
              const playAtCapturedScroll = () => {
                const maximumScroll = Math.max(
                  1,
                  document.documentElement.scrollHeight - window.innerHeight,
                );
                if (window.scrollY + 1 < maximumScroll * Number(viewport?.startProgress)) return;
                animation.play();
                window.removeEventListener("scroll", playAtCapturedScroll);
                window.removeEventListener("resize", playAtCapturedScroll);
              };
              window.addEventListener("scroll", playAtCapturedScroll, { passive: true });
              window.addEventListener("resize", playAtCapturedScroll);
              listenerCleanups.push(() => {
                window.removeEventListener("scroll", playAtCapturedScroll);
                window.removeEventListener("resize", playAtCapturedScroll);
              });
              playAtCapturedScroll();
              continue;
            }
            const observer = new IntersectionObserver(
              (entries) => {
                if (!entries.some((entry) => entry.isIntersecting)) return;
                animation.play();
                observer.disconnect();
              },
              {
                threshold: viewport?.threshold ?? 0.12,
                rootMargin: viewport?.rootMargin ?? "0px 0px -8% 0px",
              },
            );
            let observedElement = element;
            for (let depth = 0; depth < Number(viewport?.ancestorDepth ?? 0); depth++) {
              if (!observedElement.parentElement) break;
              observedElement = observedElement.parentElement;
            }
            observer.observe(observedElement);
            observers.push(observer);
          }
        }
      }
    }

    if (scrollMotions.length || scrollContents.length) {
      let frame = 0;
      const elementLayoutTop = (element: HTMLElement) => {
        let top = 0;
        let node: HTMLElement | null = element;
        while (node) {
          top += node.offsetTop || 0;
          node = node.offsetParent as HTMLElement | null;
        }
        return top;
      };
      const renderScrollMotions = () => {
        frame = 0;
        for (const item of scrollMotions) {
          const range = item.definition.options.__framecodedScroll as
            | {
                startOffset?: number;
                endOffset?: number;
                startProgress?: number;
                endProgress?: number;
              }
            | undefined;
          if (!range) continue;
          const documentRelative =
            Number.isFinite(range.startProgress) && Number.isFinite(range.endProgress);
          const maximumScroll = Math.max(
            1,
            document.documentElement.scrollHeight - window.innerHeight,
          );
          const top = documentRelative ? 0 : elementLayoutTop(item.element);
          const start = documentRelative
            ? maximumScroll * Number(range.startProgress)
            : top + Number(range.startOffset ?? 0);
          const end = documentRelative
            ? maximumScroll * Number(range.endProgress)
            : top + Number(range.endOffset ?? 1);
          const progress = Math.max(0, Math.min(1, (window.scrollY - start) / Math.max(1, end - start)));
          const duration = Number(item.definition.options.duration ?? 1000) || 1000;
          item.animation.currentTime = progress * duration;
        }
        const documentProgress = Math.max(
          0,
          Math.min(
            1,
            window.scrollY /
              Math.max(1, document.documentElement.scrollHeight - window.innerHeight),
          ),
        );
        for (const item of scrollContents) {
          const content = item.definition.options.__framecodedContent as
            | { samples?: Array<{ progress?: number; html?: string; color?: string; opacity?: string }> }
            | undefined;
          const samples = content?.samples ?? [];
          let index = 0;
          for (let i = 1; i < samples.length; i++) {
            if (documentProgress >= Number(samples[i].progress ?? 0)) index = i;
            else break;
          }
          if (index === item.lastIndex || !samples[index]) continue;
          const sample = samples[index];
          item.element.innerHTML = String(sample.html ?? "");
          if (sample.color) item.element.style.color = sample.color;
          if (sample.opacity) item.element.style.opacity = sample.opacity;
          item.lastIndex = index;
        }
      };
      const scheduleScrollMotions = () => {
        if (!frame) frame = requestAnimationFrame(renderScrollMotions);
      };
      scheduleScrollMotions();
      window.addEventListener("scroll", scheduleScrollMotions, { passive: true });
      window.addEventListener("resize", scheduleScrollMotions);
      window.addEventListener("load", scheduleScrollMotions);
      listenerCleanups.push(() => {
        window.removeEventListener("scroll", scheduleScrollMotions);
        window.removeEventListener("resize", scheduleScrollMotions);
        window.removeEventListener("load", scheduleScrollMotions);
        if (frame) cancelAnimationFrame(frame);
        for (const item of scrollContents) {
          item.element.innerHTML = item.initialHtml;
          item.element.style.color = item.initialColor;
          item.element.style.opacity = item.initialOpacity;
        }
      });
    }

    const triggerIds = new Set([...Object.keys(interactions), ...tapMotions.keys()]);
    for (const triggerId of triggerIds) {
      const triggers = document.querySelectorAll<HTMLElement>(
        "[data-framecoded-trigger='" + triggerId + "']",
      );
      for (const trigger of triggers) {
        let open = false;
        let hovered = false;
        let focused = false;
        const sourceInteraction = interactions[triggerId];
        const applyState = (nextOpen: boolean) => {
          if (open === nextOpen) return;
          open = nextOpen;
          const phase = open ? "open" : "close";
          const sourceInteraction = interactions[triggerId];
          const interaction = sourceInteraction ? activeInteraction(sourceInteraction) : undefined;

          if (!interaction || interaction.type === "toggle") {
            trigger.setAttribute("aria-expanded", String(open));
          }

          if (interaction) {
            for (const target of interaction.targets) {
              const elements = document.querySelectorAll<HTMLElement>(
                "[data-framecoded-state='" + target.id + "']",
              );
              for (const element of elements) {
                const sampledKeyframes = open ? target.openKeyframes : target.closeKeyframes;
                const sampledProperties = new Set<string>();
                if (sampledKeyframes?.length) {
                  for (const frame of sampledKeyframes) {
                    for (const property of Object.keys(frame)) {
                      if (property !== "offset" && property !== "easing" && property !== "composite") {
                        sampledProperties.add(property);
                      }
                    }
                  }
                  const sampledAnimation = element.animate(waapiKeyframes(sampledKeyframes), {
                    duration: reduced
                      ? 0
                      : Number(open ? target.openDuration : target.closeDuration) || interaction.duration,
                    easing: "linear",
                    fill: "both",
                  });
                  running.push(sampledAnimation);
                }
                const groups = new Map<
                  string,
                  {
                    closed: Record<string, string>;
                    open: Record<string, string>;
                    duration: number;
                    delay: number;
                    easing: string;
                  }
                >();
                for (const property of Object.keys(target.closed)) {
                  if (sampledProperties.has(property)) continue;
                  const timing = target.timings?.[property];
                  const duration = reduced ? 0 : (timing?.duration ?? interaction.duration);
                  const delay = reduced ? 0 : (timing?.delay ?? 0);
                  const easing = timing?.easing ?? interaction.easing;
                  const key = duration + "|" + delay + "|" + easing;
                  const group = groups.get(key) ?? {
                    closed: {},
                    open: {},
                    duration,
                    delay,
                    easing,
                  };
                  group.closed[property] = target.closed[property];
                  group.open[property] = target.open[property];
                  groups.set(key, group);
                }
                for (const group of groups.values()) {
                  const animation = element.animate(
                    waapiKeyframes(open ? [group.closed, group.open] : [group.open, group.closed]),
                    {
                      duration: group.duration,
                      delay: group.delay,
                      easing: group.easing,
                      fill: "both",
                    },
                  );
                  running.push(animation);
                }
              }
            }
          }

          if (!reduced) {
            for (const tap of tapMotions.get(triggerId) ?? []) {
              if (tap.definition.phase !== phase) continue;
              const animation = createAnimation(tap.element, tap.definition);
              if (animation) running.push(animation);
            }
          }
        };

        if (sourceInteraction?.type === "hover") {
          const syncHoverState = () => applyState(hovered || focused);
          const onPointerEnter = () => { hovered = true; syncHoverState(); };
          const onPointerLeave = () => { hovered = false; syncHoverState(); };
          const onFocusIn = () => { focused = true; syncHoverState(); };
          const onFocusOut = (event: FocusEvent) => {
            if (event.relatedTarget instanceof Node && trigger.contains(event.relatedTarget)) return;
            focused = false;
            syncHoverState();
          };
          trigger.addEventListener("pointerenter", onPointerEnter);
          trigger.addEventListener("pointerleave", onPointerLeave);
          trigger.addEventListener("focusin", onFocusIn);
          trigger.addEventListener("focusout", onFocusOut);
          listenerCleanups.push(() => {
            trigger.removeEventListener("pointerenter", onPointerEnter);
            trigger.removeEventListener("pointerleave", onPointerLeave);
            trigger.removeEventListener("focusin", onFocusIn);
            trigger.removeEventListener("focusout", onFocusOut);
          });
        } else {
          const onClick = () => applyState(!open);
          trigger.addEventListener("click", onClick);
          listenerCleanups.push(() => trigger.removeEventListener("click", onClick));
        }
      }
    }

    const rootStyle = document.documentElement.style;
    const smoothScroll = getComputedStyle(document.documentElement).scrollBehavior === "smooth";
    if (smoothScroll) {
      const previousScrollBehavior = rootStyle.scrollBehavior;
      // "smooth" is the capture marker. The inertial loop needs immediate writes or the
      // browser would ease every intermediate frame a second time.
      rootStyle.scrollBehavior = "auto";
      listenerCleanups.push(() => { rootStyle.scrollBehavior = previousScrollBehavior; });

      if (!reduced) {
        let current = window.scrollY;
        let target = current;
        let scrollFrame = 0;

        const maximumScroll = () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        const clampTarget = (value: number) => Math.min(maximumScroll(), Math.max(0, value));
        const renderScroll = () => {
          current += (target - current) * 0.13;
          if (Math.abs(target - current) < 0.5) current = target;
          window.scrollTo(0, current);
          if (current === target) {
            scrollFrame = 0;
          } else {
            scrollFrame = requestAnimationFrame(renderScroll);
          }
        };
        const beginScroll = () => {
          if (!scrollFrame) scrollFrame = requestAnimationFrame(renderScroll);
        };
        const nestedScrollerCanMove = (origin: EventTarget | null, delta: number) => {
          let element = origin instanceof Element ? origin : null;
          while (element && element !== document.documentElement && element !== document.body) {
            const style = getComputedStyle(element);
            const scrollable = /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight;
            if (scrollable) {
              const canMoveUp = delta < 0 && element.scrollTop > 0;
              const canMoveDown = delta > 0 && element.scrollTop + element.clientHeight < element.scrollHeight - 1;
              if (canMoveUp || canMoveDown) return true;
            }
            element = element.parentElement;
          }
          return false;
        };
        const onWheel = (event: WheelEvent) => {
          if (event.defaultPrevented || event.ctrlKey || event.deltaY === 0) return;
          const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? 16
            : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
              ? window.innerHeight
              : 1;
          const delta = event.deltaY * scale;
          if (nestedScrollerCanMove(event.target, delta)) return;
          event.preventDefault();
          if (!scrollFrame) current = target = window.scrollY;
          target = clampTarget(target + delta);
          beginScroll();
        };
        const onExternalScroll = () => {
          if (scrollFrame) return;
          current = target = window.scrollY;
        };
        const onAnchorClick = (event: MouseEvent) => {
          if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          const origin = event.target instanceof Element ? event.target : null;
          const anchor = origin?.closest<HTMLAnchorElement>("a[href*='#']");
          if (!anchor) return;
          let destination: URL;
          try {
            destination = new URL(anchor.href, window.location.href);
          } catch {
            return;
          }
          if (destination.origin !== window.location.origin || destination.pathname !== window.location.pathname || !destination.hash) return;
          const id = decodeURIComponent(destination.hash.slice(1));
          const element = id ? document.getElementById(id) : document.documentElement;
          if (!element) return;
          event.preventDefault();
          current = window.scrollY;
          target = clampTarget(element.getBoundingClientRect().top + window.scrollY);
          if (window.location.hash !== destination.hash) history.pushState(null, "", destination.hash);
          beginScroll();
        };

        window.addEventListener("wheel", onWheel, { passive: false });
        window.addEventListener("scroll", onExternalScroll, { passive: true });
        document.addEventListener("click", onAnchorClick);
        listenerCleanups.push(() => {
          window.removeEventListener("wheel", onWheel);
          window.removeEventListener("scroll", onExternalScroll);
          document.removeEventListener("click", onAnchorClick);
          if (scrollFrame) cancelAnimationFrame(scrollFrame);
        });
      }
    }

    const cursors = document.querySelectorAll<HTMLElement>("[data-framecoded-cursor='true']");
    if (cursors.length && !window.matchMedia("(pointer: coarse)").matches) {
      const cursorEntries = Array.from(cursors).map((cursor) => {
        const source = cursor.dataset.framecodedCursorSource;
        const trigger = source
          ? document.querySelector<HTMLElement>("[data-framecoded-trigger='" + source + "']")
          : null;
        const placeholder = source && cursor.parentNode
          ? document.createComment("framecoded cursor portal")
          : undefined;
        if (placeholder && cursor.parentNode) {
          cursor.parentNode.insertBefore(placeholder, cursor);
          document.body.appendChild(cursor);
        }
        let opacityKeyframes: Keyframe[] | undefined;
        try {
          const parsed = JSON.parse(cursor.dataset.framecodedCursorOpacity || "") as Array<{
            offset?: number;
            opacity?: string | number;
          }>;
          if (Array.isArray(parsed) && parsed.length > 1) {
            opacityKeyframes = parsed
              .filter((frame) => Number.isFinite(Number(frame.offset)) && frame.opacity !== undefined)
              .map((frame) => ({ offset: Number(frame.offset), opacity: frame.opacity }));
          }
        } catch {
          opacityKeyframes = undefined;
        }
        const finalOpacity = opacityKeyframes?.at(-1)?.opacity ?? 1;
        return {
          cursor,
          source,
          trigger,
          placeholder,
          direct: cursor.dataset.framecodedCursorFollow === "direct",
          duration: Number(cursor.dataset.framecodedCursorDuration || 0),
          opacityKeyframes,
          finalOpacity,
          active: false,
          fade: undefined as Animation | undefined,
          enter: undefined as ((event: PointerEvent) => void) | undefined,
          leave: undefined as (() => void) | undefined,
        };
      });
      let targetX = window.innerWidth / 2;
      let targetY = window.innerHeight / 2;
      let currentX = targetX;
      let currentY = targetY;
      let frame = 0;
      const place = (cursor: HTMLElement, x: number, y: number) => {
        cursor.style.transform =
          "translate(-50%, -50%) translate3d(" + x + "px," + y + "px,0)";
      };
      const show = (entry: (typeof cursorEntries)[number], event: PointerEvent) => {
        targetX = event.clientX;
        targetY = event.clientY;
        entry.active = true;
        entry.fade?.cancel();
        if (entry.direct) place(entry.cursor, targetX, targetY);
        if (reduced || entry.duration <= 0 || !entry.opacityKeyframes?.length) {
          entry.cursor.style.opacity = String(entry.finalOpacity);
        } else {
          entry.fade = entry.cursor.animate(
            entry.opacityKeyframes,
            { duration: entry.duration, easing: "linear", fill: "forwards" },
          );
        }
      };
      const hide = (entry: (typeof cursorEntries)[number]) => {
        entry.active = false;
        entry.fade?.cancel();
        entry.fade = undefined;
        entry.cursor.style.opacity = "0";
      };
      for (const entry of cursorEntries) {
        if (!entry.trigger) continue;
        entry.enter = (event) => show(entry, event);
        entry.leave = () => hide(entry);
        entry.trigger.addEventListener("pointerenter", entry.enter);
        entry.trigger.addEventListener("pointerleave", entry.leave);
      }
      const onPointerMove = (event: PointerEvent) => {
        targetX = event.clientX;
        targetY = event.clientY;
        for (const entry of cursorEntries) {
          if (!entry.source && !entry.active) show(entry, event);
          if (entry.active && entry.direct) place(entry.cursor, targetX, targetY);
        }
      };
      const renderCursor = () => {
        const interpolation = reduced ? 1 : 0.16;
        currentX += (targetX - currentX) * interpolation;
        currentY += (targetY - currentY) * interpolation;
        for (const entry of cursorEntries) {
          if (entry.active && !entry.direct) place(entry.cursor, currentX, currentY);
        }
        frame = requestAnimationFrame(renderCursor);
      };
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      frame = requestAnimationFrame(renderCursor);
      listenerCleanups.push(() => {
        window.removeEventListener("pointermove", onPointerMove);
        cancelAnimationFrame(frame);
        for (const entry of cursorEntries) {
          entry.fade?.cancel();
          if (entry.trigger && entry.enter) entry.trigger.removeEventListener("pointerenter", entry.enter);
          if (entry.trigger && entry.leave) entry.trigger.removeEventListener("pointerleave", entry.leave);
          if (entry.placeholder?.parentNode) {
            entry.placeholder.parentNode.insertBefore(entry.cursor, entry.placeholder);
            entry.placeholder.remove();
          }
        }
      });
    }

    return () => {
      for (const cleanup of listenerCleanups) cleanup();
      for (const observer of observers) observer.disconnect();
      for (const animation of running) animation.cancel();
    };
  }, [definitions, interactions, responsiveRevision]);

  return (
    <script
      data-framecoded-motion-bootstrap="true"
      dangerouslySetInnerHTML={{ __html: motionBootstrapScript(definitions) }}
    />
  );
}
`;

export const ROUTER = `import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
`;

/**
 * Zero-dependency production server: serves built static assets from dist/client
 * (Vite copies /public there too) and falls back to the TanStack Start SSR fetch
 * handler. Run with `node server.mjs` after `npm run build`. No extra deps, so it
 * self-hosts anywhere Node runs.
 */
export const SERVER_MJS = `import { createServer } from "node:http";
import { stat, readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import handler from "./dist/server/server.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const clientDir = join(root, "dist", "client");
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif",
  ".gif": "image/gif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".xml": "application/xml", ".txt": "text/plain; charset=utf-8",
};

async function serveStatic(res, urlPath) {
  if (urlPath === "/" || urlPath.endsWith("/")) return false;
  const filePath = normalize(join(clientDir, decodeURIComponent(urlPath)));
  if (!filePath.startsWith(clientDir)) return false; // path traversal guard
  try {
    const s = await stat(filePath);
    if (!s.isFile()) return false;
    const ext = filePath.slice(filePath.lastIndexOf("."));
    const data = await readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": urlPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600",
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

createServer(async (req, res) => {
  try {
    const urlPath = (req.url || "/").split("?")[0];
    if (await serveStatic(res, urlPath)) return;

    const url = "http://" + (req.headers.host || "localhost") + (req.url || "/");
    const method = req.method || "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    const request = new Request(url, {
      method,
      headers: req.headers,
      body: hasBody ? req : undefined,
      duplex: hasBody ? "half" : undefined,
    });
    const response = await handler.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      for await (const chunk of response.body) res.write(chunk);
    }
    res.end();
  } catch (err) {
    console.error(err);
    res.writeHead(500);
    res.end("Internal Server Error");
  }
}).listen(port, host, () => {
  console.log("▶ Production server on http://" + host + ":" + port);
});
`;

export function packageJson(name: string): string {
  const safe =
    name
      .replace(/\.framer\.website$/i, "")
      .replace(/[^a-z0-9-]/gi, "-")
      .toLowerCase()
      .replace(/^-+|-+$/g, "") || "framer-site";
  return (
    JSON.stringify(
      {
        name: safe,
        private: true,
        type: "module",
        scripts: {
          seo: "node scripts/generate-seo.mjs",
          predev: "npm run seo",
          dev: "vite dev",
          prebuild: "npm run seo",
          build: "vite build",
          start: "node .output/server/index.mjs",
        },
        engines: {
          node: "^20.19.0 || >=22.12.0",
        },
        dependencies: {
          "@tanstack/react-router": "1.170.18",
          "@tanstack/react-start": "1.168.34",
          nitro: "3.0.260610-beta",
          react: "19.2.8",
          "react-dom": "19.2.8",
        },
        devDependencies: {
          "@types/node": "^22.9.0",
          "@types/react": "19.2.18",
          "@types/react-dom": "19.2.4",
          "@vitejs/plugin-react": "6.0.5",
          typescript: "7.0.2",
          vite: "8.2.0",
        },
      },
      null,
      2,
    ) + "\n"
  );
}
