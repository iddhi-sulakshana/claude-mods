# model-router

A Claude Code mod that classifies each turn before its first model request, then routes the request:

| Tier | What it covers | Effort | Model (only when main-model switching is on) |
| --- | --- | --- | --- |
| **mechanical** | Small, local, low-risk work: renames, typos, formatting, one-line changes | Lowered to `mechanicalEffort` (default `low`) | `cheapModel` (default `claude-haiku-5-5`) |
| **ordinary** | Normal engineering | Unchanged | `ordinaryModel` (default `claude-sonnet-5-5`) |
| **hard** | High-stakes or deep work: security, auth, payments, migrations, production, concurrency, architecture, unknown bugs | Raised to `hardEffort` (default `xhigh`) | `strongModel` (default `claude-opus-5-5`) |

The models form a ladder: Opus 5.5 at the top, then Sonnet 5.5, then Haiku 5.5. Nothing above Opus is ever used. A configured model that isn't on the ladder is ignored, and the line says so. If the session already runs the tier's model, including a variant such as `claude-opus-5-5[1m]`, it is kept.

## How it decides

When you submit a prompt, the router stores its text. At the turn's first model request it classifies the prompt with the `classifier` setting.

### `laya` (default): the local Laya decision server

The router posts the prompt alone to laya-serve at `layaUrl` (default `http://127.0.0.1:8765/v1/systemone`). It asks Laya's own router questions: `difficulty` (trivial, easy, moderate or hard) and `is_sensitive` (money, legal, medical or safety). There's no API cost, and a warm server answers in about 0.5 s. If Laya hasn't answered within 5 s, the request goes out unchanged.

Laya returns calibrated probabilities, so the rules read the distribution. The mechanical tier is the trivial and easy probabilities added together.

- **Weak evidence moves up.** A hard probability of at least 0.25 makes the turn hard.
- **High-stakes signals move up.** Laya's `is_sensitive` at 0.5 or more, or a high-stakes word in the prompt (prod, auth, payments, migration, secrets, …), makes the turn hard unless ordinary is at least 0.85.
- **Moving down requires confidence.** A turn is mechanical only when the mechanical probability is at least 0.75, there are no signals, and `is_sensitive` is below 0.2. Laya scores how hard a request is to answer, not how risky it is. A short question about prod payments reads as easy (0.95), so the low-sensitivity check is part of being confident.
- Anything else is ordinary.
- **Short approvals inherit.** A reply made only of approval phrases ("yes", "go ahead", "ok do it", "lgtm") isn't classified. It takes the previous turn's tier, or ordinary if there is none. Laya never sees the previous reply because it scores everything it's given, and a long reply next to "commit" dropped its low-difficulty score from 0.86 to 0.19.

### `model`: a Claude model

`classifierModel` (default `haiku`, effort `low`, 10 s timeout) returns a tier and a confidence. Confidence below 0.6 moves the tier up one level. A turn is only mechanical with confidence ≥ 0.85 and no high-stakes words. High-stakes words move an ordinary turn up to hard unless the classifier said ordinary with confidence ≥ 0.85.

### Either way

Effort never moves the wrong way: hard never lowers it and mechanical never raises it. With switching on, the model is the tier's rung of the ladder. Every later request in the same turn gets the same treatment. Subagent requests are never touched.

Every decision is logged in the transcript as a dim line, for example:

```
router: mechanical [laya difficulty 0.65 (low 0.89 / mid 0.09 / high 0.02), sensitive 0.05] → effort medium → low, model unchanged (main-model switching off)
router: hard [laya difficulty 0.82 (low 0.95 / mid 0.03 / high 0.02), sensitive 0.39; signals (production, payments), up to hard] → effort medium → xhigh, model unchanged (main-model switching off)
```

## Failure behaviour

If anything fails, the request goes out unchanged, and the line says so:

- The classifier (Laya, or the Claude model) errors, times out, is unreachable, or gives an answer that can't be read.
- The router itself throws.
- No prompt started the turn.
- A routed request fails before streaming any output. It is resent once with your original model and effort.

## Prompt cache

- **Model switching is off by default.** The prompt cache is per model, so each switch re-reads the whole conversation uncached.
- **Effort routing also has a cache cost.** Changing the top-level effort mid-conversation invalidates the cached messages for that request. The effort only changes when consecutive turns land in different tiers. Turn `routeEffort` off if this matters more than effort tuning.

## Commands

- `/router`: status and the last decision
- `/router off` / `/router on`: pause or resume routing for this session
- `/router model on|off|default`: override main-model switching for this session

## Settings

Change these in `/config` (or with `claude plugin configure model-router@model-router`):

`classifier` (`laya` or `model`), `layaUrl`, `classifierModel`, `routeEffort`, `switchMainModel`, `strongModel`, `ordinaryModel`, `cheapModel`, `mechanicalEffort`, `hardEffort`.

## Develop

```
claude plugin validate .
claude plugin test .
claude -p "…" --plugin-dir .      # one-off run without installing
```

## Install

In a Claude Code terminal session:

```
/plugin install model-router --marketplace iddhi-sulakshana/claude-mods
```
