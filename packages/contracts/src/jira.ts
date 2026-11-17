import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SettingsSecretValue } from "./settingsSecretValue.ts";
import { PriorityRef } from "./threadTicket.ts";

const JIRA_CLOUD_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+atlassian\.net$/;

/** A Jira Cloud site's https origin; a bare host gets https, and any path (a pasted board URL) is dropped. */
export function normalizeJiraSiteUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port !== "" ||
      !JIRA_CLOUD_HOST.test(url.hostname)
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export const JiraSiteUrl = TrimmedNonEmptyString.check(
  Schema.makeFilter((value) => normalizeJiraSiteUrl(value) === value),
);

export const JiraSettings = Schema.Struct({
  // Stored leniently so an odd saved value cannot fail the whole settings file; JiraService normalizes.
  siteUrl: TrimmedNonEmptyString,
  email: TrimmedNonEmptyString,
  /** `secretSetting` from settings.ts, which imports this module. */
  apiToken: SettingsSecretValue.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({ settingsSecret: true }),
  ),
});
export type JiraSettings = typeof JiraSettings.Type;

export const JiraErrorKind = Schema.Literals(["auth", "unavailable", "response"]);
export type JiraErrorKind = typeof JiraErrorKind.Type;

export const JiraConnectionStatus = Schema.Struct({
  state: Schema.Literals(["disconnected", "connected", "error"]),
  siteUrl: Schema.NullOr(TrimmedNonEmptyString),
  accountName: Schema.NullOr(TrimmedNonEmptyString),
  error: Schema.NullOr(
    Schema.Struct({ kind: JiraErrorKind, message: Schema.String, since: IsoDateTime }),
  ),
});
export type JiraConnectionStatus = typeof JiraConnectionStatus.Type;

/** Unsaved settings to test; an empty or redacted token uses the saved one. */
export const JiraTestConnectionInput = Schema.Struct({ settings: Schema.optional(JiraSettings) });
export type JiraTestConnectionInput = typeof JiraTestConnectionInput.Type;

export const JiraTestConnectionResult = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("connected"),
    accountName: TrimmedNonEmptyString,
    priorityScale: Schema.Array(PriorityRef),
  }),
  Schema.Struct({
    type: Schema.Literal("failed"),
    kind: Schema.Literals(["auth", "unavailable", "response", "invalid_site"]),
    message: Schema.String,
  }),
]);
export type JiraTestConnectionResult = typeof JiraTestConnectionResult.Type;
