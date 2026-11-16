import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

// Host in chat to survive command palette dismissal.
export const linkTicketDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("tickets:link-dialog-thread"),
);

export function openLinkTicketDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(linkTicketDialogThreadAtom, threadRef);
}
