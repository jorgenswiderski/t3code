/**
 * How a composer submission is delivered when the thread already has a turn in
 * flight. Shared by web (where the alternate is Mod+Enter) and mobile (where it
 * is a long-press on the send button), so both clients agree on what the user's
 * configured follow-up behavior means.
 */
export type ComposerDispatchMode = "auto" | "queue" | "steer" | "restart";
export type ActiveTurnComposerAction = Exclude<ComposerDispatchMode, "auto">;

/** The alternate switches between queue and steer relative to the configured action. */
export function resolveComposerDispatchMode(input: {
  /** A turn is in flight, so the follow-up has to queue behind it or steer it. */
  readonly running: boolean;
  readonly alternateModifier: boolean;
  readonly activeTurnDefault?: ActiveTurnComposerAction;
}): ComposerDispatchMode {
  if (!input.running) return "auto";
  const defaultAction = input.activeTurnDefault ?? "steer";
  if (input.alternateModifier) return defaultAction === "queue" ? "steer" : "queue";
  return defaultAction;
}

/** A bare `/compact`, which the server runs as a compaction turn of its own. */
export function isCompactCommandMessage(message: {
  readonly text: string;
  readonly attachmentCount: number;
}): boolean {
  return message.attachmentCount === 0 && message.text.trim().toLowerCase() === "/compact";
}

/**
 * The server refuses to steer or restart a running turn with `/compact`, so a
 * compaction sent mid-turn queues to run once the thread is idle.
 */
export function composerDispatchModeForMessage(
  mode: ComposerDispatchMode,
  message: { readonly text: string; readonly attachmentCount: number },
): ComposerDispatchMode {
  return (mode === "steer" || mode === "restart") && isCompactCommandMessage(message)
    ? "queue"
    : mode;
}

/** What the alternate would do, for labelling the affordance that triggers it. */
export function alternateComposerDispatchAction(
  activeTurnDefault?: ActiveTurnComposerAction,
): ActiveTurnComposerAction {
  return resolveComposerDispatchMode({
    running: true,
    alternateModifier: true,
    ...(activeTurnDefault === undefined ? {} : { activeTurnDefault }),
  }) as ActiveTurnComposerAction;
}
