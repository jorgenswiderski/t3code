import { useAtomValue } from "@effect/atom-react";
import { ticketUiAvailability } from "@t3tools/client-runtime/state/thread-ticket-presentation";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  jiraBrowseUrl,
  parseTicketReference,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useRef, useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

// Host in chat to survive command palette dismissal.
const linkTicketDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("tickets:link-dialog-thread"),
);

export function openLinkTicketDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(linkTicketDialogThreadAtom, threadRef);
}

export function LinkTicketDialogHost() {
  const threadRef = useAtomValue(linkTicketDialogThreadAtom);
  const config = useAtomValue(
    serverEnvironment.configValueAtom(threadRef?.environmentId ?? ("" as EnvironmentId)),
  );
  if (threadRef === null || !ticketUiAvailability(config).linkTicket) return null;
  return (
    <LinkTicketDialog
      threadRef={threadRef}
      siteUrl={config?.settings.jira?.siteUrl ?? null}
      onClose={() => appAtomRegistry.set(linkTicketDialogThreadAtom, null)}
    />
  );
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function LinkTicketDialog({
  threadRef,
  siteUrl,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly siteUrl: string | null;
  readonly onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState("");
  const [dirty, setDirty] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const linkTicket = useOrchestrationCommand(threadEnvironment.linkTicket, {
    reportFailure: false,
  });

  const parsed = parseTicketReference(reference);
  const wrongSite = parsed?.url != null && siteUrl !== null && !sameOrigin(parsed.url, siteUrl);

  const submit = async () => {
    setDirty(true);
    if (parsed === null || wrongSite) return;
    setSubmitError(null);
    setPending(true);
    const url = siteUrl !== null ? jiraBrowseUrl(siteUrl, parsed.key) : parsed.url;
    const result = await settlePromise(() =>
      linkTicket({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          key: parsed.key,
          source: "manual",
          ...(url ? { url } : {}),
        },
      }),
    );
    setPending(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setSubmitError(error instanceof Error ? error.message : "Could not link the ticket.");
      return;
    }
    onClose();
  };

  const validation = !dirty
    ? null
    : wrongSite
      ? "That link is for a different Jira site than the one connected to this server."
      : parsed === null
        ? "Use a Jira link or a key like PROJ-123."
        : null;

  return (
    <Dialog open onOpenChange={(next) => (pending || next ? undefined : onClose())}>
      <DialogPopup className="max-w-xl" initialFocus={inputRef}>
        <DialogHeader>
          <DialogTitle>Link Jira ticket</DialogTitle>
          <DialogDescription>
            Paste a Jira link or enter a ticket key such as PROJ-123.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            ref={inputRef}
            placeholder="Jira URL or PROJ-123"
            value={reference}
            onChange={(event) => {
              setDirty(true);
              setReference(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void submit();
            }}
          />
          {parsed !== null && !wrongSite ? (
            <p className="truncate text-muted-foreground text-xs">{parsed.key}</p>
          ) : null}
          {(validation ?? submitError) ? (
            <p className="text-destructive text-xs">{validation ?? submitError}</p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={pending || parsed === null || wrongSite}
          >
            {pending ? "Linking..." : "Link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
