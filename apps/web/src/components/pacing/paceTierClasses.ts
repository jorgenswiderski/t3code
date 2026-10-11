import type { PaceTierColor } from "@t3tools/shared/usagePacing";

/** Full literal class names so Tailwind's scanner emits them. */
export const PACE_TIER_CLASSES: Readonly<
  Record<PaceTierColor, { readonly text: string; readonly bg: string; readonly stroke: string }>
> = {
  success: { text: "text-success", bg: "bg-success", stroke: "stroke-success" },
  yellow: { text: "text-yellow-400", bg: "bg-yellow-400", stroke: "stroke-yellow-400" },
  orange: { text: "text-orange-500", bg: "bg-orange-500", stroke: "stroke-orange-500" },
  destructive: { text: "text-destructive", bg: "bg-destructive", stroke: "stroke-destructive" },
  muted: {
    text: "text-muted-foreground",
    bg: "bg-muted-foreground",
    stroke: "stroke-muted-foreground",
  },
};
