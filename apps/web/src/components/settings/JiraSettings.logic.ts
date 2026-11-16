import {
  isSecretReference,
  normalizeJiraSiteUrl,
  type JiraSettings,
  type SecretReference,
  type ServerSettingsPatch,
} from "@t3tools/contracts";

export interface JiraDraft {
  readonly siteUrl: string;
  readonly email: string;
  readonly apiToken: string | SecretReference;
}

/** The patch that saves the draft, or why it cannot be saved. */
export function jiraSettingsPatch(
  draft: JiraDraft,
  saved: JiraSettings | null,
): { readonly patch: NonNullable<ServerSettingsPatch["jira"]> } | { readonly error: string } {
  const siteUrl = normalizeJiraSiteUrl(draft.siteUrl);
  if (siteUrl === null) {
    return { error: "Enter your Jira Cloud site, like your-team.atlassian.net." };
  }
  const email = draft.email.trim();
  if (email === "") return { error: "Enter the email of your Atlassian account." };
  const token = isSecretReference(draft.apiToken) ? draft.apiToken : draft.apiToken.trim();
  if (token !== "") return { patch: { siteUrl, email, apiToken: token } };
  // A blank token keeps the saved one.
  if (saved !== null && saved.apiToken !== "") return { patch: { siteUrl, email } };
  return { error: "Enter an API token." };
}
