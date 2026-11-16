import { useAtomValue } from "@effect/atom-react";
import {
  isSecretReference,
  type EnvironmentId,
  type JiraConnectionStatus,
  type JiraErrorKind,
  type JiraSettings,
  type SecretReference,
} from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { type JiraDraft, jiraSettingsPatch } from "./JiraSettings.logic";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const API_TOKEN_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";
const ERROR_LABELS: Record<JiraErrorKind, string> = {
  auth: "Authentication failed",
  unavailable: "Jira unavailable",
  response: "Unexpected reply",
};

export function JiraSettingsSection() {
  const { scope, environment } = useSettingsScope();
  const section = (children: ReactNode) => (
    <SettingsSection id={searchableSetting("jira-connection").id} title="Jira">
      {children}
    </SettingsSection>
  );
  if (scope.kind !== "environment") {
    return section(
      <SettingsScopeNotice target="environment" inline>
        Choose one environment to connect it to Jira.
      </SettingsScopeNotice>,
    );
  }
  if (!environment || environment.connection.phase !== "connected") {
    return section(
      <p className="px-4 py-3 text-sm text-muted-foreground">
        Connect an environment to link its threads to Jira.
      </p>,
    );
  }
  // An older server would drop the jira patch, so the section waits for the capability.
  if (environment.serverConfig?.environment.capabilities.threadTickets !== true) return null;
  return section(
    <JiraConnection
      key={environment.environmentId}
      environmentId={environment.environmentId}
      status={environment.serverConfig.jiraStatus ?? null}
    />,
  );
}

type TestOutcome = { readonly ok: boolean; readonly message: string } | null;

