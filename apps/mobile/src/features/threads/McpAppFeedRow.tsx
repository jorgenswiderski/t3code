import { AuthSettingsWriteScope, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useRef } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { OUTDATED_SERVER_MESSAGE, setMcpAppServerHidden } from "../../state/hidden-mcp-app-servers";
import { useEnvironmentScope } from "../../state/session";
import { showGitActionResult } from "../../state/use-vcs-action-state";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { ThreadMcpApp } from "./McpAppWebView";

export function McpAppFeedRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly entry: Extract<ThreadFeedEntry, { readonly type: "mcp-app" }>;
  readonly width: number;
}) {
  const { environmentId, entry } = props;
  const { app } = entry;
  const canHide = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const writing = useRef(false);

  const write = async () => {
    const outcome = await setMcpAppServerHidden(environmentId, app.server, true);
    if (outcome._tag === "Applied") {
      showGitActionResult({
        type: "success",
        title: `Apps from ${app.server} hidden`,
        description: "Show them again in Settings → Threads.",
      });
    } else if (outcome._tag !== "Interrupted") {
      showGitActionResult({
        type: "error",
        title: `Could not hide apps from ${app.server}`,
        description:
          outcome._tag === "Failed"
            ? outcome.error instanceof Error
              ? outcome.error.message
              : String(outcome.error)
            : OUTDATED_SERVER_MESSAGE,
      });
    }
  };

  const hide = () => {
    if (writing.current) return;
    writing.current = true;
    void write().finally(() => {
      writing.current = false;
    });
  };

  return (
    <View>
      <View className="flex-row items-center">
        <Text
          className="min-w-0 flex-1 text-foreground-muted"
          numberOfLines={1}
          textRole="footnote"
        >
          {`${app.server} · ${app.tool}`}
        </Text>
        {canHide ? (
          <Pressable
            accessibilityLabel={`Hide apps from ${app.server}`}
            accessibilityRole="button"
            className="min-h-11 min-w-11 items-center justify-center active:opacity-60"
            onPress={hide}
          >
            <SymbolView
              name="eye.slash"
              size={18}
              tintColorClassName="accent-icon-subtle"
              type="monochrome"
            />
          </Pressable>
        ) : null}
      </View>
      <ThreadMcpApp
        environmentId={environmentId}
        threadId={entry.sourceThreadId}
        conversationThreadId={props.threadId}
        itemId={entry.itemId}
        revision={entry.revision}
        app={app}
        width={props.width}
      />
    </View>
  );
}
