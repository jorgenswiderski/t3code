import {
  formatAutoCompactTokens,
  validateCustomAutoCompactTokens,
  type ThreadAutoCompactView,
} from "@t3tools/client-runtime/thread-auto-compact";
import type { ServerProviderThreadAutoCompact } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { Input } from "../ui/input";
import { Separator } from "../ui/separator";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const DEFAULT_VALUE = "default";
const CUSTOM_VALUE = "custom";

function pressedValue(view: ThreadAutoCompactView, customOpen: boolean): string {
  if (customOpen) return CUSTOM_VALUE;
  switch (view.choice.kind) {
    case "default":
      return DEFAULT_VALUE;
    case "preset":
      return String(view.choice.tokens);
    case "custom":
      return CUSTOM_VALUE;
  }
}

function CustomTokensInput(props: {
  readonly initialText: string;
  readonly capability: ServerProviderThreadAutoCompact;
  readonly windowTokens: number | null;
  readonly disabled: boolean;
  readonly onCommit: (tokens: number) => void;
  readonly onEditingChange: ((editing: boolean) => void) | undefined;
}) {
  const { onEditingChange } = props;
  const [text, setText] = useState(props.initialText);
  const [error, setError] = useState<string | null>(null);

  // The input can unmount while focused (a committed value remounts it); release the focus hold.
  const latestOnEditingChange = useRef(onEditingChange);
  useEffect(() => {
    latestOnEditingChange.current = onEditingChange;
  });
  useEffect(() => () => latestOnEditingChange.current?.(false), []);

  const commit = () => {
    if (text.trim().length === 0) {
      setError(null);
      return;
    }
    const result = validateCustomAutoCompactTokens({
      text,
      capability: props.capability,
      windowTokens: props.windowTokens,
    });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError(null);
    props.onCommit(result.tokens);
  };

  return (
    <div className="flex flex-col gap-1">
      <Input
        size="compact"
        inputMode="numeric"
        autoFocus={props.initialText.length === 0}
        aria-label="Custom auto-compact threshold"
        aria-invalid={error !== null}
        placeholder="e.g. 250k"
        disabled={props.disabled}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        onFocus={() => onEditingChange?.(true)}
        onBlur={() => {
          onEditingChange?.(false);
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      />
      {error === null ? null : (
        <div role="alert" className="text-pretty text-2xs text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * The popover's "Auto-compact at" section: presets, a Custom input and the status line. Copy,
 * validation and pending state come from the shared helpers; this only renders them.
 */
export function AutoCompactControl(props: {
  readonly view: ThreadAutoCompactView;
  readonly capability: ServerProviderThreadAutoCompact;
  readonly windowTokens: number | null;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  /** Shown under the presets when the view has no status of its own. */
  readonly fallbackStatus: string | null;
  readonly onChange: (tokens: number | null) => void;
  /** Reports whether the Custom input has focus, so the popover can stay open while typing. */
  readonly onEditingChange?: ((editing: boolean) => void) | undefined;
}) {
  const { view } = props;
  const [customOpen, setCustomOpen] = useState(view.choice.kind === "custom");
  const status = view.statusText ?? props.fallbackStatus;

  return (
    <>
      <Separator />
      <div className="text-secondary-label text-2xs">Auto-compact at</div>
      <ToggleGroup
        aria-label="Auto-compact at"
        className="w-full *:flex-auto"
        disabled={props.disabled}
        value={[pressedValue(view, customOpen)]}
        onValueChange={(values) => {
          const next = values[0];
          // Clicking the pressed segment clears the selection; keep the current one.
          if (next === undefined) return;
          if (next === CUSTOM_VALUE) {
            setCustomOpen(true);
            return;
          }
          setCustomOpen(false);
          props.onChange(next === DEFAULT_VALUE ? null : Number(next));
        }}
      >
        <Toggle value={DEFAULT_VALUE}>Default</Toggle>
        {view.presets.map((preset) => (
          <Toggle key={preset.tokens} value={String(preset.tokens)} disabled={preset.disabled}>
            {preset.label}
          </Toggle>
        ))}
        <Toggle value={CUSTOM_VALUE}>Custom…</Toggle>
      </ToggleGroup>
      {props.disabled && props.disabledReason ? (
        <div className="text-pretty text-secondary-label text-2xs">{props.disabledReason}</div>
      ) : null}
      {customOpen ? (
        <CustomTokensInput
          key={view.choice.kind === "custom" ? view.choice.tokens : "none"}
          initialText={
            view.choice.kind === "custom" ? formatAutoCompactTokens(view.choice.tokens) : ""
          }
          capability={props.capability}
          windowTokens={props.windowTokens}
          disabled={props.disabled}
          onCommit={(tokens) => {
            if (view.presets.some((preset) => preset.tokens === tokens)) setCustomOpen(false);
            if (view.choice.kind !== "default" && view.choice.tokens === tokens) return;
            props.onChange(tokens);
          }}
          onEditingChange={props.onEditingChange}
        />
      ) : null}
      {status ? (
        <div className="text-pretty text-secondary-label text-2xs font-medium">{status}</div>
      ) : null}
    </>
  );
}
