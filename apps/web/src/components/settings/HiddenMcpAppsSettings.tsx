import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { setMcpAppServerHidden } from "~/state/hiddenMcpAppServers";
import { serverEnvironment } from "~/state/server";
import { Button } from "../ui/button";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const DESCRIPTION_CLASS_NAME = "px-3 py-3 text-xs text-muted-foreground sm:px-4";

export function HiddenMcpAppsSettings() {
  const { scope, environment } = useSettingsScope();
  return (
    <SettingsSection {...searchableSetting("hidden-mcp-apps")}>
      {scope.environmentIds.length === 1 && environment !== null ? (
        <HiddenMcpAppsList environmentId={environment.environmentId} />
      ) : (
        <SettingsScopeNotice inline target="environment">
          Choose one environment to see which MCP apps it hides.
        </SettingsScopeNotice>
      )}
    </SettingsSection>
  );
}

function HiddenMcpAppsList({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const servers = [...useAtomValue(serverEnvironment.hiddenMcpAppServersAtom(environmentId))];
  if (servers.length === 0) {
    return (
      <p className={DESCRIPTION_CLASS_NAME}>
        Apps from all MCP servers show inline. Hide a server from its app card.
      </p>
    );
  }
  return (
    <>
      <p className={DESCRIPTION_CLASS_NAME}>
        Tool calls from these servers show as plain tool rows instead of apps.
      </p>
      {servers.map((server) => (
        <SettingsRow
          key={server}
          title={server}
          serverScoped
          control={
            <Button
              size="xs"
              variant="outline"
              aria-label={`Show apps from ${server}`}
              onClick={() => void setMcpAppServerHidden(environmentId, server, false)}
            >
              Show
            </Button>
          }
        />
      ))}
    </>
  );
}
