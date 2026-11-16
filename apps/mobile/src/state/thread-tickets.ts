import { ticketPriorityScaleOf } from "@t3tools/client-runtime/state/thread-priority";
import { ticketUiAvailability } from "@t3tools/client-runtime/state/thread-ticket-presentation";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atom-registry";
import { serverEnvironment } from "./server";

export type TicketUiLevel = "off" | "priority" | "link";

/** Rows subscribe to the scale alone, so unrelated config changes never repaint them. */
export const environmentTicketPriorityScaleAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    ticketPriorityScaleOf(get(serverEnvironment.configValueAtom(environmentId))),
  ).pipe(Atom.withLabel("mobile-environment-ticket-priority-scale")),
);

/** "link" implies Jira is connected; a primitive keeps selector subscriptions quiet. */
export const environmentTicketUiLevelAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): TicketUiLevel => {
    const availability = ticketUiAvailability(
      get(serverEnvironment.configValueAtom(environmentId)),
    );
    return availability.linkTicket ? "link" : availability.priority ? "priority" : "off";
  }).pipe(Atom.withLabel("mobile-environment-ticket-ui-level")),
);

/** Actions run on a tap, so they read imperatively instead of subscribing. */
export function readEnvironmentServerConfig(environmentId: EnvironmentId): ServerConfig | null {
  return appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
}
