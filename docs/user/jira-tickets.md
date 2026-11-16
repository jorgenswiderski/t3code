# Jira tickets and priority

Link Jira Cloud tickets to threads to see their status next to the work and to sort your inbox by
priority. T3 Code only reads from Jira. It never changes a ticket.

Servers running an older version of T3 Code do not offer any of this.

## Connect Jira

Open **Settings → Source control → Jira** on web or desktop, choose the environment, and enter your
site address, the email of your Atlassian account, and an API token. Choose **Test connection** to
check them, then **Connect**. **Disconnect** removes the connection and the saved token.

- The connection belongs to the machine that runs the server. Each environment you use needs its own.
- T3 Code reads only the tickets the token's account can see.
- Without Jira you can still set a priority on a thread. Linking tickets needs a connection.
- The mobile app has no Jira connection screen. Connect on web or desktop; mobile uses the server's
  connection.

## Link tickets

- An agent links the tickets it works on.
- A ticket key in a thread's branch name, such as `feature/PROJ-123-login`, is linked for you when the
  branch is set or changes.
- To link one yourself, open the thread's menu, the command palette, or the thread details card and
  choose **Link Jira ticket**. Paste a ticket link or a key such as `PROJ-123`. The link must be for
  the Jira site the server is connected to.

On mobile, tap the ticket button in a thread's top bar to open **Jira tickets**. Tap **+** to link a
ticket. Tap a ticket to open it in Jira, or touch and hold it to open, copy its link, or unlink it.

Linked tickets appear in **Jira tickets** in the thread details card with their status. Select one to
open it in Jira. Remove one with the **X** on its row, **Unlink** in the thread menu, or **Unlink** in
the command palette. A ticket that came from the branch name stays removed, even if the branch
changes. You can always unlink, whether or not Jira is connected.

A ticket T3 Code cannot read, because it was deleted, moved, or hidden from your account, shows as
**Unreachable** and counts for nothing until it can be read again.

## Priority

The priority scale is your Jira site's own list, in its own order. Without Jira it is Highest, High,
Medium, Low, Lowest.

A thread's priority comes from the first of these that applies:

1. The priority you set. Open the thread's menu or the command palette and choose **Priority**.
   **Clear my priority** removes it.
2. The highest priority among its linked tickets. A Done ticket still counts until you settle the
   thread.
3. The agent's guess.

On mobile, touch and hold a thread in the list and choose **Priority**, or use **Priority** at the top
of the **Jira tickets** sheet.

A small arrow on a thread in the sidebar (or beside the pin in the mobile list) shows the priority.
On the web, hover it to see where it came from: **You**, **Jira** with the ticket, or **Agent guess**.
On mobile, a screen reader announces the same. A priority you set that is not on the current
scale, for example after you connect a different Jira site, shows with a dashed icon until you pick a
new one or clear it.

## Inbox order

To list your inbox by priority, set **Settings → General → Inbox order** to **Priority**. Within a
priority, threads follow their Jira board rank, then the one that came back to you most recently.
Threads with no priority come last, and pinned threads stay on top. On mobile, **Inbox order** is in
**Settings → General** and in **Arrange threads**. See
[Working with threads](./thread-sidebar.md#fold-working-threads-beta).

## Freshness

T3 Code refreshes linked tickets about every two minutes. When Jira cannot be reached, the last known
data stays on screen and the Jira tickets section says so.
