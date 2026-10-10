# next-steps

A Claude Code mod that puts suggested next steps above the prompt as buttons once Claude finishes a reply:

```
Next:  1: Run the tests   2: Commit the change   3: Add error handling   x: dismiss
```

## How it works

When a reply ends, the band shows `Suggesting next steps…` while a small model reads your last prompt and Claude's reply and proposes two to four steps. Each step is a short label plus the full prompt it sends.

- **Pick one:** press its number in an empty prompt box, click it (fullscreen mode), or focus the band with `ctrl+x tab` and press Enter.
- **What a press does:** sends the step's prompt as your next message, or puts it in the prompt box to edit first (see Settings).
- **It clears** when the next turn starts, or when you press dismiss. The band's `[-]` collapses it.
- **It stays quiet** after an interrupted reply, on a subagent's turn, and in headless (`-p`) runs.
- **If it fails**, a short pop-up message says why, rather than failing silently.

When Claude asks a numbered question ("1, 2 or 3?"), typing that digit into an empty prompt box presses the button with that number instead. Type a word first, or dismiss the band.

## Settings

In `/config`, or `/plugin configure next-steps@claude-mods`:

| Setting | Values |
| --- | --- |
| `source` | `quick` (default): Haiku reads your last prompt and the reply. Cheap and fast. `full`: forks the whole conversation on the session's model. Better suggestions, but each reply costs noticeably more. |
| `onPress` | `submit` (default): send the step right away. `fill`: put it in the prompt box to edit first. |

## Install

In a Claude Code terminal session:

```
/plugin install next-steps --marketplace iddhi-sulakshana/claude-mods
```

## Develop

```
claude plugin validate .
claude plugin test .
```
