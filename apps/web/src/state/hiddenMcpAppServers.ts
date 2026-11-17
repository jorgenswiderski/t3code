import type { EnvironmentId } from "@t3tools/contracts";
import { setMcpAppServerHidden as queueMcpAppServerHidden } from "@t3tools/client-runtime/state/hidden-mcp-app-servers";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { toastManager } from "~/components/ui/toast";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";

const OUTDATED_SERVER_MESSAGE = "This environment's server may need an update.";

export async function setMcpAppServerHidden(
  environmentId: EnvironmentId,
  server: string,
  hidden: boolean,
): Promise<boolean> {
  const outcome = await queueMcpAppServerHidden({
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
  if (outcome._tag === "Applied") return true;
  if (outcome._tag === "Interrupted") return false;
  toastManager.add({
    type: "error",
    title: `Could not ${hidden ? "hide" : "show"} apps from ${server}`,
    description:
      outcome._tag === "Failed"
        ? outcome.error instanceof Error
          ? outcome.error.message
          : "The save failed. Try reconnecting and saving again."
        : OUTDATED_SERVER_MESSAGE,
  });
  return false;
}