function JiraConnection({
  environmentId,
  status,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: JiraConnectionStatus | null;
}) {
  const saved = useEnvironmentSettings(environmentId, (settings) => settings.jira);
  const canEdit = useAtomValue(serverEnvironment.testJiraConnection.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save Jira connection",
  });
  const testJiraConnection = useAtomCommand(serverEnvironment.testJiraConnection, {
    label: "test Jira connection",
  });
  const secretSources = useSecretSources(environmentId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<JiraDraft>(() => blankDraft(saved, ""));
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<TestOutcome>(null);
  const connected = saved !== null && status !== null && status.state !== "disconnected";

  const change = (next: Partial<JiraDraft>) => {
    setDraft((previous) => ({ ...previous, ...next }));
    setOutcome(null);
  };

  const runTest = async (input: Parameters<typeof testJiraConnection>[0]["input"]) => {
    setBusy(true);
    setOutcome(null);
    const result = await testJiraConnection({ environmentId, input });
    setBusy(false);
    if (result._tag !== "Success") return;
    const value = result.value;
    setOutcome(
      value.type === "connected"
        ? {
            ok: true,
            message: `Connected as ${value.accountName} · ${value.priorityScale.length} ${
              value.priorityScale.length === 1 ? "priority" : "priorities"
            }`,
          }
        : { ok: false, message: value.message },
    );
  };

  const testDraft = () => {
    const result = jiraSettingsPatch(draft, saved);
    if ("error" in result) {
      setOutcome({ ok: false, message: result.error });
      return;
    }
    const { siteUrl, email, apiToken } = result.patch;
    void runTest({ settings: { siteUrl, email, apiToken: apiToken ?? "" } });
  };

  const save = async (patch: Parameters<typeof updateSettings>[0]["input"]["patch"]) => {
    setBusy(true);
    const result = await updateSettings({ environmentId, input: { patch } });
    setBusy(false);
    return result._tag === "Success";
  };

  if (saved !== null && status !== null && status.state !== "disconnected" && !editing) {
    return (
      <div className="grid gap-3 px-4 py-4 sm:px-5">
        <div className="grid gap-1 text-sm">
          <p>
            {status.accountName === null ? "Checking…" : `Connected as ${status.accountName}`}{" "}
            <span className="text-muted-foreground">
              on {siteHost(status.siteUrl ?? saved.siteUrl)}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">{saved.email}</p>
        </div>
        {status.error ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="error">{ERROR_LABELS[status.error.kind]}</Badge>
            <span>{status.error.message}</span>
            <span className="text-muted-foreground">
              since {formatRelativeTimeLabel(status.error.since)}
            </span>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <TestOutcomeText outcome={outcome} />
          {canEdit ? (
            <div className="flex shrink-0 gap-2">
              <Button size="xs" variant="outline" disabled={busy} onClick={() => void runTest({})}>
                Test connection
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setDraft(blankDraft(saved, saved.email));
                  setOutcome(null);
                  setEditing(true);
                }}
              >
                Edit
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  const email = saved.email;
                  if (await save({ jira: null })) {
                    setDraft(blankDraft(null, email));
                    setOutcome(null);
                    setEditing(false);
                  }
                }}
              >
                Disconnect
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  const tokenSaved = saved !== null && saved.apiToken !== "";
  return (
    <form
      className="grid gap-3 px-4 py-4 sm:px-5"
      onSubmit={async (event) => {
        event.preventDefault();
        const result = jiraSettingsPatch(draft, saved);
        if ("error" in result) {
          setOutcome({ ok: false, message: result.error });
          return;
        }
        if (await save({ jira: result.patch })) {
          setOutcome(null);
          setEditing(false);
        }
      }}
    >
      <fieldset disabled={busy || !canEdit} className="contents">
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Link threads to Jira Cloud issues to read their status and priority. Use an API token from
          the Atlassian account that can see those issues.{" "}
          <InlineButton
            render={<a href={API_TOKEN_URL} target="_blank" rel="noreferrer noopener" />}
          >
            Create an API token
            <ExternalLinkIcon aria-hidden className="size-3" />
          </InlineButton>
        </p>
        {!canEdit ? (
          <p className="text-xs text-muted-foreground">
            This connection lacks permission to change settings on this environment.
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={`jira-site-${environmentId}`}>Site URL</Label>
            <Input
              id={`jira-site-${environmentId}`}
              size="sm"
              autoComplete="off"
              placeholder="your-team.atlassian.net"
              value={draft.siteUrl}
              onChange={(event) => change({ siteUrl: event.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`jira-email-${environmentId}`}>Email</Label>
            <Input
              id={`jira-email-${environmentId}`}
              size="sm"
              type="email"
              autoComplete="off"
              value={draft.email}
              onChange={(event) => change({ email: event.target.value })}
            />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`jira-token-${environmentId}`}>API token</Label>
          <SecretSourceInput
            id={`jira-token-${environmentId}`}
            size="sm"
            aria-label="Jira API token"
            configured={tokenSaved && !isSecretReference(draft.apiToken)}
            value={draft.apiToken}
            sources={secretSources}
            onChange={(event) => change({ apiToken: event.target.value })}
            onSecretChange={(secret) => change({ apiToken: secret ?? "" })}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <TestOutcomeText outcome={outcome} />
          <div className="flex shrink-0 gap-2">
            {editing ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  setEditing(false);
                  setOutcome(null);
                }}
              >
                Cancel
              </Button>
            ) : null}
            <Button size="xs" variant="outline" onClick={testDraft}>
              Test connection
            </Button>
            <Button type="submit" size="xs">
              {connected ? "Save" : "Connect"}
            </Button>
          </div>
        </div>
      </fieldset>
    </form>
  );
}

function TestOutcomeText({ outcome }: { readonly outcome: TestOutcome }) {
  return (
    <p
      role="status"
      className={cn(
        "text-xs",
        outcome?.ok === false ? "text-destructive-foreground" : "text-muted-foreground",
      )}
    >
      {outcome?.message}
    </p>
  );
}

/** The saved site and email with a blank token, which keeps the saved token on save. */
function blankDraft(saved: JiraSettings | null, email: string): JiraDraft {
  const apiToken: string | SecretReference =
    saved !== null && isSecretReference(saved.apiToken) ? saved.apiToken : "";
  return { siteUrl: saved?.siteUrl ?? "", email: saved?.email ?? email, apiToken };
}

function siteHost(siteUrl: string): string {
  try {
    return new URL(siteUrl).host;
  } catch {
    return siteUrl;
  }
}
