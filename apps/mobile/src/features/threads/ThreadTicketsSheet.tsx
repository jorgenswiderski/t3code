import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { LegendList } from "@legendapp/list/react-native";
import {
  jiraSyncNotice,
  orderTicketChips,
  threadPriorityIndicator,
  threadPriorityMenu,
  ticketUiAvailability,
  visibleTicketChips,
} from "@t3tools/client-runtime/state/thread-ticket-presentation";
import { ticketPriorityScaleOf } from "@t3tools/client-runtime/state/thread-priority";
import { useMemo } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { useThreadSelection } from "../../state/use-thread-selection";
import { TicketChipRow, ThreadPriorityRow, ticketChipRowKey } from "./ThreadTicketRows";
import { useThreadTicketActions } from "./useThreadTicketActions";

function formatSince(since: string): string {
  const date = new Date(since);
  return Number.isNaN(date.getTime())
    ? since
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

export function ThreadTicketsSheet(
  _props: StaticScreenProps<{ readonly environmentId: string; readonly threadId: string }>,
) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { selectedThread, selectedEnvironmentRuntime } = useThreadSelection();
  const config = selectedEnvironmentRuntime?.serverConfig ?? null;
  const availability = ticketUiAvailability(config);
  const actions = useThreadTicketActions(selectedThread);
  const scale = ticketPriorityScaleOf(config);
  const siteUrl = config?.settings.jira?.siteUrl ?? null;
  const ticketLinks = selectedThread?.ticketLinks;
  const chips = useMemo(
    () =>
      orderTicketChips(
        visibleTicketChips(ticketLinks ?? [], {
          jiraConnected: availability.jiraConnected,
          siteUrl,
        }),
      ),
    [ticketLinks, availability.jiraConnected, siteUrl],
  );
  const notice = jiraSyncNotice(config?.jiraStatus);
  const priorityThread = selectedThread
    ? { priority: selectedThread.priority, ticketLinks: selectedThread.ticketLinks }
    : null;
  const indicator = priorityThread ? threadPriorityIndicator(priorityThread, scale) : null;
  const priorityMenu = priorityThread ? threadPriorityMenu(priorityThread, scale) : null;
  const rowInputs = { chips, actions };

  const content = (
    <View className="flex-1 android:bg-sheet-solid ios:bg-screen">
      {/* oxlint-disable-next-line t3code/require-registered-list-scroll -- Sheet content; sheets sit outside workspace columns and keep their own header handling. */}
      <LegendList
        data={chips}
        keyExtractor={ticketChipRowKey}
        extraData={rowInputs}
        renderItem={({ item, index }) => (
          <TicketChipRow chip={item} separator={index < chips.length - 1} actions={actions} />
        )}
        estimatedItemSize={88}
        recycleItems
        alwaysBounceVertical
        style={{ flex: 1 }}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          paddingHorizontal: 8,
        }}
        ListHeaderComponent={
          <View>
            {availability.priority && priorityMenu ? (
              <ThreadPriorityRow indicator={indicator} menu={priorityMenu} actions={actions} />
            ) : null}
            {notice ? (
              <Text className="px-4 pt-2 pb-1 text-xs text-foreground-muted" testID="jira-notice">
                Jira could not be reached since {formatSince(notice.since)}. Showing the last known
                data.
              </Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          <Text className="pt-6 text-center text-sm text-foreground-muted">No linked tickets.</Text>
        }
      />
    </View>
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader
        title="Jira tickets"
        onClose={() => navigation.goBack()}
        actions={
          availability.linkTicket && actions.canOperate
            ? [
                {
                  accessibilityLabel: "Link Jira ticket",
                  icon: "plus",
                  onPress: actions.promptLink,
                },
              ]
            : undefined
        }
      />
      <ScreenContent>{content}</ScreenContent>
    </View>
  );
}
