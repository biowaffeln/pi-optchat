# Several sessions on one profile: trunk and branches

The recipe has one chat with one writer. This fork lets you keep several Pi sessions open on one profile at once (one per project, say) without a main window and subagent windows. Each session is a normal OptChat chat; they share what they say through the profile's memory, which is merged, never interleaved.

## The model

- **The trunk** is the profile's memory as before: `main/`, `tree/` and `view.json` in the profile folder (or the active import generation). Nobody chats in it directly. It only grows, by merges.
- **A branch** is one Pi session. It starts at the trunk's end: its first messages are the trunk's (same ids, same nodes, same view), and it logs its own after them in `branches/<id>/`. It has one writer, its own process, so inside it the chat, its tree, the sawtooth view and the cache work exactly as in the recipe. A new session's first view is the trunk's view, byte for byte.
- **A merge** appends the branch's new messages to the trunk's end, as one block, keeping their dates (so `date()` still tells when something was said) and tagging each with the branch and its index there. The trunk's order is the order things became shared, not wall-clock order.

```text
trunk  0 ─────────── 120 │ a's 120-180 │ note │ b's 120-150 │ ...
                      ├── branch a (opened at 120, closed first)
                      └── branch b (opened at 120, closed second: moved after a, with a note saying so)
```

## When a branch merges

- **On close** (Pi exits, `/new`, `/resume`, switching profile).
- **When idle**: after the profile's **Merge when idle** time (30 minutes by default; 0 turns it off) with nothing new in its log, so sessions you leave open still share what they said. It keeps running.
- **When its view batch-merges** while another session has merged since it started (a **rebase**). The batch rewrites the view, so its cached prefix is gone anyway: the branch merges and starts again from the trunk's end, keeping its id. From then on it sees what the other sessions said. A branch that never batch-merges only sees others' merges in sessions started after them.
- **After a crash**: a branch whose Pi died is merged the next time any Pi opens the profile, with the inputs and reports it journaled but never logged, and a note that it ended without closing.

## What a merge keeps and rebuilds

A summary node covers a fixed range of ids, so a node stays valid where its messages keep their ids, or all moved by a multiple of the node's size (then it just gets new indices). The merge copies every such node into the trunk.

- **Nothing else merged since the branch started**: every message keeps its id, so the trunk takes all of the branch's nodes as they are and needs nothing rebuilt. This is the usual case with one session at a time, and then the trunk is exactly the old single-chat memory.
- **Another branch merged first**: the block moves. Every leaf moves with its message (a leaf covers one message), and higher nodes keep only when the shift happens to be a multiple of their size; the merges above are rebuilt, about one compactor call per merged message. A one-line note goes before the block saying which session it is, where it ran, and when.

Nothing is summarized during the merge itself, which is a few file appends under a lock. Missing nodes are built by the first branch whose view needs them (a new session, or a rebase), as part of its normal compaction, and go back to the trunk with that branch's next merge.

## Locks

All locks are sockets (named pipes on Windows), so the OS lets go of one when its process dies; nobody waits on a stale lock file.

- `trunk.sock` in the profile: held for one read of, or append to, the trunk's files. Never across a model call.
- `branches/<id>/live.sock`: held by a branch's process while it runs. A branch whose socket answers is open; one whose socket doesn't and that isn't marked closed crashed.
- `checkpoint.sock`: sessions take turns committing the profile's Git checkpoint; one that finds another committing skips its turn.

An older OptChat (before branches) holds `lock.sock`; this one refuses to open a profile while that answers, since the older one expects to be the only writer.

## Files

| Path | Contents |
| --- | --- |
| `branches/<id>/branch.json` | Where the branch started (`base`), its cwd, PID and host; `closed` once it merged for good |
| `branches/<id>/main/`, `tree/`, `view.json` | Its own messages, nodes and view |
| `branches/<id>/pending-inputs.json`, `pending-reports.json` | Its recovery journals |
| `branches/<id>/runs/` | Its subagents' sessions. They belong to the session that started them; when it closes, the next session to open takes them over, and resumes the ones it cut off |
| `branches/<id>/rebased/<base>/` | Its log before a rebase, kept aside; everything in it is in the trunk |

A closed branch's folder stays, since it holds its subagents' transcripts; `zoom("<run id>")` finds a run in any branch of the profile. Deleting a closed branch's folder loses only those transcripts.

## Peers

Sessions don't share memory while they run, but they can see each other:

- `peers()` lists the other open sessions: id, working directory, whether they work, and their latest lines (the view's, then the running turn's). Each session's lock answers with that status, so a crashed session never shows up.
- `ask_peer(id, question)` has the profile's compactor model answer from that session's published view (`view.txt`, rewritten after each turn) and its turn in progress (`turn.txt`, up to 16 KB of short lines). The session itself isn't interrupted and never sees the question. It costs one cheap call that reads the view, cached for a few minutes.
- `note_peer(id, text)` leaves at most 280 bytes in the session's `notes.jsonl`. It never starts a turn there: it goes at the end of the next plain message the user sends that session (not a `/` command or a message queued while it works, which would carry it into a skill's arguments or lose it on Esc), as `[note from <id> (<cwd>)] ...`, and is logged with it. A closing session stops taking notes. One note per session per turn, and there is no reply tool. The sender's log has the tool call; the receiver's has the note. A note that no input carried goes into the receiver's memory when it closes (or is recovered after a crash).

## Limits and costs

- A branch doesn't see its siblings until it rebases or a new session starts after they merge.
- Every new session writes its view to the cache once (about 16-32K tokens): the system prompt and tools are cached across sessions, the view isn't.
- A merge that moved costs about one compactor call per message to rebuild the merges above it, paid by the next session that needs them.
- Subagents belong to their session: while it is open, others can read their transcripts but not `tell` them.
- An import needs every other session on the profile closed.
