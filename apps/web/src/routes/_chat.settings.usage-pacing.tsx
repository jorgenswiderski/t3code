import { createFileRoute } from "@tanstack/react-router";

import { UsagePacingSettingsPanel } from "../components/settings/UsagePacingSettings";

function SettingsUsagePacingRoute() {
  return <UsagePacingSettingsPanel />;
}

export const Route = createFileRoute("/_chat/settings/usage-pacing")({
  component: SettingsUsagePacingRoute,
});
