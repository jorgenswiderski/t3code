import {
  findPriorityInScale,
  parseTicketReference,
  type ThreadId,
  type ThreadTicketKey,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as JiraService from "../../../jira/JiraService.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadTicketService from "../../../orchestration-v2/ThreadTicketService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { threadNotFound } from "../../threadAccess.ts";
import {
  TicketLinkFailedError,
  TicketPriorityFailedError,
  TicketPriorityUnknownError,
  TicketProjectUnknownError,
  TicketReferenceInvalidError,
  TicketSiteMismatchError,
  TicketThreadRequiredError,
  TicketTrackerNotConfiguredError,
  TicketUnlinkFailedError,
  TicketsToolkit,
} from "./tools.ts";

type Failure =
  | typeof TicketLinkFailedError
  | typeof TicketUnlinkFailedError
  | typeof TicketPriorityFailedError;

const projectOf = (key: ThreadTicketKey) => key.slice(0, key.lastIndexOf("-"));

const originOf = (url: string) => new URL(url).origin;

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const tickets = yield* ThreadTicketService.ThreadTicketService;
  const jira = yield* JiraService.JiraService;

  const requireThread = Effect.fn("TicketsToolkit.requireThread")(function* (
    Fail: Failure,
    requested: ThreadId | undefined,
  ) {
    if (!(yield* jira.isConfigured)) return yield* new TicketTrackerNotConfiguredError();
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const threadId = requested ?? scope.thread?.threadId;
    if (threadId === undefined) return yield* new TicketThreadRequiredError();
    const thread = yield* engine.getThreadShell(threadId).pipe(
      Effect.map(Option.fromNullishOr),
      Effect.mapError((cause) => new Fail({ cause })),
    );
    if (Option.isNone(thread) || thread.value.deletedAt !== null) {
      return yield* threadNotFound(engine, threadId, `Thread ${threadId} was not found.`);
    }
    return thread.value.id;
  });

  const resolveReference = Effect.fn("TicketsToolkit.resolveReference")(function* (ticket: string) {
    const parsed = parseTicketReference(ticket);
    if (parsed === null) return yield* new TicketReferenceInvalidError();
    const browseUrl = yield* jira.browseUrl(parsed.key);
    if (browseUrl === null) return yield* new TicketTrackerNotConfiguredError();
    if (parsed.url !== null && originOf(parsed.url) !== originOf(browseUrl)) {
      return yield* new TicketSiteMismatchError({ siteUrl: originOf(browseUrl) });
    }
    return { key: parsed.key, url: browseUrl };
  });

  const serviceFailure =
    (Fail: Failure) =>
    <A, R>(effect: Effect.Effect<A, ThreadTicketService.ThreadTicketError, R>) =>
      effect.pipe(
        Effect.catchTags({
          ThreadTicketDispatchError: (cause) => Effect.fail(new Fail({ cause })),
          ThreadTicketThreadNotFoundError: (error) =>
            threadNotFound(engine, error.threadId, error.message),
        }),
      );

  const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
    handle: (params: P) => Effect.Effect<A, E, R>,
  ) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

  return {
    link_ticket: writesThread((input) =>
      Effect.gen(function* () {
        const threadId = yield* requireThread(TicketLinkFailedError, input.threadId);
        const target = yield* resolveReference(input.ticket);
        const known = yield* jira.projectKeys.pipe(
          Effect.asSome,
          Effect.orElseSucceed(() => Option.none<ReadonlySet<string>>()),
        );
        if (Option.isSome(known) && !known.value.has(projectOf(target.key))) {
          return yield* new TicketProjectUnknownError({ project: projectOf(target.key) });
        }
        const { linked } = yield* tickets
          .linkTicket({ threadId, key: target.key, url: target.url, source: "agent" })
          .pipe(serviceFailure(TicketLinkFailedError));
        return { key: target.key, url: target.url, alreadyLinked: !linked };
      }),
    ),
    unlink_ticket: writesThread((input) =>
      Effect.gen(function* () {
        const threadId = yield* requireThread(TicketUnlinkFailedError, input.threadId);
        const target = yield* resolveReference(input.ticket);
        const { unlinked } = yield* tickets
          .unlinkTicket({ threadId, key: target.key })
          .pipe(serviceFailure(TicketUnlinkFailedError));
        return { key: target.key, wasLinked: unlinked };
      }),
    ),
    set_thread_priority: writesThread((input) =>
      Effect.gen(function* () {
        const threadId = yield* requireThread(TicketPriorityFailedError, input.threadId);
        const scale = yield* jira.priorityScale;
        const scaleNames = scale.map((entry) => entry.name);
        const match = input.priority === null ? null : findPriorityInScale(scale, input.priority);
        if (input.priority !== null && match === null) {
          return yield* new TicketPriorityUnknownError({
            priority: input.priority,
            scale: scaleNames,
          });
        }
        const source = input.userRequested === true ? ("user" as const) : ("agent" as const);
        const priority = match?.ref ?? null;
        const { changed } = yield* tickets
          .setThreadPriority({ threadId, source, priority })
          .pipe(serviceFailure(TicketPriorityFailedError));
        return { source, priority, changed, scale: scaleNames };
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof TicketsToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(TicketsToolkit, make);
