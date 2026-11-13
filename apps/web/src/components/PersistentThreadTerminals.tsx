import {
  AuthTerminalOperateScope,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import { memo, useEffect } from "react";
import { useComposerDraftStore } from "../composerDraftStore";
import { useStableCallback } from "../hooks/useStableCallback";
import type { TerminalContextSelection } from "../lib/terminalContext";
import { focusActiveDrawerTerminal, focusTerminal } from "../lib/terminalFocus";
import { cn } from "~/lib/utils";
import {
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "../rightPanelStore";
import { useProject, useProjects, useQuietThreadShell } from "../state/entities";
import { useConnectedEnvironmentIds, useEnvironmentLabels } from "../state/environments";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../state/session";
import {
  useKnownTerminalSessions,
  useKnownTerminalSessionsAcross,
} from "../state/terminalSessions";
import {
  selectTerminalEnvironmentId,
  selectThreadTerminalUiState,
  useTerminalUiStateStore,
} from "../terminalUiStateStore";
import { drawerTerminalIdsToReconcile } from "./terminal/drawerTerminalReconcile";
import { resolveTerminalEnvironmentTargets } from "./terminal/terminalEnvironmentTargets";
import { useThreadTerminalActions } from "./terminal/useThreadTerminalActions";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import { resolveTerminalWorktreePath } from "./ChatView.logic";

/** Where a drawer or panel opens new terminals when a script run overrides the thread's own. */
export type PersistentTerminalLaunchContext = {
  readonly cwd: string;
  readonly worktreePath: string | null;
};

interface TerminalLaunchLocationWithEnv {
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly runtimeEnv: Record<string, string>;
}

interface PersistentThreadTerminalDrawerProps {
  threadRef: { environmentId: EnvironmentId; threadId: ThreadId };
  threadId: ThreadId;
  active: boolean;
  composerHeight: number;
  launchContext: PersistentTerminalLaunchContext | null;
  splitShortcutLabel: string | undefined;
  splitVerticalShortcutLabel: string | undefined;
  newShortcutLabel: string | undefined;
  closeShortcutLabel: string | undefined;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

export const PersistentThreadTerminalDrawer = memo(function PersistentThreadTerminalDrawer({
  threadRef,
  threadId,
  active,
  composerHeight,
  launchContext,
  splitShortcutLabel,
  splitVerticalShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  keybindings,
  onAddTerminalContext,
}: PersistentThreadTerminalDrawerProps) {
  const canOperateTerminal = useEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope);
  const terminalActions = useThreadTerminalActions(threadRef);
  const serverThread = useQuietThreadShell(threadRef);
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useProject(projectRef);
  const terminalUiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef),
  );
  const visible = active && terminalUiState.terminalOpen;
  const terminalEnvironmentIdById = terminalUiState.terminalEnvironmentIdById;
  const foreignEnvironmentIds = Object.values(terminalEnvironmentIdById);
  const environmentIds = [...new Set([threadRef.environmentId, ...foreignEnvironmentIds])];
  const sessionsByEnvironment = useKnownTerminalSessionsAcross({ environmentIds, threadId });
  const terminalEnvironmentIdOf = (terminalId: string) =>
    selectTerminalEnvironmentId(terminalUiState, threadRef, terminalId);
  const activeTerminalEnvironmentId = terminalEnvironmentIdOf(terminalUiState.activeTerminalId);
  const panelSurfaces = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).surfaces,
  );
  const panelTerminalIds = new Set(
    panelSurfaces.flatMap((surface) => (surface.kind === "terminal" ? surface.terminalIds : [])),
  );
  const clientTerminalIds = new Set(terminalUiState.terminalIds);
  // A session belongs to the drawer when it sits on its tab's environment; unknown ids only come from the thread's.
  const drawerTerminalSessions = sessionsByEnvironment.flatMap((sessions, index) => {
    const environmentId = environmentIds[index]!;
    return (sessions ?? []).filter((session) => {
      const terminalId = session.target.terminalId;
      if (panelTerminalIds.has(terminalId)) return false;
      return clientTerminalIds.has(terminalId)
        ? terminalEnvironmentIdOf(terminalId) === environmentId
        : environmentId === threadRef.environmentId;
    });
  });
  const worktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  // Matching projects reads every environment's catalog; only the active drawer with a choice to
  // offer, or a drawer holding tabs on other environments, pays for it.
  const resolvesTargets =
    foreignEnvironmentIds.length > 0 || (active && connectedEnvironmentIds.length >= 2);
  const projects = useProjects(resolvesTargets);
  const environments = useEnvironmentLabels(resolvesTargets);
  const operableEnvironmentIds = useEnvironmentsWithScope(
    resolvesTargets ? connectedEnvironmentIds.map((environmentId) => ({ environmentId })) : [],
    AuthTerminalOperateScope,
  );
  const environmentTargets =
    project && resolvesTargets
      ? resolveTerminalEnvironmentTargets({
          threadEnvironmentId: threadRef.environmentId,
          threadProject: project,
          threadWorktreePath: worktreePath,
          projects,
          environments,
          connectedEnvironmentIds: new Set(connectedEnvironmentIds),
          operableEnvironmentIds,
        })
      : [];
  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  const otherEnvironmentLocation = (environmentId: EnvironmentId) =>
    environmentTargets.find((target) => target.environmentId === environmentId)?.location ?? null;
  const terminalLabelsById = new Map<string, string>();
  for (const session of drawerTerminalSessions) {
    terminalLabelsById.set(
      session.target.terminalId,
      resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
    );
  }
  const terminalLaunchLocationsById = new Map<string, TerminalLaunchLocationWithEnv>();
  for (const session of drawerTerminalSessions) {
    const summary = session.state.summary;
    if (!project || !summary) continue;
    const environmentId = session.target.environmentId;
    if (environmentId !== threadRef.environmentId) {
      // A disconnected environment's session list can outlive the connection; show it as unavailable.
      if (!connectedEnvironmentIds.includes(environmentId)) continue;
      terminalLaunchLocationsById.set(session.target.terminalId, {
        cwd: summary.cwd,
        worktreePath: summary.worktreePath,
        runtimeEnv: projectScriptRuntimeEnv({
          project: { cwd: otherEnvironmentLocation(environmentId)?.projectRoot ?? summary.cwd },
          worktreePath: summary.worktreePath,
        }),
      });
      continue;
    }
    const worktreePathForLaunch =
      launchContext !== null ? launchContext.worktreePath : summary.worktreePath;
    terminalLaunchLocationsById.set(session.target.terminalId, {
      cwd: launchContext?.cwd ?? summary.cwd,
      worktreePath: worktreePathForLaunch,
      runtimeEnv: projectScriptRuntimeEnv({
        project: { cwd: project.workspaceRoot },
        worktreePath: worktreePathForLaunch,
      }),
    });
  }
  // Tabs on another environment attach there even before its session list catches up.
  for (const [terminalId, environmentId] of Object.entries(terminalEnvironmentIdById)) {
    if (terminalLaunchLocationsById.has(terminalId)) continue;
    const location = otherEnvironmentLocation(environmentId);
    if (!location) continue;
    terminalLaunchLocationsById.set(terminalId, {
      cwd: location.cwd,
      worktreePath: location.worktreePath,
      runtimeEnv: projectScriptRuntimeEnv({
        project: { cwd: location.projectRoot },
        worktreePath: location.worktreePath,
      }),
    });
  }
  const serverOrderedTerminalIds = drawerTerminalSessions.map(
    (session) => session.target.terminalId,
  );
  const storeSetTerminalHeight = useTerminalUiStateStore((state) => state.setTerminalHeight);
  const storeSplitTerminal = useTerminalUiStateStore((state) => state.splitTerminal);
  const storeSplitTerminalVertical = useTerminalUiStateStore(
    (state) => state.splitTerminalVertical,
  );
  const storeNewTerminal = useTerminalUiStateStore((state) => state.newTerminal);
  const storeSetActiveTerminal = useTerminalUiStateStore((state) => state.setActiveTerminal);
  const storeCloseTerminal = useTerminalUiStateStore((state) => state.closeTerminal);
  const reconcileTerminalIds = useTerminalUiStateStore((state) => state.reconcileTerminalIds);

  const reconciledTerminalIds = drawerTerminalIdsToReconcile({
    environmentIds,
    sessionsByEnvironment,
    terminalEnvironmentIdById,
    panelTerminalIds,
    clientIds: terminalUiState.terminalIds,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reconciles the terminal UI store's ids with the servers' terminal lists when they diverge
  useEffect(() => {
    if (reconciledTerminalIds === null) return;
    reconcileTerminalIds(threadRef, reconciledTerminalIds);
  }, [reconcileTerminalIds, reconciledTerminalIds, threadRef]);
  const effectiveWorktreePath = launchContext !== null ? launchContext.worktreePath : worktreePath;
  const cwd =
    launchContext?.cwd ??
    (project
      ? projectScriptCwd({
          project: { cwd: project.workspaceRoot },
          worktreePath: effectiveWorktreePath,
        })
      : null);
  const runtimeEnv = project
    ? projectScriptRuntimeEnv({
        project: { cwd: project.workspaceRoot },
        worktreePath: effectiveWorktreePath,
      })
    : {};

  const setTerminalHeight = (height: number) => {
    storeSetTerminalHeight(threadRef, height);
  };

  const activeTarget = environmentTargets.find(
    (target) => target.environmentId === activeTerminalEnvironmentId,
  );
  // Split and new follow the active tab's environment, or the thread's when that one cannot host.
  const launchEnvironmentId =
    activeTarget?.location && !activeTarget.unavailableReason
      ? activeTerminalEnvironmentId
      : threadRef.environmentId;
  const launchDrawerTerminal = (
    place: (terminalId: string, environmentId: EnvironmentId) => void,
    environmentId: EnvironmentId = launchEnvironmentId,
  ) => {
    const location =
      environmentId === threadRef.environmentId
        ? cwd
          ? { cwd, worktreePath: effectiveWorktreePath }
          : null
        : otherEnvironmentLocation(environmentId);
    if (!location) return;
    const launched = terminalActions.launchTerminal({
      place: (terminalId) => place(terminalId, environmentId),
      location,
      environmentId,
    });
    if (!launched) return;
    if (visible) focusTerminal(threadRef, launched.terminalId);
    void launched.result;
  };
  const splitTerminal = useStableCallback(() =>
    launchDrawerTerminal((terminalId, environmentId) =>
      storeSplitTerminal(threadRef, terminalId, environmentId),
    ),
  );
  const splitTerminalVertical = useStableCallback(() =>
    launchDrawerTerminal((terminalId, environmentId) =>
      storeSplitTerminalVertical(threadRef, terminalId, environmentId),
    ),
  );
  const placeNewTerminal = (terminalId: string, environmentId: EnvironmentId) =>
    storeNewTerminal(threadRef, terminalId, environmentId);
  const createNewTerminal = useStableCallback(() => launchDrawerTerminal(placeNewTerminal));
  const createTerminalOnEnvironment = useStableCallback((environmentId: EnvironmentId) =>
    launchDrawerTerminal(placeNewTerminal, environmentId),
  );

  const activateTerminal = (terminalId: string) => {
    storeSetActiveTerminal(threadRef, terminalId);
    if (visible) focusTerminal(threadRef, terminalId);
  };

  const closeTerminal = useStableCallback((terminalId: string) => {
    // closeTerminalSession skips the server close when the tab's environment is not writable.
    terminalActions.closeTerminalSession(terminalId);
    storeCloseTerminal(threadRef, terminalId);
    if (visible) focusActiveDrawerTerminal(threadRef);
  });

  const handleAddTerminalContext = (selection: TerminalContextSelection) => {
    if (!visible) {
      return;
    }
    onAddTerminalContext(selection);
  };

  if (!project || (!terminalUiState.terminalOpen && !active) || !cwd) {
    return null;
  }

  return (
    <div
      className={cn(
        "grid shrink-0 overflow-clip",
        active ? (visible ? "grid-rows-[1fr]" : "grid-rows-[0fr]") : "hidden",
        active &&
          "[[data-panel-animations=true]_&]:transition-[grid-template-rows] [[data-panel-animations=true]_&]:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:ease-out",
        active && visible && "[[data-panel-animations=true]_&]:starting:grid-rows-[0fr]!",
      )}
    >
      <div className="min-h-0 overflow-clip">
        <ThreadTerminalDrawer
          threadRef={threadRef}
          threadId={threadId}
          cwd={cwd}
          worktreePath={effectiveWorktreePath}
          runtimeEnv={runtimeEnv}
          visible={visible}
          height={terminalUiState.terminalHeight}
          composerHeight={composerHeight}
          // Known-session order is MRU and changes on focus; persisted store order keeps sidebar labels stable.
          terminalIds={canOperateTerminal ? terminalUiState.terminalIds : serverOrderedTerminalIds}
          activeTerminalId={terminalUiState.activeTerminalId}
          terminalGroups={terminalUiState.terminalGroups}
          activeTerminalGroupId={terminalUiState.activeTerminalGroupId}
          onSplitTerminal={splitTerminal}
          onSplitTerminalVertical={splitTerminalVertical}
          onNewTerminal={createNewTerminal}
          splitShortcutLabel={visible ? splitShortcutLabel : undefined}
          splitVerticalShortcutLabel={visible ? splitVerticalShortcutLabel : undefined}
          newShortcutLabel={visible ? newShortcutLabel : undefined}
          closeShortcutLabel={visible ? closeShortcutLabel : undefined}
          keybindings={keybindings}
          onActiveTerminalChange={activateTerminal}
          onCloseTerminal={closeTerminal}
          onHeightChange={setTerminalHeight}
          onAddTerminalContext={handleAddTerminalContext}
          terminalLabelsById={terminalLabelsById}
          terminalLaunchLocationsById={terminalLaunchLocationsById}
          environmentTargets={environmentTargets}
          terminalEnvironmentIdById={terminalEnvironmentIdById}
          environmentLabelById={environmentLabelById}
          launchEnvironmentId={launchEnvironmentId}
          onNewTerminalOnEnvironment={createTerminalOnEnvironment}
        />
      </div>
    </div>
  );
});

