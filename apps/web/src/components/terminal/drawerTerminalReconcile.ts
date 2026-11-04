/**
 * Drawer ids after folding in each environment's sessions, or null to keep the client's.
 * Tabs on an environment whose list is unknown (null) stay. A pure removal looks like a
 * lagging terminal.open, so only a new thread-environment session reconciles.
 */
export function drawerTerminalIdsToReconcile(input: {
  readonly environmentIds: readonly string[];
  readonly sessionsByEnvironment: ReadonlyArray<ReadonlyArray<{
    readonly target: { readonly terminalId: string };
  }> | null>;
  readonly terminalEnvironmentIdById: Readonly<Record<string, string>>;
  readonly panelTerminalIds: ReadonlySet<string>;
  readonly clientIds: readonly string[];
}): string[] | null {
  const threadEnvironmentId = input.environmentIds[0];
  if (threadEnvironmentId === undefined) return null;
  const idsByEnvironment = new Map<string, ReadonlySet<string> | null>();
  for (const [index, environmentId] of input.environmentIds.entries()) {
    const sessions = input.sessionsByEnvironment[index] ?? null;
    idsByEnvironment.set(
      environmentId,
      sessions === null
        ? null
        : new Set(
            sessions
              .map((session) => session.target.terminalId)
              .filter((terminalId) => !input.panelTerminalIds.has(terminalId)),
          ),
    );
  }
  const clientIdSet = new Set(input.clientIds);
  const threadIds = idsByEnvironment.get(threadEnvironmentId) ?? null;
  const newIds = [...(threadIds ?? [])].filter((terminalId) => !clientIdSet.has(terminalId));
  if (newIds.length === 0) return null;
  const retainedIds = input.clientIds.filter((terminalId) => {
    const ids = idsByEnvironment.get(
      input.terminalEnvironmentIdById[terminalId] ?? threadEnvironmentId,
    );
    return ids === null || ids === undefined || ids.has(terminalId);
  });
  return [...retainedIds, ...newIds];
}
