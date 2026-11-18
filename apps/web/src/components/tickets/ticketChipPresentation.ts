import {
  ticketUiAvailability,
  type TicketChip,
  type TicketChipContext,
} from "@t3tools/client-runtime/state/thread-ticket-presentation";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { serverEnvironment } from "~/state/server";

/** Null when the environment has no ticket support. Equal by value, so config pushes that leave Jira alone repaint nothing. */
export const environmentTicketChipContextAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): TicketChipContext | null => {
    const config = get(serverEnvironment.configValueAtom(environmentId));
    const availability = ticketUiAvailability(config);
    if (!availability.priority) return null;
    return {
      jiraConnected: availability.jiraConnected,
      siteUrl: config?.settings.jira?.siteUrl ?? null,
    };
  }).pipe(
    Atom.withEquality(
      (a: TicketChipContext | null, b: TicketChipContext | null) =>
        a === b ||
        (a !== null &&
          b !== null &&
          a.jiraConnected === b.jiraConnected &&
          a.siteUrl === b.siteUrl),
    ),
    Atom.withLabel("web-environment-ticket-chip-context"),
  ),
);

export function ticketChipIconToneClass(chip: TicketChip): string {
  switch (chip.group) {
    case "inProgress":
      return "text-info-foreground";
    case "done":
      return "text-success-foreground";
    case "unreachable":
      return "text-warning-foreground";
    case "pending":
      return chip.status.kind === "pending" && chip.status.tone === "warning"
        ? "text-warning-foreground"
        : "text-muted-foreground";
    case "toDo":
      return "text-muted-foreground";
  }
}

export function ticketChipStatusText(chip: TicketChip): string {
  switch (chip.status.kind) {
    case "synced":
      return chip.status.name;
    case "unreachable":
      return chip.status.reasonText;
    case "pending":
      return chip.status.label;
  }
}

/** Shown in place of a missing title: amber for unreachable and "Jira not connected", muted otherwise. */
export function ticketChipFallbackText(
  chip: TicketChip,
): { readonly text: string; readonly warning: boolean } | null {
  if (chip.title !== null) return null;
  switch (chip.status.kind) {
    case "unreachable":
      return { text: chip.status.reasonText, warning: true };
    case "pending":
      return { text: chip.status.label, warning: chip.status.tone === "warning" };
    case "synced":
      return null;
  }
}
