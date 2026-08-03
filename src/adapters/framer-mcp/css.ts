/**
 * Framer MCP trait attributes → CSS.
 *
 * `getNodeXml` returns elements whose attributes are the documented Framer traits,
 * already in CSS-shaped values (e.g. width="400px", height="1fr", gap="16px",
 * backgroundColor="rgb(...)", borderRadius="8px", fontSize="24px"). This maps them to
 * plain CSS declarations — the same trait model as the Plugin API, so it's close to 1:1.
 */
import type { CssDecls } from "../../ir/types.js";

export type Attrs = Record<string, string>;

export type McpNodeType = "Frame" | "Text" | "SVG" | "ComponentInstance";

/** Infer the node type from attributes + whether it has direct text (mirrors Framer's MCP). */
export function determineNodeType(attrs: Attrs, hasDirectText: boolean): McpNodeType {
  if (hasDirectText && !attrs["layout"] && !attrs["svg"] && !attrs["componentId"]) return "Text";
  if (attrs["componentId"] || attrs["insertUrl"]) return "ComponentInstance";
  if (attrs["svg"]) return "SVG";
  return "Frame";
}

const STACK_DISTRIBUTION: Record<string, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  "space-between": "space-between",
  "space-around": "space-around",
  "space-evenly": "space-evenly",
};
const STACK_ALIGNMENT: Record<string, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
};

const GRID_CONTENT_ALIGNMENT: Record<string, string> = {
  start: "start",
  center: "center",
  end: "end",
  "space-between": "space-between",
  "space-around": "space-around",
  "space-evenly": "space-evenly",
};
const GRID_ITEM_ALIGNMENT: Record<string, string> = {
  start: "start",
  center: "center",
  end: "end",
  stretch: "stretch",
};

/**
 * Grid track sizing. Framer models columns as a count plus a width *type*: `fixed`
 * pins each track, `minmax` lets tracks grow from a floor — which is also how an
 * `auto-fill` grid stays responsive without a media query.
 */
function gridColumns(attrs: Attrs): string | undefined {
  const count = attrs["gridColumns"];
  if (!count) return undefined;
  const type = attrs["gridColumnWidthType"];
  const track =
    type === "fixed" && attrs["gridColumnWidth"]
      ? attrs["gridColumnWidth"]
      : type === "minmax" && attrs["gridColumnMinWidth"]
        ? `minmax(${attrs["gridColumnMinWidth"]}, 1fr)`
        : "1fr";
  return `repeat(${count === "auto-fill" ? "auto-fill" : count}, ${track})`;
}

function gridRows(attrs: Attrs): string | undefined {
  const count = attrs["gridRows"];
  if (!count) return undefined;
  const type = attrs["gridRowHeightType"];
  const track = type === "fixed" && attrs["gridRowHeight"] ? attrs["gridRowHeight"] : "auto";
  return `repeat(${count}, ${track})`;
}

function sizeValue(prop: "width" | "height", v: string, css: CssDecls) {
  const val = v.trim();
  if (val.endsWith("fr")) {
    // Fractional length = fill available space in a stack.
    css["flex-grow"] = "1";
    css["flex-basis"] = "0";
    css["flex-shrink"] = "1";
  } else {
    css[prop] = val;
  }
}

