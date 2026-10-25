# Subagents in detail

The README covers the basics. This page has the rest.

## What a child gets

- The profile's memory view (frozen at launch), its instructions, read-only `zoom`/`date`, and normal coding tools plus your installed extensions (except pi-optchat itself). A task with `memory: false` gets no view and no `zoom`/`date` (see [Memory](#memory)).
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

## Roles

A task's `role` presets its model, thinking, tools and memory in one go. The main agent's instructions list every role with its description and what it sets, and the agent may pick one whenever it fits the task, without being asked; it still sets `model` or `thinking` by hand only when you ask.

Built in, used when the profile's `config.json` has no `roles`:

| Role | Model | Thinking | Tools | Memory | For |
| --- | --- | --- | --- | --- | --- |
| `scout` | `openai-codex/gpt-6-luna` | low | read-only | off | Fast recon: finding files, tracing symbols |
| `implementer` | subagent model | subagent level | all | on | Executing a well-specified brief |
| `reviewer` | `anthropic/claude-opus-5-5` | high | read-only | on | Reviewing diffs and modules for bugs and risky assumptions |
| `elder` | `anthropic/claude-opus-5-5` | xhigh | read-only | on | The hardest reasoning, debugging that resisted earlier attempts |

- A `roles` object in `config.json` replaces this list as a whole (an empty object means no roles). Each entry is `{ "description": ..., "model"?: "provider/id", "thinking"?: ..., "tools"?: "all" | "readonly", "memory"?: boolean }`; names are lowercase letters, digits, `-` and `_`. A bad entry makes the profile refuse to open, with a message naming it. Edits apply after `/reload`.
- Precedence, per field: what the task sets, then the role, then the profile (subagent model and level, all tools, memory on).
- A role's model must be one Pi is logged in to. If it isn't, the whole spawn fails before any child starts, naming the task and the role; it never falls back to another model. Naming a `model` on the task gets around it.
- A role is saved with the run and shown in the agent view's header, next to the model.

## Read-only

`tools: "readonly"` leaves Pi's `edit` and `write` tools out of the child and turns on `read`, `grep`, `find` and `ls`. The child is told it is read-only and should report what to change instead.

What it does not stop:

- **Bash stays**, so a read-only child can still change files with `echo >`, `sed -i`, `git commit` and so on. There is no command filter. Treat read-only as a strong hint that also removes the obvious tools, not as a sandbox.
- **Extension tools stay.** Pi has no way to tell which extension tools change files, so ones that do (an AST rewrite tool, say) remain available.
- The children of a read-only child are always read-only, whatever their task says.

## Memory

`memory: false` gives the child only its task text, plus the usual AGENTS.md files and skills. It gets no memory view, no `zoom`/`date` (so it can't read its own children's chats with `zoom` either) and no `search`, and its opening prompt says the task is all the context it has. Use it for self-contained briefs; it saves the view's tokens and keeps the child from being steered by the chat.

## Worktrees

`isolation: "worktree"` gives the child its own git worktree:

- The task's directory must be inside a git repository with at least one commit; otherwise the whole spawn fails before any child starts.
- OptChat runs `git worktree add -b optchat/<id> ~/.optchat/worktrees/<id> HEAD` in that repository (under `OPTCHAT_HOME` if set), and the child starts in the matching directory inside it (a task in `repo/sub` starts in `<worktree>/sub`). It is told its branch and not to push, merge or switch branches.
- When the run settles (finished, failed, or stopped by you), OptChat stages everything (`git add -A`, so gitignored files stay out), commits what is uncommitted on the branch (with `--no-verify`, and as `OptChat <optchat@localhost>` if the repository has no identity), and removes the worktree. If the branch has any commit past its starting point (the child's own commits count), it is kept and the report ends with its name and commit count. Otherwise the branch is deleted too.
- If the cleanup fails (a git error), the worktree is left as it is and the report says where.
- If Pi closes, crashes or reloads while the child works, nothing is cleaned up: the worktree, uncommitted changes and all, stays, and the child resumes in it at the next start.
- `tell` to a finished isolated child brings its worktree back on the same branch (or from its starting commit, if the branch was deleted), and cleans up again when it settles.
- Deleting a run in the inspector doesn't delete its branch. Merge or delete `optchat/<id>` branches yourself.
- The worktree path and branch are saved with the run and shown in the agent view's header.

## Reports

Each child reports to its parent as soon as it finishes, as one message starting `[id]`. The parent stays alive to receive reports; it never polls.

- A failed child reports its error text.
- A child whose request aborts with no stop (a provider abort) still reports `Task aborted: ...`.
- A stopped child's report says who stopped it (you, the agent that started it, or Pi closing while it was paused) and that `tell` resumes it, followed by its last message when it has one.

### Grouped reports

Turn **Group subagent reports** on to have the children of one spawn report together: when the last of them finishes, their reports reach the parent as one message, `[id] report` each, in spawn order.

- Each finished report is journaled right away, so if Pi dies before the rest finish, the reports it already has are delivered at the next start.
- Messages sent with `tell_parent` are never held back.
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

`tell` to a finished child resumes it: the same agent (ID, parent, model, directory, role, tools, memory and worktree) reopens its saved transcript, gets the message as a new prompt, and sends a new report.

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
