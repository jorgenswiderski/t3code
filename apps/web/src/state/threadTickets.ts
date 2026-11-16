import { ticketPriorityScaleOf } from "@t3tools/client-runtime/state/thread-priority";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "./server";

/** Rows subscribe to the scale alone, so unrelated config changes never repaint them. */
export const environmentTicketPriorityScaleAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    ticketPriorityScaleOf(get(serverEnvironment.configValueAtom(environmentId))),
  ).pipe(Atom.withLabel("web-environment-ticket-priority-scale")),
);

/** Menus open on a click, so they read imperatively instead of subscribing. */
export function readEnvironmentServerConfig(environmentId: EnvironmentId): ServerConfig | null {
  return appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
}
