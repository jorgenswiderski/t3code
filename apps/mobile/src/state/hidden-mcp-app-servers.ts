import type { EnvironmentId } from "@t3tools/contracts";
import { setMcpAppServerHidden as queueMcpAppServerHidden } from "@t3tools/client-runtime/state/hidden-mcp-app-servers";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";

import { appAtomRegistry } from "./atom-registry";
import { serverEnvironment } from "./server";

export const OUTDATED_SERVER_MESSAGE = "This environment's server may need an update.";

export function setMcpAppServerHidden(
  environmentId: EnvironmentId,
  server: string,
  hidden: boolean,
) {
  return queueMcpAppServerHidden({
    environmentId,
    server,
    hidden,
    readCurrent: () =>
      appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId))?.hiddenMcpAppServers,
    write: (hiddenMcpAppServers) =>
      runAtomCommand(
        appAtomRegistry,
        serverEnvironment.updateSettings,
        { environmentId, input: { patch: { hiddenMcpAppServers } } },
        { label: "hidden MCP app servers", reportFailure: false },
      ),
  });
}
