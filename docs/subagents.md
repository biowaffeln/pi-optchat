# Subagents in detail

The README covers the basics. This page has the rest.

## What a child gets

- The profile's memory view (frozen at launch), its instructions, read-only `zoom`/`date`, and normal coding tools plus your installed extensions (except pi-optchat itself).
- The Pi built-in extensions the main session loaded: MCP, codemode and tool search.

### MCP servers

Your MCP servers (`~/.pi/agent/mcp.json`, the project's `.pi/mcp.json`) work in subagents, with the sign-ins you made in Pi.

- If MCP is off in the main session (`--no-mcp`, `-builtin:mcp` in settings, or an extension that replaces `/mcp`), it is off in subagents too.
- Each subagent opens its own server connections (stdio servers start once per subagent) and closes them when it ends.

## Model and thinking level

Each task runs the profile's subagent model (`/optchat agents model`), unless the spawn sets that task's `model` (`provider/id`, as in `/model`) or `thinking`. The agent sets them only when you ask for them.

- What a task leaves out comes from the profile: a model alone runs at the profile's thinking level, or the nearest level that model takes.
- The agent's instructions name the profile's subagent model and level, so it leaves a task's `model` unset unless you ask for another one. The `models` tool (`provider` optional) lists what a task may name, with the default marked; the agent is told to take ids only from it, never from memory, since the newest ids may postdate its training ("Opus" without a version means the newest).
- A model Pi doesn't know refuses the whole spawn before any child starts, and the error lists the models you can use.
- A resumed child keeps the model and level it ran with.

## Reports

Each child reports to its parent as soon as it finishes, as one message starting `[id]`. The parent stays alive to receive reports; it never polls.

- A failed child reports its error text.
- A child whose request aborts with no stop (a provider abort) still reports `Task aborted: ...`.
- A stopped child's report says who stopped it (you, the agent that started it, or Pi closing while it was paused) and that `tell` resumes it, followed by its last message when it has one.

### Grouped reports

Turn **Group subagent reports** on to have the children of one spawn report together: when the last of them finishes, their reports reach the parent as one message, `[id] report` each, in spawn order.

- Each finished report is journaled right away, so if Pi dies before the rest finish, the reports it already has are delivered at the next start.
- Messages sent with `tell_parent`, connected windows and their handoffs are never held back.
- A child resumed with `tell` reports on its own.

### How reports look

In the main chat, subagent messages and reports appear in a dark grey box labelled `↳ subagent <id> · still running` or `· report`, so they don't look like something you typed.

- The model still receives them as ordinary user messages.
- Memory logs them as kind `work` (older logs hold them as `user` messages starting `[id]`).
- Exception: reports recovered at startup, before your first message in the session, still show as plain user messages.

### Reading a child's chat

Every report ends with `Full chat: zoom("<id>")`, so the agent can check it against what the child actually did. The report box leaves this trailer out.

`zoom` with a run ID returns that child's chat so far as `kind|text` lines: its task without the memory view, replies, tool calls, tool results cut to their first and last ~500 characters, and what it was told. It comes in 25,000-character pages that say which `offset` to go on from. It works on running children too. A subagent can read only its own descendants' chats, as with `tell`.

## The "agents at work" status line

While any subagent runs, each new input to the main agent (your message, a report, a `tell_parent` message, the restart note) ends with one status line:

```
[OptChat status] Agents at work now: 8f28e694 "Review PR #123 carefully", …
```

It lists the id and the first words of each task, so the main agent knows what is still out without asking.

- It is rebuilt each time and never stored.
- It isn't repeated on the calls after a tool result within one turn, and nothing is sent while no agent runs.
- The main prompt says what the label means, so the model doesn't take it for the user.
- It comes after the cached view and turn, with the turn's cache mark on the block before it, so it costs no cache.

## Talking to a running child

- The parent sends a running child guidance with `tell`.
- The child messages its parent mid-run with `tell_parent` (a question, an early finding). It reaches the parent like a report, marked "still running": between tool calls if the parent is busy, or waking it if it's waiting.

## Resuming a finished child

`tell` to a finished child resumes it: the same agent (ID, parent, model, directory) reopens its saved transcript, gets the message as a new prompt, and sends a new report.

- This also works for children from earlier Pi sessions: a session that closes leaves its subagents to the next one that opens the profile (see [branches.md](branches.md)). Children of a session still open elsewhere belong to that session.
- Only the agent that started the child can resume it, and the resumed child takes one active slot.
- A child whose transcript is missing must be spawned fresh.

## Levels and limits

- By default only the main agent starts subagents. Set **Subagent levels** in `/optchat settings` to let them delegate further (3 means child, grandchild, great-grandchild).
- **Max active agents** (8 by default) caps how many agents can be active per profile, including parents waiting on descendants.
- Going over a limit returns an error; there is no queue.

## Stopping and restarts

- Stopping an agent stops its whole subtree. A failed parent stops its descendants.
- Agents run inside the Pi process. Closing Pi stops them; there is no detached mode.
- Subagents that were working when Pi closed, crashed or `/reload`ed are resumed from their saved transcripts when the profile next opens in interactive Pi, and the main agent is told which.
- Headless `pi -p` doesn't resume them; they wait for the next interactive start.
- Ones you stopped or paused aren't resumed.

## Long subagent turns

Subagent transcripts aren't in the summary tree, so subagents use Pi's own compaction instead of the Turn refresh threshold, starting at about the same point.
