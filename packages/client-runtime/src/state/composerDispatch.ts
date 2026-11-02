export type ComposerDispatchMode = "auto" | "queue" | "steer" | "restart";
export type ActiveTurnComposerAction = Exclude<ComposerDispatchMode, "auto">;

export function resolveComposerDispatchMode(input: {
  readonly running: boolean;
  readonly alternateModifier: boolean;
  readonly activeTurnDefault?: ActiveTurnComposerAction;
  /** False while the active turn cannot take steering input, such as during compaction. */
  readonly canSteer?: boolean;
}): ComposerDispatchMode {
  if (!input.running) return "auto";
  if (input.canSteer === false) return "queue";
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

export function alternateComposerDispatchAction(
  activeTurnDefault?: ActiveTurnComposerAction,
): ActiveTurnComposerAction {
  return resolveComposerDispatchMode({
    running: true,
    alternateModifier: true,
    ...(activeTurnDefault === undefined ? {} : { activeTurnDefault }),
  }) as ActiveTurnComposerAction;
}