export interface PersistentThreadTerminalPanelProps {
  visible: boolean;
  threadRef: ScopedThreadRef;
  surface: Extract<RightPanelSurface, { kind: "terminal" }>;
  launchContext: PersistentTerminalLaunchContext | null;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  onSplitTerminal: () => void;
  onSplitTerminalVertical: () => void;
  onNewTerminal: () => void;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string, threadRef?: ScopedThreadRef) => void;
  splitShortcutLabel?: string | undefined;
  splitVerticalShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
}

export const PersistentThreadTerminalPanel = memo(function PersistentThreadTerminalPanel({
  visible,
  threadRef,
  surface,
  launchContext,
  keybindings,
  onAddTerminalContext,
  onSplitTerminal,
  onSplitTerminalVertical,
  onNewTerminal,
  onActiveTerminalChange,
  onCloseTerminal,
  splitShortcutLabel,
  splitVerticalShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
}: PersistentThreadTerminalPanelProps) {
  const serverThread = useQuietThreadShell(threadRef);
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useProject(projectRef);
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  });
  const threadWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const activeSummary =
    knownTerminalSessions?.find((session) => session.target.terminalId === surface.activeTerminalId)
      ?.state.summary ?? null;
  const worktreePath = resolveTerminalWorktreePath({
    launchContext,
    summary: activeSummary,
    threadWorktreePath,
  });
  const cwd =
    launchContext?.cwd ??
    activeSummary?.cwd ??
    (project ? projectScriptCwd({ project: { cwd: project.workspaceRoot }, worktreePath }) : null);
  const runtimeEnv = project
    ? projectScriptRuntimeEnv({ project: { cwd: project.workspaceRoot }, worktreePath })
    : {};
  const terminalLabelsById = new Map<string, string>();
  const terminalLaunchLocationsById = new Map<string, TerminalLaunchLocationWithEnv>();
  for (const terminalId of surface.terminalIds) {
    const summary =
      knownTerminalSessions?.find((session) => session.target.terminalId === terminalId)?.state
        .summary ?? null;
    terminalLabelsById.set(terminalId, resolveTerminalSessionLabel(terminalId, summary));
    if (!project) continue;
    const terminalWorktreePath = resolveTerminalWorktreePath({
      launchContext,
      summary,
      threadWorktreePath,
    });
    terminalLaunchLocationsById.set(terminalId, {
      cwd:
        launchContext?.cwd ??
        summary?.cwd ??
        projectScriptCwd({
          project: { cwd: project.workspaceRoot },
          worktreePath: terminalWorktreePath,
        }),
      worktreePath: terminalWorktreePath,
      runtimeEnv: projectScriptRuntimeEnv({
        project: { cwd: project.workspaceRoot },
        worktreePath: terminalWorktreePath,
      }),
    });
  }

  if (!project || !cwd) return null;

  return (
    <ThreadTerminalDrawer
      mode="panel"
      visible={visible}
      threadRef={threadRef}
      threadId={threadRef.threadId}
      cwd={cwd}
      worktreePath={worktreePath}
      runtimeEnv={runtimeEnv}
      height={0}
      terminalIds={surface.terminalIds}
      activeTerminalId={surface.activeTerminalId}
      terminalGroups={[
        {
          id: surface.id,
          terminalIds: surface.terminalIds,
          ...(surface.splitDirection === "vertical" ? { splitDirection: "vertical" as const } : {}),
        },
      ]}
      activeTerminalGroupId={surface.id}
      onSplitTerminal={onSplitTerminal}
      onSplitTerminalVertical={onSplitTerminalVertical}
      onNewTerminal={onNewTerminal}
      splitShortcutLabel={splitShortcutLabel}
      splitVerticalShortcutLabel={splitVerticalShortcutLabel}
      newShortcutLabel={newShortcutLabel}
      closeShortcutLabel={closeShortcutLabel}
      onActiveTerminalChange={onActiveTerminalChange}
      onCloseTerminal={onCloseTerminal}
      onHeightChange={() => undefined}
      onAddTerminalContext={onAddTerminalContext}
      terminalLabelsById={terminalLabelsById}
      terminalLaunchLocationsById={terminalLaunchLocationsById}
      keybindings={keybindings}
    />
  );
});
