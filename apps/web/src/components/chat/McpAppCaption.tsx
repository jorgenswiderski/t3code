import { AuthSettingsWriteScope, type EnvironmentId } from "@t3tools/contracts";
import type { McpAppReference } from "@t3tools/shared/mcpApp";
import { EyeOffIcon } from "lucide-react";
import { useState } from "react";
import { setMcpAppServerHidden } from "~/state/hiddenMcpAppServers";
import { useEnvironmentScope } from "~/state/session";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function McpAppCaption({
  environmentId,
  app,
}: {
  readonly environmentId: EnvironmentId;
  readonly app: McpAppReference;
}) {
  const canHide = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const [pending, setPending] = useState(false);

  const hide = async () => {
    setPending(true);
    const hidden = await setMcpAppServerHidden(environmentId, app.server, true);
    if (hidden) {
      const id = toastManager.add({
        type: "success",
        title: `Apps from ${app.server} hidden`,
        description: "Show them again in Settings → Chat.",
        actionProps: {
          children: "Undo",
          onClick: () => {
            toastManager.close(id);
            void setMcpAppServerHidden(environmentId, app.server, false);
          },
        },
      });
    }
    setPending(false);
  };

  return (
    <div className="flex h-6 min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full bg-muted-foreground/60"
        />
        <span className="truncate">
          {app.server} · {app.tool}
        </span>
      </span>
      {canHide ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost-muted"
                size="micro"
                aria-label={`Hide apps from ${app.server}`}
                disabled={pending}
                onClick={() => void hide()}
              >
                <span
                  aria-hidden="true"
                  className="-mr-1 max-w-0 overflow-hidden opacity-0 transition-[max-width,margin,opacity] duration-120 ease-out motion-reduce:transition-none in-[button:is(:hover,:focus-visible)]:mr-0 in-[button:is(:hover,:focus-visible)]:max-w-10 in-[button:is(:hover,:focus-visible)]:opacity-100"
                >
                  Hide
                </span>
                <EyeOffIcon />
              </Button>
            }
          />
          <TooltipPopup side="top">Hide apps from {app.server}</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}
