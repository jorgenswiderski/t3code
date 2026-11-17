import type { EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { withMcpAppServerHidden } from "@t3tools/shared/mcpApp";
import { toastManager } from "~/components/ui/toast";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";

const OUTDATED_SERVER_MESSAGE = "This environment's server may need an update.";

export async function setMcpAppServerHidden(
  environmentId: EnvironmentId,
  server: string,
  hidden: boolean,
): Promise<boolean> {
  const current =
    appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId))?.hiddenMcpAppServers ??
    [];
  const result = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.updateSettings,
    {
      environmentId,
      input: { patch: { hiddenMcpAppServers: withMcpAppServerHidden(current, server, hidden) } },
    },
    { label: "hidden MCP app servers", reportFailure: false },
  );
  if (result._tag === "Success") {
    const applied = result.value.hiddenMcpAppServers?.some(
      (entry) => entry.trim() === server.trim(),
    );
    if ((applied ?? false) === hidden) return true;
  }
  if (result._tag === "Failure" && isAtomCommandInterrupted(result)) return false;
  const error = result._tag === "Failure" ? squashAtomCommandFailure(result) : undefined;
  toastManager.add({
    type: "error",
    title: `Could not ${hidden ? "hide" : "show"} apps from ${server}`,
    description:
      result._tag === "Failure"
        ? error instanceof Error
          ? error.message
          : "The save failed. Try reconnecting and saving again."
        : OUTDATED_SERVER_MESSAGE,
  });
  return false;
}
