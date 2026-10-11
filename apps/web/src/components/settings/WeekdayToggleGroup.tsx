import type { ReactElement } from "react";

import { Toggle, ToggleGroup } from "../ui/toggle-group";

/** JS day-of-week (0 = Sunday) rendered Monday-first, matching how people read a week. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

/** Monday-first weekday picker; `value` and `onChange` use weekday ints (0 = Sunday). The last
    selected day cannot be removed. */
export function WeekdayToggleGroup(props: {
  readonly value: ReadonlyArray<number>;
  readonly onChange: (days: number[]) => void;
  readonly "aria-label": string;
}): ReactElement {
  return (
    <ToggleGroup
      multiple
      variant="outline"
      size="sm"
      aria-label={props["aria-label"]}
      value={props.value.map(String)}
      onValueChange={(values) => {
        if (values.length === 0) return;
        props.onChange(values.map(Number));
      }}
    >
      {WEEKDAY_ORDER.map((day) => (
        <Toggle key={day} value={String(day)} aria-label={WEEKDAY_LABELS[day]}>
          {WEEKDAY_SHORT[day]}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
