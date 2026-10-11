import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Input } from "../ui/input";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  snapOffHoursWeight,
  workHoursFromTimeInputs,
  workHoursToTimeInputs,
} from "./usagePacingSettings.logic";
import { WeekdayToggleGroup } from "./WeekdayToggleGroup";

export function UsagePacingSettingsPanel() {
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  const workHours = workHoursToTimeInputs(settings.usagePacingWorkHours);

  const commitWorkHours = (start: string, end: string) => {
    const next = workHoursFromTimeInputs(start, end);
    if (next !== null && next !== settings.usagePacingWorkHours) {
      void updateSettings({ usagePacingWorkHours: next });
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection id="usage-pacing" title="Usage pacing">
        <SettingsRow
          {...searchableSetting("usage-pacing-show-session")}
          description="Show the 5-hour window in the chat header."
          control={
            <Switch
              checked={settings.usagePacingShowSession}
              onCheckedChange={(checked) =>
                void updateSettings({ usagePacingShowSession: Boolean(checked) })
              }
              aria-label="Show session window"
            />
          }
        />
        <SettingsRow
          {...searchableSetting("usage-pacing-show-weekly")}
          description="Show the weekly all-models window in the chat header."
          control={
            <Switch
              checked={settings.usagePacingShowWeekly}
              onCheckedChange={(checked) =>
                void updateSettings({ usagePacingShowWeekly: Boolean(checked) })
              }
              aria-label="Show weekly window"
            />
          }
        />
        <SettingsRow
          {...searchableSetting("usage-pacing-show-model-scoped")}
          description="Show per-model weekly windows, such as Fable."
          control={
            <Switch
              checked={settings.usagePacingShowModelScoped}
              onCheckedChange={(checked) =>
                void updateSettings({ usagePacingShowModelScoped: Boolean(checked) })
              }
              aria-label="Show model-scoped weekly windows"
            />
          }
        />
        <SettingsRow
          {...searchableSetting("usage-pacing-work-hours")}
          description="Weekly pace counts these hours in full. An end at or before the start runs past midnight."
          control={
            <div className="flex items-center gap-2">
              <Input
                type="time"
                nativeInput
                className="w-32"
                aria-label="Work hours start"
                value={workHours.start}
                onChange={(event) => commitWorkHours(event.target.value, workHours.end)}
              />
              <span className="text-xs text-muted-foreground">to</span>
              <Input
                type="time"
                nativeInput
                className="w-32"
                aria-label="Work hours end"
                value={workHours.end}
                onChange={(event) => commitWorkHours(workHours.start, event.target.value)}
              />
            </div>
          }
        />
        <SettingsRow
          {...searchableSetting("usage-pacing-work-days")}
          description="Days that count toward weekly pace. Other days do not move the pace."
          control={
            <WeekdayToggleGroup
              aria-label="Work days"
              value={settings.usagePacingWorkDays}
              onChange={(days) => void updateSettings({ usagePacingWorkDays: days })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("usage-pacing-off-hours-weight")}
          description="How much an hour outside work hours counts on a work day, from 0 to 1."
          control={
            <NumberField
              size="sm"
              className="w-24"
              min={0}
              max={1}
              step={0.05}
              smallStep={0.05}
              value={settings.usagePacingOffHoursWeight}
              format={{ minimumFractionDigits: 0, maximumFractionDigits: 2 }}
              onValueCommitted={(value) => {
                const weight = value === null ? null : snapOffHoursWeight(value);
                if (weight !== null) void updateSettings({ usagePacingOffHoursWeight: weight });
              }}
            >
              <NumberFieldGroup>
                <NumberFieldInput aria-label="Off-hours weight" />
              </NumberFieldGroup>
            </NumberField>
          }
        />
        <SettingsRow
          {...searchableSetting("usage-pacing-context-ring")}
          description="Shows the thread's context size and prompt-cache state as a ring next to the send button. The sidebar always shows it."
          resetAction={
            settings.composerContextRingEnabled !==
            DEFAULT_UNIFIED_SETTINGS.composerContextRingEnabled ? (
              <SettingResetButton
                label="context ring in composer"
                onClick={() =>
                  void updateSettings({
                    composerContextRingEnabled: DEFAULT_UNIFIED_SETTINGS.composerContextRingEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.composerContextRingEnabled}
              onCheckedChange={(checked) =>
                void updateSettings({ composerContextRingEnabled: Boolean(checked) })
              }
              aria-label="Show context ring in composer"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
