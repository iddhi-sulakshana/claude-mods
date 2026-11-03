# session-bridge

A Claude Code mod that lets running sessions on the same machine talk to each other. Each session can message the others or hand them a written context document, so one session can plan or audit while another builds.

## How it works

Sessions find each other through a folder on disk, `~/.claude/session-bridge/` (set `CLAUDE_SESSION_BRIDGE_DIR` to move it):

| Path | What it holds |
| --- | --- |
| `sessions/<session-id>.json` | One file per live session (name, role, cwd), refreshed every 10 s. A session that hasn't checked in for 30 s counts as gone. |
| `inbox/<name>/<msg-id>.json` | Messages waiting for a name that no running session has yet, or that couldn't be delivered directly. Each session checks its inbox every 2 s. |
| `archive/<name>/` | Inbox messages after delivery. A message is claimed by moving it here, so only one session can take it. |
| `handoffs/<msg-id>.md` | Handoff documents. |

Messages are addressed **by name**. How one travels depends on whether a session has that name right now:

- **A live peer:** the message goes straight to that session through Claude Code's own session messaging (`$.session.send`, the channel the built-in `SendMessage` tool uses). The receiving session shows it as a message from another session (`@ <session>›`), not as something you typed. A busy session gets it during its running turn. The header shows the sender's built-in session name; the bridge name and role are at the top of the message itself. If the direct send fails, the message goes to the inbox file instead.
- **A name no session has yet:** the message waits in that inbox until a session takes the name. That means you can hand off to `builder` before you start the builder session. When the builder session takes the name, it submits the waiting messages as a new turn once it's idle.

When a message arrives, one of two things happens:

- **Auto mode (the default):** the model reads it. It's framed as input from a peer, not from you, so your own instructions still win.
- **Manual mode:** the bridge holds the message, so the model doesn't see it yet. You get a toast, and the status line counts unread messages. Run `/bridge-inbox` to read them and pass them to the model.

To stop two sessions replying to each other forever, the bridge switches to manual mode if more than 8 messages are auto-delivered within 5 minutes.

A session keeps working on the bridge after `/clear` or `/resume`. After a `/resume`, it takes back the name the resumed conversation had on the bridge, if it had one. Otherwise it keeps its current name. Unread messages and the delivery mode carry over.

## Usage

Name each session for the part it plays:

```
/bridge-name planner plan        # in session A
/bridge-name builder build       # in session B
/bridge-name auditor audit       # in session C
```

You can also just tell the model ("you are the auditor"). It calls `bridge_identify` itself.

| Command | What it does |
| --- | --- |
| `/bridge` | Opens a pane with peers and recent messages |
| `/bridge-name <name> [role]` | Sets this session's name and role |
| `/bridge-send <name\|*> <message>` | Sends a message (`*` sends to all live peers) |
| `/bridge-handoff <name\|*> [instructions]` | Has the model summarize this conversation into a handoff document and sends it |
| `/bridge-inbox` | Reads unread messages and passes them to the model |
| `/bridge-auto [on\|off]` | Switches between auto and manual delivery |

Tools the model can call (listed as `mcp__session-bridge__*`):

- `bridge_peers`: lists live sessions
- `bridge_send`: sends a message, question, review request, status or reply
- `bridge_handoff`: sends a structured handoff (summary, next steps, files, and optionally the latest transcript messages)
- `bridge_inbox`: reads unread messages
- `bridge_identify`: sets this session's name and role

A typical plan → build → audit loop:

> **planner:** "Plan the OAuth migration, then hand it off to builder."
> → `bridge_handoff` to `builder`. The builder session picks it up and starts implementing.
> **builder:** when it's done, it sends a `review-request` to `auditor`.
> **auditor:** reviews and replies to `builder` with what it found.

The status line shows `⇄ <name> (<role>) · N peers · M unread`.

## cmux

cmux runs each Claude Code session in its own workspace. When the bridge detects it (`CMUX_WORKSPACE_ID` and `CMUX_SURFACE_ID` are set), it adds:

- **Sidebar status:** the same line the status line shows (`⇄ <name> (<role>) · N peers · M unread`) appears in the cmux sidebar for that workspace, and is cleared when the session ends.
- **Notifications on held messages:** when a message is held for `/bridge-inbox` (manual mode, or after the loop guard switches to manual), cmux raises a notification and marks the workspace unread, next to the in-session toast.
- **Tab rename:** naming a session (`/bridge-name`, `bridge_identify`, or the environment variables below) renames its cmux tab to `name (role)`, or just `name` for the default role. A row of tabs then reads planner / builder / auditor.
- **Focus button:** the `/bridge` pane shows a Focus button for each peer that runs in cmux.

Spawn and focus:

| Command | What it does |
| --- | --- |
| `/bridge-spawn <name> [role] [--skip-permissions] [-- first message]` | Opens a new cmux workspace running `claude`, already named and with its role. Anything after ` -- ` is queued as its first message. |
| `/bridge-focus <name>` | Switches cmux to that session's workspace |

The model can do the same with the `bridge_spawn` and `bridge_focus` tools. Both are only offered inside cmux. `bridge_spawn` takes `name`, and optionally `role`, `cwd`, `message` and `skip_permissions`. It refuses a name a live session already has. Permission prompts stay on unless `--skip-permissions` (or `skip_permissions`) is given, which starts the new session with `--dangerously-skip-permissions`. The model is told to set that only when you ask for it.

A spawned session picks up its identity from two environment variables, which you can also set yourself when starting `claude` by hand:

| Variable | What it sets |
| --- | --- |
| `CLAUDE_SESSION_BRIDGE_NAME` | The session's bridge name at startup |
| `CLAUDE_SESSION_BRIDGE_ROLE` | Its role (default `general`) |

Set the `cmux` option to `false` in `/config` → `session-bridge.cmux` to ignore cmux entirely, even inside it. Outside cmux nothing changes and the bridge never calls the `cmux` command.

## Install

In a Claude Code terminal session:

```
/plugin install session-bridge --marketplace iddhi-sulakshana/claude-mods
```

You can configure it in `/config`: `session-bridge.autoDeliver` (default `true`) and `session-bridge.cmux` (default `true`).

## Develop

```
claude plugin validate .
claude plugin test .
```
