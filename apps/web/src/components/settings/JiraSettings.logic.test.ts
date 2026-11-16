import { type JiraSettings, SecretProviderId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { type JiraDraft, jiraSettingsPatch } from "./JiraSettings.logic";

const saved: JiraSettings = {
  siteUrl: "https://acme.atlassian.net",
  email: "me@x.com",
  apiToken: "••••••••",
};
const SITE_ERROR = "Enter your Jira Cloud site, like your-team.atlassian.net.";
const reference = { provider: SecretProviderId.make("work"), reference: "op://Work/jira" };

it.each<{
  name: string;
  draft: JiraDraft;
  saved: JiraSettings | null;
  expected: ReturnType<typeof jiraSettingsPatch>;
}>([
  {
    name: "a bare host with a typed token",
    draft: { siteUrl: "acme.atlassian.net", email: "me@x.com", apiToken: "tok" },
    saved: null,
    expected: {
      patch: { siteUrl: "https://acme.atlassian.net", email: "me@x.com", apiToken: "tok" },
    },
  },
  {
    name: "a pasted board URL and a blank token over a saved one",
    draft: { siteUrl: "https://acme.atlassian.net/jira/x", email: "me@x.com", apiToken: "" },
    saved,
    expected: { patch: { siteUrl: "https://acme.atlassian.net", email: "me@x.com" } },
  },
  {
    name: "a secret reference",
    draft: { siteUrl: "acme.atlassian.net", email: " me@x.com ", apiToken: reference },
    saved: null,
    expected: {
      patch: { siteUrl: "https://acme.atlassian.net", email: "me@x.com", apiToken: reference },
    },
  },
  {
    name: "a blank token with nothing saved",
    draft: { siteUrl: "acme.atlassian.net", email: "me@x.com", apiToken: "" },
    saved: null,
    expected: { error: "Enter an API token." },
  },
  {
    name: "an http site",
    draft: { siteUrl: "http://acme", email: "me@x.com", apiToken: "tok" },
    saved,
    expected: { error: SITE_ERROR },
  },
  {
    name: "a blank email",
    draft: { siteUrl: "acme.atlassian.net", email: " ", apiToken: "tok" },
    saved,
    expected: { error: "Enter the email of your Atlassian account." },
  },
])("jiraSettingsPatch: $name", ({ draft, saved, expected }) => {
  expect(jiraSettingsPatch(draft, saved)).toEqual(expected);
});
