import { EnvironmentId, ProjectId, SourceControlProviderKind } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import { resolveTerminalEnvironmentTargets } from "./terminalEnvironmentTargets";

const sandbox = EnvironmentId.make("env-sandbox");
const host = EnvironmentId.make("env-host");
const gone = EnvironmentId.make("env-gone");

const repositoryIdentity = {
  canonicalKey: "github.com/t3tools/api",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/t3tools/api.git",
  },
  provider: SourceControlProviderKind.make("github"),
  owner: "t3tools",
  name: "api",
};

function makeProject(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  overrides: Partial<EnvironmentProject> = {},
): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(`${environmentId}-project`),
    title: "api",
    workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

const environments = [
  { environmentId: sandbox, label: "Sandbox" },
  { environmentId: host, label: "Mac" },
  { environmentId: gone, label: "Offline" },
];

function resolve(input: {
  threadProject: EnvironmentProject;
  threadWorktreePath?: string | null;
  hostProject?: EnvironmentProject | null;
  operable?: ReadonlyArray<EnvironmentId>;
}) {
  return resolveTerminalEnvironmentTargets({
    threadEnvironmentId: sandbox,
    threadProject: input.threadProject,
    threadWorktreePath: input.threadWorktreePath ?? null,
    projects: input.hostProject ? [input.threadProject, input.hostProject] : [input.threadProject],
    environments,
    connectedEnvironmentIds: new Set([sandbox, host]),
    operableEnvironmentIds: new Set(input.operable ?? [sandbox, host]),
  });
}

describe("resolveTerminalEnvironmentTargets", () => {
  it.each([
    {
      name: "same repo key on a different path",
      threadRoot: "/workspace/api",
      hostRoot: "/Users/me/Code/api",
      worktree: null,
      hostIdentity: true,
      expected: { cwd: "/Users/me/Code/api", worktreePath: null },
    },
    {
      name: "a worktree inside the project root is rebased onto the host root",
      threadRoot: "/workspace/api",
      hostRoot: "/Users/me/Code/api",
      worktree: "/workspace/api/sub-wt",
      hostIdentity: true,
      expected: { cwd: "/Users/me/Code/api/sub-wt", worktreePath: "/Users/me/Code/api/sub-wt" },
    },
    {
      name: "a worktree outside the project root falls back to the host root",
      threadRoot: "/workspace/api",
      hostRoot: "/Users/me/Code/api",
      worktree: "/home/u/.t3/worktrees/api/feat",
      hostIdentity: true,
      expected: { cwd: "/Users/me/Code/api", worktreePath: null },
    },
    {
      name: "no repository identity but the same path",
      threadRoot: "/shared/api",
      hostRoot: "/shared/api/",
      worktree: null,
      hostIdentity: false,
      expected: { cwd: "/shared/api/", worktreePath: null },
    },
  ])("$name", ({ threadRoot, hostRoot, worktree, hostIdentity, expected }) => {
    const threadProject = makeProject(
      sandbox,
      threadRoot,
      hostIdentity ? {} : { repositoryIdentity: null },
    );
    const hostProject = makeProject(
      host,
      hostRoot,
      hostIdentity ? {} : { repositoryIdentity: null },
    );
    const targets = resolve({ threadProject, threadWorktreePath: worktree, hostProject });
    expect(targets.map((t) => t.environmentId)).toEqual([sandbox, host]);
    expect(targets[1]).toMatchObject({
      label: "Mac",
      isThreadEnvironment: false,
      unavailableReason: null,
      location: {
        cwd: expected.cwd,
        worktreePath: expected.worktreePath,
        projectRoot: hostRoot,
      },
    });
  });

  it("keeps the thread environment first with its unchanged cwd", () => {
    const threadProject = makeProject(sandbox, "/workspace/api");
    const [first] = resolve({
      threadProject,
      threadWorktreePath: "/home/u/.t3/worktrees/api/feat",
    });
    expect(first).toMatchObject({
      environmentId: sandbox,
      isThreadEnvironment: true,
      location: {
        cwd: "/home/u/.t3/worktrees/api/feat",
        worktreePath: "/home/u/.t3/worktrees/api/feat",
        projectRoot: "/workspace/api",
      },
    });
  });

  it("lists an environment without the project as unavailable", () => {
    const targets = resolve({ threadProject: makeProject(sandbox, "/workspace/api") });
    expect(targets[1]).toMatchObject({
      environmentId: host,
      location: null,
      unavailableReason: "no-matching-project",
    });
  });

  it("does not match scratch projects", () => {
    const targets = resolve({
      threadProject: makeProject(sandbox, "/workspace/api"),
      hostProject: makeProject(host, "/workspace/api", { isScratch: true }),
    });
    expect(targets[1]?.unavailableReason).toBe("no-matching-project");
  });

  it("prefers a path match over a repository match", () => {
    const threadProject = makeProject(sandbox, "/shared/api");
    const repoOnly = makeProject(host, "/Users/me/other", { id: ProjectId.make("repo-only") });
    const pathMatch = makeProject(host, "/shared/api", {
      id: ProjectId.make("path-match"),
      repositoryIdentity: null,
    });
    const targets = resolveTerminalEnvironmentTargets({
      threadEnvironmentId: sandbox,
      threadProject,
      threadWorktreePath: null,
      projects: [threadProject, repoOnly, pathMatch],
      environments,
      connectedEnvironmentIds: new Set([sandbox, host]),
      operableEnvironmentIds: new Set([sandbox, host]),
    });
    expect(targets[1]?.location?.projectRoot).toBe("/shared/api");
  });

  it("marks a connected environment without terminal permission", () => {
    const targets = resolve({
      threadProject: makeProject(sandbox, "/workspace/api"),
      hostProject: makeProject(host, "/Users/me/Code/api"),
      operable: [sandbox],
    });
    expect(targets[1]).toMatchObject({ location: null, unavailableReason: "no-permission" });
  });

  it("omits disconnected environments", () => {
    const targets = resolve({ threadProject: makeProject(sandbox, "/workspace/api") });
    expect(targets.map((t) => t.environmentId)).not.toContain(gone);
  });
});