/** Map a node's trait attributes to CSS declarations. */
export function traitsToCss(attrs: Attrs): CssDecls {
  const css: CssDecls = {};
  const set = (k: string, v: string | undefined | null) => {
    if (v != null && v !== "") css[k] = v;
  };

  if (attrs["width"]) sizeValue("width", attrs["width"], css);
  if (attrs["height"]) sizeValue("height", attrs["height"], css);
  set("max-width", attrs["maxWidth"]);
  set("min-width", attrs["minWidth"]);
  set("max-height", attrs["maxHeight"]);
  set("min-height", attrs["minHeight"]);
  if (attrs["aspectRatio"]) set("aspect-ratio", attrs["aspectRatio"]);

  set("background-color", attrs["backgroundColor"]);
  if (attrs["backgroundGradient"]) set("background", attrs["backgroundGradient"]);
  set("opacity", attrs["opacity"]);
  set("border-radius", attrs["borderRadius"]);
  set("color", attrs["color"]);
  set("z-index", attrs["zIndex"]);
  set("overflow", attrs["overflow"]);
  set("overflow-x", attrs["overflowX"]);
  set("overflow-y", attrs["overflowY"]);

  // Transform is a single property, so rotation and centre-pinning have to be composed
  // rather than written independently — the second `set` would otherwise erase the first.
  const transforms: string[] = [];
  if (attrs["centerX"]) {
    set("left", attrs["centerX"]);
    transforms.push("translateX(-50%)");
  }
  if (attrs["centerY"]) {
    set("top", attrs["centerY"]);
    transforms.push("translateY(-50%)");
  }
  if (attrs["rotation"] && attrs["rotation"] !== "0") {
    const deg = /deg|rad|turn/.test(attrs["rotation"]) ? attrs["rotation"] : `${attrs["rotation"]}deg`;
    transforms.push(`rotate(${deg})`);
  }
  if (transforms.length) set("transform", transforms.join(" "));

  // Border. Framer's borderWidth can be a 4-value per-side string ("0px 0px 1px 0px"),
  // which is INVALID in the `border` shorthand — emit a clean per-side / longhand form.
  if (attrs["borderWidth"] || attrs["borderColor"] || attrs["borderStyle"]) {
    const w = (attrs["borderWidth"] ?? "1px").trim();
    const s = attrs["borderStyle"] ?? "solid";
    const c = attrs["borderColor"] ?? "currentColor";
    const parts = w.split(/\s+/);
    if (parts.length <= 1) {
      set("border", `${w} ${s} ${c}`);
    } else {
      const sides = ["top", "right", "bottom", "left"] as const;
      const nonZero = parts
        .map((p, i) => ({ p, side: sides[i] }))
        .filter((x) => x.side && parseFloat(x.p) > 0);
      if (parts.length === 4 && nonZero.length === 1) {
        set(`border-${nonZero[0]!.side}`, `${nonZero[0]!.p} ${s} ${c}`);
      } else {
        set("border-style", s);
        set("border-color", c);
        set("border-width", w);
      }
    }
  }

  // Layout. Mirrors Framer's own "Copy CSS" output for stacks.
  const layout = attrs["layout"];
  if (layout === "stack") {
    set("display", "flex");
    set("flex-direction", attrs["stackDirection"] === "horizontal" ? "row" : "column");
    const wrap = attrs["stackWrap"] === "true" || attrs["stackWrapEnabled"] === "true";
    set("flex-wrap", wrap ? "wrap" : "nowrap");
    const justify = attrs["stackDistribution"]
      ? STACK_DISTRIBUTION[attrs["stackDistribution"]] ?? attrs["stackDistribution"]
      : "flex-start";
    set("justify-content", justify);
    const align = attrs["stackAlignment"]
      ? STACK_ALIGNMENT[attrs["stackAlignment"]] ?? attrs["stackAlignment"]
      : "flex-start";
    set("align-items", align);
    set("align-content", align);
    set("gap", attrs["gap"] ?? "0px");
    set("padding", attrs["padding"] ?? "0px");
  } else if (layout === "grid") {
    set("display", "grid");
    set("grid-template-columns", gridColumns(attrs));
    set("grid-template-rows", gridRows(attrs));
    if (attrs["gridAlignment"]) {
      set("place-content", GRID_CONTENT_ALIGNMENT[attrs["gridAlignment"]] ?? attrs["gridAlignment"]);
    }
    set("gap", attrs["gap"]);
    set("padding", attrs["padding"]);
  } else if (attrs["padding"]) {
    set("padding", attrs["padding"]);
  }

  // Placement of this node inside a parent grid.
  if (attrs["gridItemColumnSpan"]) set("grid-column", `span ${attrs["gridItemColumnSpan"]}`);
  if (attrs["gridItemRowSpan"]) set("grid-row", `span ${attrs["gridItemRowSpan"]}`);
  if (attrs["gridItemFillWidth"] === "true") set("justify-self", "stretch");
  else if (attrs["gridItemHorizontalAlignment"]) {
    set("justify-self", GRID_ITEM_ALIGNMENT[attrs["gridItemHorizontalAlignment"]] ?? attrs["gridItemHorizontalAlignment"]);
  }
  if (attrs["gridItemFillHeight"] === "true") set("align-self", "stretch");
  else if (attrs["gridItemVerticalAlignment"]) {
    set("align-self", GRID_ITEM_ALIGNMENT[attrs["gridItemVerticalAlignment"]] ?? attrs["gridItemVerticalAlignment"]);
  }

  // Positioning.
  if (attrs["position"] && attrs["position"] !== "relative") {
    set("position", attrs["position"]);
    for (const side of ["top", "right", "bottom", "left"] as const) set(side, attrs[side]);
  }

  // Typography (Text nodes).
  set("font-size", attrs["fontSize"]);
  set("line-height", attrs["lineHeight"]);
  set("letter-spacing", attrs["letterSpacing"]);
  if (attrs["fontWeight"]) set("font-weight", attrs["fontWeight"]);
  if (attrs["fontStyle"]) set("font-style", attrs["fontStyle"]);
  if (attrs["font"] && attrs["font"] !== "selector") {
    const fam = attrs["font"].replace(/['"]/g, "");
    const mono = /\bmono\b|code|courier|consol/i.test(fam);
    set("font-family", `"${fam}", ${mono ? "ui-monospace, monospace" : "system-ui, sans-serif"}`);
  }
  if (attrs["textAlign"]) set("text-align", attrs["textAlign"]);
  if (attrs["textTransform"]) set("text-transform", attrs["textTransform"]);
  if (attrs["textTruncation"]) {
    const lines = parseInt(attrs["textTruncation"], 10);
    if (Number.isFinite(lines)) {
      set("display", "-webkit-box");
      set("-webkit-box-orient", "vertical");
      set("-webkit-line-clamp", String(lines));
      set("overflow", "hidden");
    }
  }

  return css;
}
