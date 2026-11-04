import { repositoryGroupingKeyOf, type EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
} from "@t3tools/shared/path";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";

export interface TerminalEnvironmentTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isThreadEnvironment: boolean;
  readonly location: {
    readonly cwd: string;
    readonly worktreePath: string | null;
    readonly projectRoot: string;
  } | null;
  readonly unavailableReason: "no-matching-project" | "no-permission" | null;
}

function repositoryKeyOf(project: EnvironmentProject): string | null {
  return project.repositoryIdentity
    ? repositoryGroupingKeyOf(project.repositoryIdentity).toLowerCase()
    : null;
}

function findMatchingProject(
  threadProject: EnvironmentProject,
  candidates: ReadonlyArray<EnvironmentProject>,
): EnvironmentProject | null {
  const threadKey = repositoryKeyOf(threadProject);
  const threadPath = normalizeProjectPathForComparison(threadProject.workspaceRoot);
  let repositoryMatch: EnvironmentProject | null = null;
  for (const candidate of candidates) {
    const candidateKey = repositoryKeyOf(candidate);
    // Two unrelated repositories can sit at the same path on two machines.
    const sameRepositoryOrUnknown =
      threadKey === null || candidateKey === null || candidateKey === threadKey;
    if (
      sameRepositoryOrUnknown &&
      normalizeProjectPathForComparison(candidate.workspaceRoot) === threadPath
    ) {
      return candidate;
    }
    if (repositoryMatch === null && threadKey !== null && candidateKey === threadKey) {
      repositoryMatch = candidate;
    }
  }
  return repositoryMatch;
}

/** The thread worktree's path below its project root, or null when it lives elsewhere. */
function relativeWithinRoot(path: string, root: string): string | null {
  const normalizedPath = normalizeProjectPathForComparison(path);
  const normalizedRoot = normalizeProjectPathForComparison(root);
  if (!normalizedPath.startsWith(normalizedRoot)) return null;
  const rest = normalizedPath.slice(normalizedRoot.length);
  return rest.startsWith("/") || rest.startsWith("\\") ? rest : null;
}

export function resolveTerminalEnvironmentTargets(input: {
  readonly threadEnvironmentId: EnvironmentId;
  readonly threadProject: EnvironmentProject;
  readonly threadWorktreePath: string | null;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly connectedEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly operableEnvironmentIds: ReadonlySet<EnvironmentId>;
}): ReadonlyArray<TerminalEnvironmentTarget> {
  const connected = input.environments.filter((environment) =>
    input.connectedEnvironmentIds.has(environment.environmentId),
  );
  const ordered = [
    ...connected.filter((environment) => environment.environmentId === input.threadEnvironmentId),
    ...connected.filter((environment) => environment.environmentId !== input.threadEnvironmentId),
  ];

  return ordered.map((environment): TerminalEnvironmentTarget => {
    const { environmentId, label } = environment;
    if (environmentId === input.threadEnvironmentId) {
      return {
        environmentId,
        label,
        isThreadEnvironment: true,
        location: {
          cwd: projectScriptCwd({
            project: { cwd: input.threadProject.workspaceRoot },
            worktreePath: input.threadWorktreePath,
          }),
          worktreePath: input.threadWorktreePath,
          projectRoot: input.threadProject.workspaceRoot,
        },
        unavailableReason: input.operableEnvironmentIds.has(environmentId) ? null : "no-permission",
      };
    }
    if (!input.operableEnvironmentIds.has(environmentId)) {
      return {
        environmentId,
        label,
        isThreadEnvironment: false,
        location: null,
        unavailableReason: "no-permission",
      };
    }
    const match = findMatchingProject(
      input.threadProject,
      input.projects.filter(
        (project) => project.environmentId === environmentId && !project.isScratch,
      ),
    );
    if (!match) {
      return {
        environmentId,
        label,
        isThreadEnvironment: false,
        location: null,
        unavailableReason: "no-matching-project",
      };
    }
    const relative =
      input.threadWorktreePath === null
        ? null
        : relativeWithinRoot(input.threadWorktreePath, input.threadProject.workspaceRoot);
    const worktreePath =
      relative === null
        ? null
        : `${normalizeProjectPathForDispatch(match.workspaceRoot)}${relative}`;
    return {
      environmentId,
      label,
      isThreadEnvironment: false,
      location: {
        cwd: worktreePath ?? match.workspaceRoot,
        worktreePath,
        projectRoot: match.workspaceRoot,
      },
      unavailableReason: null,
    };
  });
}
