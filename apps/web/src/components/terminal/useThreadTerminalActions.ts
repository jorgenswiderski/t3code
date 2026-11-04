import {
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { randomUUID } from "~/lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { environmentSummaries } from "../../state/presentation";
import { environmentProjects } from "../../state/projects";
import { readEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import {
  selectKnownTerminalSessions,
  useKnownTerminalSessions,
} from "../../state/terminalSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  selectTerminalEnvironmentId,
  selectThreadTerminalUiState,
  useTerminalUiStateStore,
} from "../../terminalUiStateStore";
import { resolveTerminalEnvironmentTargets } from "./terminalEnvironmentTargets";

/** Where a new terminal starts. Omitted fields fall back to the thread's project and worktree. */
export interface TerminalLaunchLocation {
  readonly cwd: string;
  readonly worktreePath: string | null;
  /** The project root on the terminal's environment; defaults to the thread project's. */
  readonly projectRoot?: string;
}

/** Allocate terminal ids and launch locations centrally so all surfaces share one view of sessions. */
export function useThreadTerminalActions(threadRef: ScopedThreadRef | null) {
  const openTerminalCommand = useAtomCommand(terminalEnvironment.open, "terminal open");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const closeTerminalCommand = useAtomCommand(terminalEnvironment.close, "terminal close");
  const serverThread = useQuietThreadShell(threadRef);
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useProject(projectRef);
  const threadWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const knownSessions = useKnownTerminalSessions({
    environmentId: threadRef?.environmentId ?? null,
    threadId: threadRef?.threadId ?? null,
  });
  const drawerTerminalIds = useTerminalUiStateStore(
    (state) => selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef).terminalIds,
  );
  const panelSurfaces = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces,
  );

  const canWrite = (environmentId?: EnvironmentId) =>
    threadRef !== null &&
    readEnvironmentScope(environmentId ?? threadRef.environmentId, AuthTerminalOperateScope);

  const terminalEnvironmentId = (terminalId: string) =>
    threadRef === null
      ? null
      : selectTerminalEnvironmentId(
          selectThreadTerminalUiState(
            useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
            threadRef,
          ),
          threadRef,
          terminalId,
        );

  // Server lists lag and colliding ids share a PTY; without read access, suffix ids to avoid unseen sessions.
  const allocateTerminalId = (environmentId?: EnvironmentId) => {
    const targetEnvironmentId = environmentId ?? threadRef?.environmentId ?? null;
    const isForeign =
      threadRef !== null &&
      targetEnvironmentId !== null &&
      targetEnvironmentId !== threadRef.environmentId;
    const targetMetadata =
      isForeign && readEnvironmentScope(targetEnvironmentId, AuthTerminalReadScope)
        ? appAtomRegistry.get(
            terminalEnvironment.metadata({ environmentId: targetEnvironmentId, input: null }),
          )
        : null;
    const targetSessions =
      targetMetadata?._tag === "Success"
        ? selectKnownTerminalSessions(
            targetMetadata.value,
            targetEnvironmentId,
            threadRef?.threadId ?? null,
          )
        : null;
    const ids = new Set([
      ...(knownSessions ?? []).map((session) => session.target.terminalId),
      ...(targetSessions ?? []).map((session) => session.target.terminalId),
      ...drawerTerminalIds,
      ...panelSurfaces.flatMap((surface) =>
        surface.kind === "terminal" ? surface.terminalIds : [],
      ),
    ]);
    const canReuse =
      knownSessions !== null &&
      threadRef !== null &&
      readEnvironmentScope(threadRef.environmentId, AuthTerminalReadScope) &&
      (!isForeign || targetSessions !== null);
    return nextTerminalId([...ids], canReuse ? undefined : randomUUID());
  };

  const defaultLaunchLocation = (environmentId: EnvironmentId): TerminalLaunchLocation | null => {
    if (!project || !threadRef) return null;
    if (environmentId === threadRef.environmentId) {
      return {
        cwd: projectScriptCwd({
          project: { cwd: project.workspaceRoot },
          worktreePath: threadWorktreePath,
        }),
        worktreePath: threadWorktreePath,
      };
    }
    // Read at call time so every consumer of this hook does not re-render on project changes.
    const target = resolveTerminalEnvironmentTargets({
      threadEnvironmentId: threadRef.environmentId,
      threadProject: project,
      threadWorktreePath,
      projects: appAtomRegistry.get(environmentProjects.projectsAtom),
      environments: [
        { environmentId: threadRef.environmentId, label: "" },
        { environmentId, label: "" },
      ],
      connectedEnvironmentIds: new Set(
        appAtomRegistry.get(environmentSummaries.connectedEnvironmentIdsAtom),
      ),
      operableEnvironmentIds: new Set(canWrite(environmentId) ? [environmentId] : []),
    }).find((candidate) => candidate.environmentId === environmentId);
    return target?.location ?? null;
  };

  /** The environment to open on: the requested one when it can host a terminal, else the thread's. */
  const resolveLaunchEnvironmentId = (environmentId: EnvironmentId) =>
    threadRef === null ||
    environmentId === threadRef.environmentId ||
    (canWrite(environmentId) && defaultLaunchLocation(environmentId) !== null)
      ? environmentId
      : threadRef.environmentId;

  /** place mounts the destination before the server open resolves. */
  const launchTerminal = (input: {
    readonly place: (terminalId: string) => void;
    readonly terminalId?: string;
    readonly location?: TerminalLaunchLocation | null;
    readonly environmentId?: EnvironmentId;
    readonly extraEnv?: Record<string, string>;
    readonly size?: { readonly cols: number; readonly rows: number };
  }) => {
    if (!threadRef || !project) return null;
    const environmentId = input.environmentId ?? threadRef.environmentId;
    if (!canWrite(environmentId)) return null;
    const location = input.location ?? defaultLaunchLocation(environmentId);
    if (!location) return null;
    const terminalId = input.terminalId ?? allocateTerminalId(environmentId);
    input.place(terminalId);
    const result = openTerminalCommand({
      environmentId,
      input: {
        threadId: threadRef.threadId,
        terminalId,
        cwd: location.cwd,
        ...(location.worktreePath !== null ? { worktreePath: location.worktreePath } : {}),
        env: projectScriptRuntimeEnv({
          project: { cwd: location.projectRoot ?? project.workspaceRoot },
          worktreePath: location.worktreePath,
          ...(input.extraEnv ? { extraEnv: input.extraEnv } : {}),
        }),
        ...input.size,
      },
    });
    return { terminalId, result };
  };

  /** Ends a session and deletes its history. A failed close falls back to typing `exit`. */
  const closeTerminalSession = (terminalId: string) => {
    const environmentId = terminalEnvironmentId(terminalId);
    if (!threadRef || environmentId === null || !canWrite(environmentId)) return;
    const threadId = threadRef.threadId;
    void (async () => {
      const closeResult = await closeTerminalCommand({
        environmentId,
        input: { threadId, terminalId, deleteHistory: true },
      });
      if (
        closeResult._tag === "Failure" &&
        !isAtomCommandInterrupted(closeResult) &&
        readEnvironmentScope(environmentId, AuthTerminalOperateScope)
      ) {
        await writeTerminal({ environmentId, input: { threadId, terminalId, data: "exit\n" } });
      }
    })();
  };

  const writeToTerminal = (terminalId: string, data: string) => {
    const environmentId = terminalEnvironmentId(terminalId);
    if (!threadRef || environmentId === null || !canWrite(environmentId)) return null;
    return writeTerminal({
      environmentId,
      input: { threadId: threadRef.threadId, terminalId, data },
    });
  };

  return {
    canWrite: useStableCallback(canWrite),
    allocateTerminalId: useStableCallback(allocateTerminalId),
    resolveLaunchEnvironmentId: useStableCallback(resolveLaunchEnvironmentId),
    launchTerminal: useStableCallback(launchTerminal),
    closeTerminalSession: useStableCallback(closeTerminalSession),
    writeToTerminal: useStableCallback(writeToTerminal),
  };
}
