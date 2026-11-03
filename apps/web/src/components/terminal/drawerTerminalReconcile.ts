function terminalIdListsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  if (left.length === 0) {
    return true;
  }
  const sortedLeft = left.toSorted((a, b) => a.localeCompare(b));
  const sortedRight = right.toSorted((a, b) => a.localeCompare(b));
  for (let index = 0; index < sortedLeft.length; index += 1) {
    if (sortedLeft[index] !== sortedRight[index]) {
      return false;
    }
  }
  return true;
}

/** Server sessions lag terminal.open; reconciling strict subsets would discard new split layouts. */
function serverTerminalIdsStrictSubsetOfClient(
  serverIds: readonly string[],
  clientIds: readonly string[],
): boolean {
  if (serverIds.length >= clientIds.length || clientIds.length === 0) {
    return false;
  }
  const clientSet = new Set(clientIds);
  for (const id of serverIds) {
    if (!clientSet.has(id)) {
      return false;
    }
  }
  return true;
}

/**
 * The drawer ids the server knows across every environment the thread has tabs on, or null
 * when the client list should stay. The first entry is the thread's environment; other
 * environments only keep tabs this client placed there, since new ids land on the thread's.
 */
export function drawerTerminalIdsToReconcile(input: {
  readonly sessionsByEnvironment: ReadonlyArray<ReadonlyArray<{
    readonly target: { readonly terminalId: string };
  }> | null>;
  readonly panelTerminalIds: ReadonlySet<string>;
  readonly clientIds: readonly string[];
}): string[] | null {
  if (input.sessionsByEnvironment.some((sessions) => sessions === null)) return null;
  const clientIdSet = new Set(input.clientIds);
  const union = new Set<string>();
  for (const [index, sessions] of input.sessionsByEnvironment.entries()) {
    for (const session of sessions ?? []) {
      const terminalId = session.target.terminalId;
      if (input.panelTerminalIds.has(terminalId)) continue;
      if (index > 0 && !clientIdSet.has(terminalId)) continue;
      union.add(terminalId);
    }
  }
  const serverIds = [...union];
  if (terminalIdListsEqual(serverIds, input.clientIds)) return null;
  if (serverTerminalIdsStrictSubsetOfClient(serverIds, input.clientIds)) return null;
  return serverIds;
}
