import type {
  TicketChip,
  threadPriorityIndicator,
  threadPriorityMenu,
} from "@t3tools/client-runtime/state/thread-ticket-presentation";
import * as Clipboard from "expo-clipboard";
import { memo } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import type { MenuProps } from "../../components/ui/Menu.types";
import { cn } from "../../lib/cn";
import { buildPriorityMenuAction } from "./thread-ticket-menu";
import type { ThreadTicketActions } from "./useThreadTicketActions";

type MenuAction = MenuProps["actions"][number];

const STATUS_TONE_CLASS = {
  success: "text-adaptive-emerald-600-400",
  info: "text-adaptive-sky-600-400",
  neutral: "text-foreground-muted",
} as const;

function statusPresentation(chip: TicketChip) {
  switch (chip.status.kind) {
    case "synced":
      return { text: chip.status.name, className: STATUS_TONE_CLASS[chip.status.tone] };
    case "unreachable":
      return { text: chip.status.label, className: "text-warning-foreground" };
    case "pending":
      return { text: chip.status.label, className: "text-warning-foreground" };
  }
}

export function ticketChipRowKey(chip: TicketChip) {
  return chip.key;
}

export const TicketChipRow = memo(function TicketChipRow(props: {
  readonly chip: TicketChip;
  readonly separator: boolean;
  readonly actions: ThreadTicketActions;
}) {
  const { chip, actions } = props;
  const status = statusPresentation(chip);
  const reasonText = chip.status.kind === "unreachable" ? chip.status.reasonText : null;
  const url = chip.url;
  const menuActions: MenuAction[] = [
    ...(url ? [{ id: "open", title: "Open in Jira", image: "safari" }] : []),
    ...(url ? [{ id: "copy", title: "Copy link", image: "link" }] : []),
    // Existing links stay removable whatever the Jira connection state.
    ...(actions.canOperate
      ? [
          {
            id: "unlink",
            title: "Unlink",
            image: "xmark",
            attributes: { destructive: true },
          },
        ]
      : []),
  ];
  const row = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${chip.key}, ${chip.title ?? "no title"}, ${status.text}${reasonText ? `, ${reasonText}` : ""}, ${chip.sourceLabel}`}
      accessibilityHint={menuActions.length > 0 ? "Touch and hold for actions." : undefined}
      accessibilityState={{ disabled: url === null }}
      testID={`ticket-chip-${chip.key}`}
      disabled={url === null}
      onPress={() => {
        if (url) actions.openTicket(url);
      }}
      className="flex-row gap-3 rounded-xl px-4 active:bg-row-hover"
    >
      <View className="self-start pt-2.5">
        <SymbolView name="ticket" size={20} tintColorClassName="accent-icon-muted" />
      </View>
      <View
        className={cn(
          "min-w-0 flex-1 gap-1 py-2.5",
          props.separator && "border-b border-border-subtle",
          chip.unreachable && "opacity-60",
        )}
      >
        <View className="flex-row items-center gap-2">
          <Text
            className="shrink-0 text-xs text-foreground-muted"
            style={{ fontFamily: "Menlo" }}
            testID={chip.unreachable ? "ticket-chip-unreachable" : undefined}
          >
            {chip.key}
          </Text>
          <View className="flex-1" />
          <Text className={cn("text-xs font-t3-medium", status.className)} numberOfLines={1}>
            {status.text}
          </Text>
        </View>
        <Text
          className="text-base leading-5 font-t3-medium text-foreground"
          numberOfLines={2}
          ellipsizeMode="tail"
        >
          {chip.title ?? "Waiting for Jira"}
        </Text>
        <Text className="text-xs text-foreground-tertiary" numberOfLines={1}>
          {reasonText ? `${reasonText} · ${chip.sourceLabel}` : chip.sourceLabel}
        </Text>
      </View>
    </Pressable>
  );
  return (
    <Menu
      shouldOpenOnLongPress
      title={chip.key}
      actions={menuActions}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "open" && url) actions.openTicket(url);
        else if (nativeEvent.event === "copy" && url) void Clipboard.setStringAsync(url);
        else if (nativeEvent.event === "unlink") actions.unlink(chip.key);
      }}
    >
      {row}
    </Menu>
  );
});

export function ThreadPriorityRow(props: {
  readonly indicator: ReturnType<typeof threadPriorityIndicator>;
  readonly menu: ReturnType<typeof threadPriorityMenu>;
  readonly actions: ThreadTicketActions;
}) {
  const { indicator, menu, actions } = props;
  const current = indicator?.tooltip ?? "None";
  const row = (
    <View
      accessible
      accessibilityRole={actions.canOperate ? "button" : "text"}
      accessibilityLabel={`Priority: ${indicator?.accessibilityLabel ?? "none"}`}
      accessibilityHint={actions.canOperate ? "Opens the priority menu." : undefined}
      testID="thread-priority-row"
      className="flex-row items-center gap-3 px-4 py-2.5"
    >
      <SymbolView name="flag" size={20} tintColorClassName="accent-icon-muted" />
      <Text className="text-base font-t3-medium text-foreground">Priority</Text>
      <Text className="min-w-0 flex-1 text-right text-sm text-foreground-muted" numberOfLines={1}>
        {current}
      </Text>
      {actions.canOperate ? (
        <SymbolView name="chevron.down" size={12} tintColorClassName="accent-foreground-muted" />
      ) : null}
    </View>
  );
  if (!actions.canOperate) return row;
  return (
    <Menu
      title="Priority"
      actions={buildPriorityMenuAction(menu).subactions ?? []}
      onPressAction={({ nativeEvent }) => actions.handleTicketMenuAction(nativeEvent.event)}
    >
      {row}
    </Menu>
  );
}
