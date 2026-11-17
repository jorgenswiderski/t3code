import {
  OrchestratorMcpFailure,
  PriorityRef,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/ai/McpSchema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadTicketService from "../../../orchestration-v2/ThreadTicketService.ts";
import * as JiraService from "../../../jira/JiraService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  Orchestrator.OrchestratorV2,
  ThreadTicketService.ThreadTicketService,
  JiraService.JiraService,
];

const ThreadParameter = Schema.optional(ThreadId);

export class TicketTrackerNotConfiguredError extends Schema.TaggedError<TicketTrackerNotConfiguredError>()(
  "TicketTrackerNotConfiguredError",
  {},
) {
  override get message(): string {
    return "Jira is not connected in this environment, so tickets cannot be linked here.";
  }
}

export class TicketReferenceInvalidError extends Schema.TaggedError<TicketReferenceInvalidError>()(
  "TicketReferenceInvalidError",
  {},
) {
  override get message(): string {
    return "This is not a Jira ticket. Pass a key such as ACME-123 or the ticket's browse URL.";
  }
}

export class TicketSiteMismatchError extends Schema.TaggedError<TicketSiteMismatchError>()(
  "TicketSiteMismatchError",
  { siteUrl: Schema.String },
) {
  override get message(): string {
    return `This URL is on a different Jira site. Tickets here come from ${this.siteUrl}.`;
  }
}

export class TicketProjectUnknownError extends Schema.TaggedError<TicketProjectUnknownError>()(
  "TicketProjectUnknownError",
  { project: Schema.String },
) {
  override get message(): string {
    return `${this.project} is not a project on the connected Jira site, so this is not a ticket key there.`;
  }
}

export class TicketPriorityUnknownError extends Schema.TaggedError<TicketPriorityUnknownError>()(
  "TicketPriorityUnknownError",
  { priority: Schema.String, scale: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `"${this.priority}" is not a priority on the connected Jira site. Use one of: ${this.scale.join(", ")}.`;
  }
}

export class TicketThreadRequiredError extends Schema.TaggedError<TicketThreadRequiredError>()(
  "TicketThreadRequiredError",
  {},
) {
  override get message(): string {
    return "Pass threadId: this MCP client is not running inside a T3 thread.";
  }
}

export class TicketLinkFailedError extends Schema.TaggedError<TicketLinkFailedError>()(
  "TicketLinkFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not link the ticket.";
  }
}

export class TicketUnlinkFailedError extends Schema.TaggedError<TicketUnlinkFailedError>()(
  "TicketUnlinkFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not unlink the ticket.";
  }
}

export class TicketPriorityFailedError extends Schema.TaggedError<TicketPriorityFailedError>()(
  "TicketPriorityFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not set the thread priority.";
  }
}

export const TicketToolError = Schema.Union([
  OrchestratorMcpFailure,
  TicketTrackerNotConfiguredError,
  TicketReferenceInvalidError,
  TicketSiteMismatchError,
  TicketProjectUnknownError,
  TicketPriorityUnknownError,
  TicketThreadRequiredError,
  TicketLinkFailedError,
  TicketUnlinkFailedError,
  TicketPriorityFailedError,
]);
export type TicketToolError = typeof TicketToolError.Type;

export const LinkTicketResult = Schema.Struct({
  key: Schema.String,
  url: Schema.String,
  alreadyLinked: Schema.Boolean,
});
export type LinkTicketResult = typeof LinkTicketResult.Type;

export const UnlinkTicketResult = Schema.Struct({
  key: Schema.String,
  wasLinked: Schema.Boolean,
});
export type UnlinkTicketResult = typeof UnlinkTicketResult.Type;

export const SetThreadPriorityResult = Schema.Struct({
  source: Schema.Literals(["agent", "user"]),
  priority: Schema.NullOr(PriorityRef),
  changed: Schema.Boolean,
  scale: Schema.Array(Schema.String).annotate({
    description: "Valid priority names on this Jira site, highest first.",
  }),
});
export type SetThreadPriorityResult = typeof SetThreadPriorityResult.Type;

const LinkTicketTool = Tool.make("link_ticket", {
  description:
    "Link a Jira ticket to this thread, or to `threadId`. `ticket` is a key (ACME-123) or a browse URL on the connected Jira site. Succeeds with `alreadyLinked=true` when it was already linked.",
  parameters: Schema.Struct({ ticket: TrimmedNonEmptyString, threadId: ThreadParameter }),
  success: LinkTicketResult,
  failure: TicketToolError,
  dependencies,
})
  .annotate(Tool.Title, "Link Jira ticket to thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.visibleWhileTicketsOn);

const UnlinkTicketTool = Tool.make("unlink_ticket", {
  description:
    "Remove a Jira ticket link from this thread, or from `threadId`. `ticket` is a key or a browse URL. Succeeds with `wasLinked=false` when it was not linked.",
  parameters: Schema.Struct({ ticket: TrimmedNonEmptyString, threadId: ThreadParameter }),
  success: UnlinkTicketResult,
  failure: TicketToolError,
  dependencies,
})
  .annotate(Tool.Title, "Unlink Jira ticket from thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.visibleWhileTicketsOn);

const SetThreadPriorityTool = Tool.make("set_thread_priority", {
  description:
    "Set the priority of this thread, or of `threadId`. By default it records your provisional priority; `userRequested` records the user's own instead. `priority` is a name or id from the connected Jira site's scale, by default (highest first) Highest, High, Medium, Low, Lowest. An unknown priority fails with the valid names. `null` clears your provisional priority, or with `userRequested` both the user's and yours.",
  parameters: Schema.Struct({
    priority: Schema.NullOr(TrimmedNonEmptyString),
    userRequested: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Writes the user's own priority. Only when the user explicitly asked for this priority value.",
      }),
    ),
    threadId: ThreadParameter,
  }),
  success: SetThreadPriorityResult,
  failure: TicketToolError,
  dependencies,
})
  .annotate(Tool.Title, "Set thread priority")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.visibleWhileTicketsOn);

export const TicketsToolkit = Toolkit.make(LinkTicketTool, UnlinkTicketTool, SetThreadPriorityTool);
