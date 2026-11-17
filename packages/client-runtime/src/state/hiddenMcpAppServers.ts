import type { EnvironmentId } from "@t3tools/contracts";
import { withMcpAppServerHidden } from "@t3tools/shared/mcpApp";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "./runtime.ts";

export type McpAppServerHiddenOutcome =
  | { readonly _tag: "Applied" }
  | { readonly _tag: "Interrupted" }
  | { readonly _tag: "NotApplied" }
  | { readonly _tag: "Failed"; readonly error: unknown };

export interface SetMcpAppServerHiddenInput {
  readonly environmentId: EnvironmentId;
  readonly server: string;
  readonly hidden: boolean;
  readonly readCurrent: () => ReadonlyArray<string> | undefined;
  readonly write: (
    hiddenMcpAppServers: ReadonlyArray<string>,
  ) => Promise<
    AtomCommandResult<{ readonly hiddenMcpAppServers?: ReadonlyArray<string> }, unknown>
  >;
}

interface WriteQueue {
  tail: Promise<unknown>;
  pending: number;
  latest: ReadonlyArray<string> | undefined;
}

const queues = new Map<EnvironmentId, WriteQueue>();

// The patch replaces the whole list, so each write must start from the previous write's result
// rather than a settings snapshot taken at click time, which can predate an in-flight write.
export function setMcpAppServerHidden(
  input: SetMcpAppServerHiddenInput,
): Promise<McpAppServerHiddenOutcome> {
  const { environmentId } = input;
  const queue = queues.get(environmentId) ?? {
    tail: Promise.resolve(),
    pending: 0,
    latest: undefined,
  };
  queues.set(environmentId, queue);
  queue.pending += 1;
  const run = queue.tail.then(() => runWrite(queue, input));
  const settle = () => {
    queue.pending -= 1;
    if (queue.pending === 0) queues.delete(environmentId);
  };
  queue.tail = run.then(settle, settle);
  return run;
}

async function runWrite(
  queue: WriteQueue,
  { server, hidden, readCurrent, write }: SetMcpAppServerHiddenInput,
): Promise<McpAppServerHiddenOutcome> {
  const current = queue.latest ?? readCurrent() ?? [];
  const result = await write(withMcpAppServerHidden(current, server, hidden));
  queue.latest = result._tag === "Success" ? result.value.hiddenMcpAppServers : undefined;
  if (result._tag === "Failure") {
    return isAtomCommandInterrupted(result)
      ? { _tag: "Interrupted" }
      : { _tag: "Failed", error: squashAtomCommandFailure(result) };
  }
  const applied = result.value.hiddenMcpAppServers?.some((entry) => entry.trim() === server.trim());
  return (applied ?? false) === hidden ? { _tag: "Applied" } : { _tag: "NotApplied" };
}
