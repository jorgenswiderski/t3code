import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { View } from "react-native";

import { AppText } from "../../../components/ui/AppText";
import * as Dialog from "../../../components/ui/Dialog";
import { Button } from "../../../components/ui/Button";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import {
  OUTDATED_SERVER_MESSAGE,
  setMcpAppServerHidden,
} from "../../../state/hidden-mcp-app-servers";
import { serverEnvironment } from "../../../state/server";
import type { SettingsTarget } from "../settings-environment-filter";
import { SettingsSection } from "./SettingsSection";

const TITLE = "Hidden MCP apps";

export function HiddenMcpAppsSection(props: {
  readonly environments: readonly SettingsTarget[];
  readonly canWrite: (environmentId: EnvironmentId) => boolean;
}) {
  return (
    <>
      {props.environments.map((environment) => (
        <EnvironmentHiddenMcpApps
          key={environment.environmentId}
          environment={environment}
          title={props.environments.length > 1 ? `${TITLE} · ${environment.label}` : TITLE}
          canWrite={props.canWrite(environment.environmentId)}
        />
      ))}
    </>
  );
}

function EnvironmentHiddenMcpApps(props: {
  readonly environment: SettingsTarget;
  readonly title: string;
  readonly canWrite: boolean;
}) {
  const { environment } = props;
  const servers = [
    ...useAtomValue(serverEnvironment.hiddenMcpAppServersAtom(environment.environmentId)),
  ];

  const show = async (server: string) => {
    const outcome = await setMcpAppServerHidden(environment.environmentId, server, false);
    if (outcome._tag === "Applied" || outcome._tag === "Interrupted") return;
    Dialog.alert(
      "Could not save settings",
      `${environment.label}: ${
        outcome._tag === "Failed"
          ? outcome.error instanceof Error
            ? outcome.error.message
            : String(outcome.error)
          : OUTDATED_SERVER_MESSAGE
      }`,
    );
  };

  return (
    <SettingsSection
      title={props.title}
      footer={
        servers.length > 0
          ? "Tool calls from these servers show as plain tool rows instead of apps."
          : undefined
      }
    >
      {servers.length === 0 ? (
        <View className="px-4 py-3">
          <AppText textRole="footnote" className="text-foreground-muted">
            Apps from all MCP servers show inline. Hide a server from its app card.
          </AppText>
        </View>
      ) : (
        servers.map((server, index) => (
          <View key={server} className={index === 0 ? undefined : "border-t border-border-subtle"}>
            <ListRowLayout
              label={server}
              accessory={
                props.canWrite ? (
                  <Button
                    label="Show"
                    accessibilityLabel={`Show apps from ${server}`}
                    onPress={() => void show(server)}
                  />
                ) : undefined
              }
            />
          </View>
        ))
      )}
    </SettingsSection>
  );
}
