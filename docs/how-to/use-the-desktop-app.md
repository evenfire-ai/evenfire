# How to: use the Desktop App day to day

The Desktop App is where members chat with their agents, approve the actions
that need a human, open the apps that plugins ship, and work with files in
EvenDrive. This guide walks through the screens as they appear in the app. It
is written for members, and for the admins who help them.

For what the app is and how it connects to the platform, see
[Desktop App](../surfaces/desktop-app.md). For adding environments, the
invitation setup, and update checks, see
[Desktop setup & updates](desktop-setup-and-updates.md).

> **Shortcut convention.** **Mod** means **Cmd (⌘)** on macOS and **Ctrl** on
> Windows and Linux. For example, Mod+K is ⌘K on a Mac and Ctrl+K elsewhere.

## First run

The first time you open the app, it has no server to connect to yet, so it
shows a short setup wizard instead of the sign-in screen. The first question
is **Do you already have an Evenfire server?**, and it has three answers:

| Answer                            | What happens next                                                                                                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **My team already uses Evenfire** | **Connect to your team**: enter the email address your team invited and choose **Continue setup**. The app opens your browser so you can finish setup there.                                                                                   |
| **I have a server address**       | **Connect to a server**: enter an **Environment name** and the **External REST API** address, then choose **Save environment**. If the app finds an Evenfire server running on this computer, it also offers a one-click **Localhost** option. |
| **No, I'm just getting started**  | **How do you want to run Evenfire?**, with three choices: **Evenfire hosts it for me**, **I'll run it myself**, or **I have no idea**. The last one opens **Which one is right for you?**, which compares the two options.                     |

The hosted and self-hosted choices each explain the option and offer a
button that opens more in your browser: **See hosted Evenfire** or
**Open the deployment guide**. A second button,
**I have a server — enter its address**, takes you to **Connect to a server**. Use **Back** at the bottom of the card to change an
earlier answer.

After setup you sign in with your **Email** and **Password**. If you forgot
your password, **Forgot password** opens the reset page in your browser.
Environments are added and switched from the **Environment** selector at the
bottom of the sign-in screen. See
[Desktop setup & updates](desktop-setup-and-updates.md) for details.

## Find your way around

### Sidebar

