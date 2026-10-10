# claude-mods

Mods for [Claude Code](https://claude.com/claude-code): plugins built on its function hooks that change how the interface looks and behaves.

| Mod | What it does |
| --- | --- |
| [next-steps](claude-next-steps) | After each reply, shows suggested next steps as buttons above the prompt. Press 1–4 in an empty prompt box, or click one. |
| [session-bridge](claude-session-bridge) | Lets running sessions on the same machine message each other and hand off context, so one session can plan or audit while another builds. |
| [model-router](claude-model-router) | Classifies each turn as mechanical, ordinary or hard, and routes it to a matching model and reasoning effort. |

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
