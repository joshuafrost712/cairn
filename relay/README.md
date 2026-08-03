# The workshop's AI machine (tl-21)

A small HTTP service, no dependencies, that runs this workshop's AI work on the Claude
subscription installed on this machine. Started with `npm run relay`; wiped with
`npm run relay:wipe`.

**The runbook lives in the vault**, per the standing convention that setup and operating
docs are readable in Obsidian rather than buried in a repo:

> `Areas/AI/Honest Eval workshop AI machine.md`

Edit that note, not this stub. What is here is only what you need at the keyboard.

```
npm run relay                 # start it; prints the address, the token and the drop folder
npm run relay -- --port 8792  # move it
npm run relay:wipe            # empty the state directory, including the token
```

State lives in `~/Library/Application Support/honest-eval-relay/` (never `/tmp`): one JSON
file per job in `jobs/`, the bearer token in `token`, the folder exchange in `drop/`, and
`relay.log`, which never contains capture text.

Four things worth knowing before changing anything in here:

- **`queue.mjs` is pure and holds every decision about time** (leases, attempts, purging).
  `state.mjs` reads and writes files and applies what those functions return. Tests drive
  the pure half with a fabricated clock.
- **The payload goes on stdin, never on argv**, and the child is spawned with an argument
  array and no shell. A dictated capture is arbitrary text.
- **No tool is available (`--tools ''`, an empty allowlist) and `ANTHROPIC_API_KEY` is
  deleted from the child's environment.** The worker's job is text in, JSON out, on a
  subscription. The allowlist replaced a denylist at pre-merge review: a denylist has to
  stay exhaustive against a CLI that keeps shipping new built-in tools, and an empty
  allowlist does not.
- **`--bare` looks purpose-built for this and breaks subscription auth** ("OAuth and
  keychain are never read"). The flags in `claudeArgs` are the supported way to get a small
  prompt, and the numbers are **166 input tokens per call, against 14,136 with the tools
  enabled** (same job, real CLI, 2026-08-03). Two earlier figures in this file were wrong:
  replacing the system prompt is worth ~3,400 of that, not all of it, and the rest is the
  tool schemas, which arrive as a cache read that `usage.input_tokens` alone does not count.

Harnesses: `node scripts/tl21-relay-checks.mjs` (54 checks, add `--real` for one job
through the real CLI), `node scripts/tl21-local-agent.mjs` (the browser),
`node scripts/tl21-offline.mjs` (the built app with the internet cut).
