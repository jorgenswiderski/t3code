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

interface WriteQueue {
  tail: Promise<unknown>;
  pending: number;
  latest: ReadonlyArray<string> | undefined;
}

const queues = new Map<EnvironmentId, WriteQueue>();

// The patch replaces the whole list, so each write must start from the previous write's result
// rather than a settings snapshot taken at click time, which can predate an in-flight write.
export function setMcpAppServerHidden(
  environmentId: EnvironmentId,
  server: string,
  hidden: boolean,
): Promise<boolean> {
  const queue = queues.get(environmentId) ?? {
    tail: Promise.resolve(),
    pending: 0,
    latest: undefined,
  };
  queues.set(environmentId, queue);
  queue.pending += 1;
  const run = queue.tail.then(() => writeMcpAppServerHidden(environmentId, queue, server, hidden));
  const settle = () => {
    queue.pending -= 1;
    if (queue.pending === 0) queues.delete(environmentId);
  };
  queue.tail = run.then(settle, settle);
  return run;
}

async function writeMcpAppServerHidden(
  environmentId: EnvironmentId,
  queue: WriteQueue,
  server: string,
  hidden: boolean,
): Promise<boolean> {
  const current =
    queue.latest ??
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
  queue.latest = result._tag === "Success" ? result.value.hiddenMcpAppServers : undefined;
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
