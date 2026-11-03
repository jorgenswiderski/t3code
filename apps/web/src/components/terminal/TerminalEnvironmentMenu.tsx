import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import type { TerminalEnvironmentTarget } from "./terminalEnvironmentTargets";

const UNAVAILABLE_TEXT = {
  "no-matching-project": "Project not added here",
  "no-permission": "No terminal access",
} as const;

export function TerminalEnvironmentMenu(props: {
  readonly targets: ReadonlyArray<TerminalEnvironmentTarget>;
  readonly activeEnvironmentId: EnvironmentId;
  readonly machineByEnvironmentId: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
  readonly onSelect: (environmentId: EnvironmentId) => void;
  readonly disabled: boolean;
}) {
  const activeTarget = props.targets.find(
    (target) => target.environmentId === props.activeEnvironmentId,
  );
  const machineKindOf = (environmentId: EnvironmentId) =>
    props.machineByEnvironmentId.get(environmentId) ?? "server";
  return (
    <Menu>
      <MenuTrigger
        disabled={props.disabled}
        aria-label={`Terminal environment: ${activeTarget?.label ?? "unknown"}`}
        render={
          <button
            type="button"
            className="flex h-full min-w-0 max-w-full items-center gap-1 px-1.5 text-2xs text-foreground/90 transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-64"
          />
        }
      >
        <EnvironmentMachineIcon
          kind={machineKindOf(props.activeEnvironmentId)}
          className="size-3 shrink-0"
        />
        <span className="min-w-0 truncate">{activeTarget?.label ?? "Environment"}</span>
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start" width="content">
        <MenuGroup>
          <MenuGroupLabel>Run terminal on</MenuGroupLabel>
          {props.targets.map((target) => {
            const unavailable = target.location === null || target.unavailableReason !== null;
            return (
              <MenuItem
                key={target.environmentId}
                disabled={unavailable}
                onClick={() => props.onSelect(target.environmentId)}
              >
                <EnvironmentMachineIcon kind={machineKindOf(target.environmentId)} />
                <div className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate">{target.label}</span>
                    {target.environmentId === props.activeEnvironmentId ? (
                      <span className="text-muted-foreground text-xs">current</span>
                    ) : null}
                  </span>
                  <span className="max-w-72 truncate font-mono text-muted-foreground text-xs">
                    {target.unavailableReason
                      ? UNAVAILABLE_TEXT[target.unavailableReason]
                      : (target.location?.cwd ?? UNAVAILABLE_TEXT["no-matching-project"])}
                  </span>
                </div>
              </MenuItem>
            );
          })}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