| Entry                 | What it does                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chat**              | Opens your chats. The **New chat** button next to it starts a chat. Expand it to see your most recent sessions. Each session has a **⋯** menu with **Rename** and **Delete** (deleted messages can't be recovered). |
| **Apps**              | Opens the app picker. Expand it to launch an app directly.                                                                                                                                                          |
| **EvenDrive**         | Opens your files. Expand it to see a file tree that you can browse right in the sidebar.                                                                                                                            |
| **Settings** (bottom) | Opens a menu that shows your name and email, plus **Agents**, **Connectors**, **Plugins**, **Settings**, and **Logout**.                                                                                            |

You can collapse the sidebar to icons with **Collapse sidebar** and bring it
back with **Expand sidebar**.

### Tabs and Home

Chats, apps, EvenDrive folders, and file previews open as **tabs** in one
strip across the top of the window. Tabs stay open as you move around the
app. You can drag a tab to reorder it, and close it with its **×**. Closing a
chat tab doesn't delete the conversation; you can reopen it from the sidebar.
When no tabs are open, Home shows **Nothing open** with a **New chat** button.

### Title bar

The window has its own title bar on every platform:

- **Search** (Mod+F) searches your **Agents**, **Connectors**, **Plugins**,
  and **Apps**.
- The bell, **Notifications and approvals**, opens your inbox. When something
  is waiting on you, it shows a **Pending approvals** section at the top.
- **Open chat drawer** appears while you're on a tab that isn't a chat, such
  as an app or a folder. It opens a chat panel on the right so you can talk to
  an agent alongside your work.
- The window buttons (**Minimize**, **Maximize**/**Restore**, **Close**)
  follow your platform's order. Double-click an empty part of the title bar
  to maximize or restore the window.

### Chat drawer

The chat drawer is a resizable panel on the right. At the top is the
**Open chats** switcher, which lets you jump between open chats. While an app
is open, Mod+E opens the drawer and puts you in the switcher. The
drawer also has buttons for **New chat**, **Open chat in full screen**, and
**Collapse chat drawer**. If the window gets too narrow, the drawer hides
itself and comes back when there's room again.

## Chat with an agent

1. Start a chat with **New chat** (or Mod+T). The page asks
   **Start a new conversation with:** followed by an agent picker. Choose the
   agent you want.
2. Type in the composer. **Enter** sends the message. **Shift+Enter** adds a
   new line. While a chat is showing, in a tab or in the drawer, Mod+Shift+L
   moves the cursor to the composer.
3. While the agent works, a live status line shows what it's doing, such as
   `Using <tool>`, `Thinking …`, or `Finished <tool>`. When the answer
   arrives, **More details · N tools** expands the steps behind it, and the
   square **Stop agent** button cancels a run that's still going.

### Add context and attach files

The **+** button (**Add context**) in the composer opens a menu with:

- **Plugins** and **Connectors**: attach a reference to a specific plugin or
  connector so the agent knows to use it.
- **Upload Files**: pick files from your computer. You can also drag files
  onto the composer (**Drop files here**) or paste them in.

The composer checks each message before sending it and explains anything
that won't fit:

| Limit                                               | Value                                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Attachments per message (images and files together) | 20                                                                                              |
| Size of each file                                   | 11 MiB                                                                                          |
| Size of all files in one message, once encoded      | 16 MiB                                                                                          |
| Image formats                                       | JPEG and PNG                                                                                    |
| Size of each image (most models)                    | 3 MB, with up to 8 MB of images per message (measured after encoding, about 6 MB of image data) |

Some models accept larger images. For Codex and Grok subscription models, the
limit is 16 MiB per image and 16 MiB in total, and Codex images can be at
most 2048 px on their longest side. If the model you've chosen doesn't accept
images, the composer tells you.

### Choose a model for this chat

The model chip in the composer shows which model the chat uses. Click it to
pick another model your admin allows. The change **applies to your next
message**, not to one that's already running. If the list can't load, the
chip reads **Models unavailable**; click it to try again.

### Approve, deny, or connect

Some tool calls need your approval before they run, depending on how your
admin set up approvals (see [Configure approvals](configure-approvals.md)).
When that happens, the run pauses in the chat and shows
**`<tool>` requires approval**, with a preview of the tool's input and
**Approve** and **Deny** buttons. Approvals from plugin workflows also show up
under **Pending approvals** in the notifications inbox.

If a connector needs you to sign in first, the chat shows
**Connect `<server>` to continue** and a **Connect `<server>`** button
instead. The button opens the provider's sign-in page.

### Generated files

When an agent produces files, they appear under the answer in a
**Generated files** list. You can **Download** each file, or use
**Download all**. HTML and Markdown files also have a **Preview** button.

## EvenDrive

**EvenDrive** in the sidebar opens the **Files** page. It starts at
**Shared with me**, which lists everything that has been shared with you;
click a folder to go into it. The breadcrumb at the top shows where you are.

- **Add files.** In a folder you can edit, use **New folder** and
  **Upload file**, or drag files onto the page. The server sets the size
  limit for uploads, and the app tells you if a file is too large.
- **Organize.** Each item's menu has **Rename**, **Move to…**, **Download**,
  and **Delete**, depending on your access. When you open a file you can edit,
  its menu also has **Replace file**. You can also drag an item onto a folder
  to move it. Deleting a file or folder deletes it for everyone who has
  access.
- **Share.** Choose **Share** to open the sharing dialog. Under
  **Add people, teams, agents, or workflows**, you can give someone **Read** or
  **Editor** access. The **People with access** list shows who already has
  access, including people who get it from a parent folder. A folder's
  permissions apply to everything inside it, so changing or removing someone's
  inherited access on one item asks you to confirm the change on the parent
  folder (**Update role on parent folder?** or **Remove from parent folder?**).
  To give one file less access than its folder, put it in a separate folder
  with more limited access.
- **Preview.** Images, Markdown, and videos open in a preview tab.
- **Links.** **Copy link** copies a link to an item. On **Shared with me**,
  **Open EvenDrive link** lets you paste a link to go straight to that item.

For how EvenDrive storage works behind the scenes (the GlobalFileSystem), see
[Shared and global files](shared-and-global-files.md).

## Agents

**Settings → Agents** lists the agents you can use (_Create, manage, and
monitor your AI agents from one place_). Open an agent to see its
**Connectors**, **Members**, and **Activity** sections. In a new chat, each
agent in the agent picker has a **⋯** menu that jumps to the same sections.

## Connectors

**Settings → Connectors** lists each connector for each agent you can use,
with a status of **Authorized**, **Requires setup**, or **No OAuth**. Choose
**Authorize** to sign in to a connector's provider, or **Disconnect** to
remove your access. Hover over the status to see whether access applies only
to you or is shared with your whole Context. Click a row to open that
agent's own Connectors tab. For the full sign-in flow, see
[Connect an OAuth connector](connect-oauth-connector.md).

## Apps and Plugins

**Apps** lists the apps that your plugins provide (_Discover and launch tools to
help you work smarter_). Click an app to open
it in a tab inside the app window. While an app is open, the title bar has
**Refresh app content** and **Copy current app link**. The first time a
plugin asks to read your information, you'll see
**`<plugin>` wants access to your information**, with **Allow** and **Deny**.
You can review or remove that access later under
**Settings → Plugin permissions**, using **Revoke** or **Revoke all**.

**Settings → Plugins** lists the plugins deployed for you, along with their
**Status** and **Recent Runs**. You can download files produced by recent
runs from here. **Trigger** starts a plugin, asking for any inputs it needs,
if the plugin supports being started by hand. **Refresh** reloads the
run list.

## Keyboard shortcuts and the command palette

| Shortcut                  | Action                                                                |
| ------------------------- | --------------------------------------------------------------------- |
| Mod+T                     | New chat tab                                                          |
| Mod+E                     | Open chats switcher (while an app is open)                            |
| Mod+W                     | Close current tab (the conversation is kept)                          |
| Mod+1 … Mod+8             | Select tab 1–8                                                        |
| Mod+9                     | Select last tab                                                       |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab (this is Ctrl on every platform, including macOS) |
| Mod+F                     | Focus global search                                                   |
| Mod+Shift+F               | Search current content (find text in the open chat or app)            |
| Mod+Shift+L               | Focus message composer (while a chat is showing)                      |
| Mod+K                     | Open command palette                                                  |
| Mod+,                     | Open Settings                                                         |

These shortcuts also work while an app has focus. You can't change them:
**Settings → Shortcuts** lists them for reference only.

**Mod+K** opens the command palette (**Type a command**). Besides everything
in the table above, it can run commands that have no shortcut:
**Keyboard shortcuts**, **Log out**, **Go to Chat / Apps / Agents / Plugins /
Connectors / EvenDrive**, **Open notifications and approvals**,
**Toggle sidebar**, **Refresh current app**, and **Back to Apps**. The palette
only lists the commands that make sense at that moment.

## Links that open the app

The app handles `evenfire://` links:

| Link                                                      | What it does                                                                                                                                                                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evenfire://desktop-environment?externalRestApiBaseUrl=…` | Adds or updates an environment. The app first asks **Add desktop environment?** and shows the addresses, so you can check that you trust them. Profile UI's **Open desktop app and setup** button opens this kind of link. |
| `evenfire://desktop-setup?…`                              | Finishes invitation setup after you complete it in the browser.                                                                                                                                                            |
| `evenfire://logout`                                       | Signs the app out.                                                                                                                                                                                                         |
| `evenfire://app/<namespace>/<name>?path=…&team=…`         | Opens an app, optionally on a specific page and team. The app first asks **Open app link?**; choose **Open** or **Dismiss**.                                                                                               |

**Copy current app link** copies a regular web link of the form
`https://<profile-ui>/open/apps/<namespace>/<name>`, which you can paste
anywhere. Opening it in a browser hands it to the Desktop App as an
`evenfire://app/…` link, so the person you share it with lands in the same
app (as long as they have access to it).

## Settings

Open Settings with **Settings → Settings** or Mod+,. It has these tabs:

- **Account**: your name and email. **Edit** and **Update password** open
  your profile in Profile UI.
- **Appearance**: **Dark** or **Light** theme.
- **Notifications**:
  - **In App Notifications** and **Desktop notifications** each let you
    choose **Always show notifications**, **Show while I'm elsewhere in
    Evenfire**, or **Show only when I'm away from Evenfire**.
  - **Channel fallback** chooses whether Telegram or Slack should get plugin
    notifications when the desktop app doesn't acknowledge them in time.
  - **Notification sound** sets the alert volume.
- **Plugin permissions**: see [Apps and Plugins](#apps-and-plugins).
- **Social channels**: appears only if your account has social channels
  available. It links to Profile UI to set them up.
- **Shortcuts**: the keyboard shortcut reference.
- **Information**: the app version, the External REST API and RPC proxy
  addresses with their versions and health, and whether an update is
  required. This is the first place to look when something seems off.

Environments aren't managed in Settings. Add and switch them from the
**Environment** selector on the sign-in screen.

## Troubleshooting

| You see                                                                                                                   | What it means / what to do                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| On sign-in: **Couldn't reach `<environment>`. A local Evenfire looks like it's running — switch to `<other>` and retry?** | The selected environment isn't responding, but one on this computer is. Choose **Switch to `<other>` & retry**, or pick the right environment from the **Environment** selector. |
| **Services Unavailable**, with `external-rest-api` or `rpc-proxy` marked unavailable                                      | The app can't reach the server. Choose **Retry Health Check**. If it keeps failing, ask your admin whether the server is up.                                                     |
| **Desktop update required**                                                                                               | Your server needs a newer version of the app. **Download update** opens the release page. **More info** shows the version you have and the latest one.                           |
| **Desktop notifications are blocked by system permission.** (in **Settings → Notifications**)                             | Allow notifications for Evenfire in your operating system's settings.                                                                                                            |
| The composer says **Agent degraded — fix the LLM Secret to resume.**                                                      | The agent's model credentials aren't working. An admin needs to fix the agent's LLM Secret.                                                                                      |
| **Connect `<server>` to continue** in a chat                                                                              | Choose **Connect `<server>`**, or use **Authorize** on the Connectors page.                                                                                                      |
| **Models unavailable** on the model chip                                                                                  | The model list couldn't load. Click the chip to try again.                                                                                                                       |
| **File access is not authorized** in EvenDrive                                                                            | Choose **Retry file access**. If it still fails, sign in again or ask an admin.                                                                                                  |
| **Session refresh failed: …** in an open app                                                                              | Close the app and open it again.                                                                                                                                                 |
| **A message can carry at most 20 attachments.** (or a size message)                                                       | Remove some attachments, or split them across several messages. See [the limits above](#add-context-and-attach-files).                                                           |
| Something else looks wrong                                                                                                | Check **Settings → Information** for health status and versions, and share it with your admin.                                                                                   |

## Related

- [Desktop App](../surfaces/desktop-app.md): what the app is, how it's wired, how to package it
- [Desktop setup & updates](desktop-setup-and-updates.md): environments, invitations, update checks
- [Configure approvals](configure-approvals.md): which tool calls ask for approval
- [Connect an OAuth connector](connect-oauth-connector.md): the connector sign-in flow
- [Shared and global files](shared-and-global-files.md): the storage behind EvenDrive
- [Profile UI](../surfaces/profile-ui.md): account, password, and desktop setup in the browser
