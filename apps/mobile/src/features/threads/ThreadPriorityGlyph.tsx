import type {
  PriorityGlyphLevel,
  ThreadPriorityIndicator,
} from "@t3tools/client-runtime/state/thread-ticket-presentation";
import { View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { selectedThreadRowColors } from "./thread-list-v2-row-appearance";

// Shape carries the level, so colour alone never does (accessibility).
const LEVEL_GLYPHS = {
  0: { name: "chevron.up.2", tint: "accent-danger-foreground" },
  1: { name: "chevron.up", tint: "accent-warning-foreground" },
  2: { name: "equal", tint: null },
  3: { name: "chevron.down", tint: null },
  4: { name: "chevron.down.2", tint: null },
} satisfies Record<PriorityGlyphLevel, { name: AppSymbolName; tint: string | null }>;

/** Non-interactive; touch has no tooltip, so the label lives on the glyph and the row. */
export function ThreadPriorityGlyph(props: {
  readonly indicator: ThreadPriorityIndicator;
  readonly selected: boolean;
  readonly mutedTintClassName: string;
}) {
  const { indicator } = props;
  const glyph =
    indicator.kind === "resolved"
      ? LEVEL_GLYPHS[indicator.level]
      : ({ name: "circle.dashed", tint: null } as const);
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={indicator.accessibilityLabel}
      testID={
        indicator.kind === "resolved"
          ? `thread-priority-${indicator.source}`
          : "thread-priority-unresolved"
      }
    >
      <SymbolView
        name={glyph.name}
        size={12}
        tintColorClassName={
          props.selected
            ? selectedThreadRowColors.iconTintClassName
            : (glyph.tint ?? props.mutedTintClassName)
        }
        type="monochrome"
        weight="semibold"
      />
    </View>
  );
}
