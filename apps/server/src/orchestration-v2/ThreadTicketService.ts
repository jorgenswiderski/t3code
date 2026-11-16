import {
  CommandId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type PriorityRef,
  type ThreadTicketCommandSource,
  type ThreadTicketKey,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class ThreadTicketThreadNotFoundError extends Schema.TaggedError<ThreadTicketThreadNotFoundError>()(
  "ThreadTicketThreadNotFoundError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class ThreadTicketDispatchError extends Schema.TaggedError<ThreadTicketDispatchError>()(
  "ThreadTicketDispatchError",
  {
    threadId: ThreadId,
    commandType: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to dispatch ${this.commandType} for thread ${this.threadId}.`;
  }
}

const isThreadNotFound = Schema.is(ProjectionStore.ProjectionStoreThreadNotFoundError);

export type ThreadTicketError = ThreadTicketThreadNotFoundError | ThreadTicketDispatchError;

export interface ThreadTicketServiceShape {
  /** `linked` is false when the reducer changed nothing. */
  readonly linkTicket: (input: {
    readonly threadId: ThreadId;
    readonly key: ThreadTicketKey;
    readonly url: string | null;
    readonly source: ThreadTicketCommandSource;
  }) => Effect.Effect<{ readonly linked: boolean }, ThreadTicketError>;
  readonly unlinkTicket: (input: {
    readonly threadId: ThreadId;
    readonly key: ThreadTicketKey;
  }) => Effect.Effect<{ readonly unlinked: boolean }, ThreadTicketError>;
  readonly setThreadPriority: (input: {
    readonly threadId: ThreadId;
    readonly source: "user" | "agent";
    readonly priority: PriorityRef | null;
  }) => Effect.Effect<{ readonly changed: boolean }, ThreadTicketError>;
}

export class ThreadTicketService extends Context.Service<
  ThreadTicketService,
  ThreadTicketServiceShape
>()("t3/orchestration-v2/ThreadTicketService") {}

type TicketCommand = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "thread.ticket.link" | "thread.ticket.unlink" | "thread.priority.set" }
>;
type TicketCommandInput = TicketCommand extends infer Command
  ? Command extends TicketCommand
    ? Omit<Command, "commandId">
    : never
  : never;

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const random = yield* SecureRandom.SecureRandom;

  const notFound = (threadId: ThreadId) => new ThreadTicketThreadNotFoundError({ threadId });

  /** Dispatches and reports whether the commit stored an event; these commands store none on a no-op. */
  const dispatchChange = Effect.fnUntraced(function* (input: TicketCommandInput) {
    const { threadId } = input;
    const thread = yield* projectionStore
      .getThread(threadId)
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "ProjectionStoreThreadNotFoundError"
            ? notFound(threadId)
            : new ThreadTicketDispatchError({ threadId, commandType: input.type, cause }),
        ),
      );
    if (thread.deletedAt !== null) return yield* notFound(threadId);
    const uuid = yield* random.uuidV4();
    const result = yield* orchestrator
      .dispatch({
        ...input,
        commandId: CommandId.make(`server:thread-ticket:${threadId}:${uuid}`),
      })
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "OrchestratorProjectionError" && isThreadNotFound(cause.cause)
            ? notFound(threadId)
            : new ThreadTicketDispatchError({ threadId, commandType: input.type, cause }),
        ),
      );
    return result.storedEvents.length > 0;
  });

  return ThreadTicketService.of({
    linkTicket: Effect.fn("ThreadTicketService.linkTicket")(function* (input) {
      const linked = yield* dispatchChange({
        type: "thread.ticket.link",
        threadId: input.threadId,
        key: input.key,
        ...(input.url === null ? {} : { url: input.url }),
        source: input.source,
      });
      return { linked };
    }),
    unlinkTicket: Effect.fn("ThreadTicketService.unlinkTicket")(function* (input) {
      const unlinked = yield* dispatchChange({
        type: "thread.ticket.unlink",
        threadId: input.threadId,
        key: input.key,
      });
      return { unlinked };
    }),
    setThreadPriority: Effect.fn("ThreadTicketService.setThreadPriority")(function* (input) {
      const changed = yield* dispatchChange({
        type: "thread.priority.set",
        threadId: input.threadId,
        source: input.source,
        priority: input.priority,
      });
      return { changed };
    }),
  });
});

export const layer = Layer.effect(ThreadTicketService, make);
