# claude-mods

Mods for [Claude Code](https://claude.com/claude-code): plugins built on its function hooks that change how the interface looks and behaves.

| Mod | What it does |
| --- | --- |
| [next-steps](claude-next-steps) | After each reply, shows suggested next steps as buttons above the prompt. Press 1–4 in an empty prompt box, or click one. |
| [session-bridge](claude-session-bridge) | Lets running sessions on the same machine message each other and hand off context, so one session can plan or audit while another builds. |
| [model-router](claude-model-router) | Classifies each turn as mechanical, ordinary or hard, and routes it to a matching model and reasoning effort. |

## Works anywhere

All three run wherever Claude Code runs: macOS, Windows (x64 and ARM) and Linux, in any terminal.

- **next-steps** only uses Claude Code itself.
- **model-router** asks a local Laya server when there is one, and otherwise a Claude model (the default `auto` classifier).
- **session-bridge** keeps its messages in `~/.claude/session-bridge` (`%USERPROFILE%` on Windows). Inside [cmux](https://cmux.com) or [Zendr](https://github.com/ruchira-edirisinghe/zendr) it also uses their sidebar, notifications and workspaces. Anywhere else, `/bridge-spawn` opens a new window of the system's own terminal.

## Install

In a Claude Code terminal session, install any of them by name:

```
/plugin install next-steps --marketplace iddhi-sulakshana/claude-mods
/plugin install session-bridge --marketplace iddhi-sulakshana/claude-mods
/plugin install model-router --marketplace iddhi-sulakshana/claude-mods
```

The first time, answer `y` to add the marketplace, then pick a scope: the user scope installs the mod for every session.

The function hooks API is early access and can change between Claude Code releases. These mods were built against Claude Code 2.1.296.

## Develop

Each folder is one plugin:

```
claude plugin validate claude-next-steps
claude plugin test claude-next-steps
claude --plugin-dir claude-next-steps      # a session with the mod loaded from disk
```
