import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { JiraSettings, JiraSiteUrl, normalizeJiraSiteUrl } from "./jira.ts";
import { ServerSettings, secretSettingsFields } from "./settings.ts";

const decodeServerSettings = Schema.decodeSync(ServerSettings);
const isJiraSiteUrl = Schema.is(JiraSiteUrl);

describe("normalizeJiraSiteUrl", () => {
  it.each([
    ["acme.atlassian.net", "https://acme.atlassian.net"],
    [" https://acme.atlassian.net/ ", "https://acme.atlassian.net"],
    [
      "https://acme.atlassian.net/jira/software/projects/X/boards/1?selectedIssue=X-1",
      "https://acme.atlassian.net",
    ],
    ["ACME.Atlassian.NET", "https://acme.atlassian.net"],
    ["https://eu.acme.atlassian.net", "https://eu.acme.atlassian.net"],
    ["https://acme.atlassian.net:443/browse/X-1", "https://acme.atlassian.net"],
    ["http://acme.atlassian.net", null],
    ["https://acme.atlassian.net:8443", null],
    ["atlassian.net", null],
    ["https://.atlassian.net", null],
    ["evilatlassian.net", null],
    ["atlassian.net.evil.com", null],
    ["acme.atlassian.net.evil.com", null],
    ["jira.example.com", null],
    ["https://acme.atlassian.com", null],
    ["https://user:pw@acme.atlassian.net", null],
    ["", null],
    ["   ", null],
    ["not a url ::", null],
  ])("%j -> %j", (input, expected) => {
    expect(normalizeJiraSiteUrl(input)).toBe(expected);
  });

  it("accepts only normalized origins as a patch site URL", () => {
    expect(isJiraSiteUrl("https://acme.atlassian.net")).toBe(true);
    expect(isJiraSiteUrl("https://acme.atlassian.net/")).toBe(false);
  });
});

describe("JiraSettings", () => {
  it("marks the API token as the only settings secret", () => {
    expect(secretSettingsFields(JiraSettings)).toEqual(["apiToken"]);
  });

  it("decodes settings without Jira as disconnected", () => {
    expect(decodeServerSettings({}).jira).toBeNull();
  });
});
