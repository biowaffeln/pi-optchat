# Storage

Profile data lives in `~/.optchat/profiles/<name>/` (override the root with `OPTCHAT_HOME`). The README has the table of what each path holds; [branches.md](branches.md) covers the trunk and the per-session `branches/` folders.

## Git checkpoints

Each profile folder is a local Git repository, committed after each turn (memory and config; not runs, HTML, or usage). It has no remote, so it is not a backup. To back up, copy the folder while Pi is closed.

## Import generations

An import builds a new memory generation (`memories/<id>/`) and switches `active-memory.json` to it only when the whole tree is ready. Older generations are kept.

## The `Store` seam

Memory reaches disk through one seam, `Store` in `src/store.ts`: the log, summary nodes, saved view and images, which is what would travel between machines. The saved view (`view.json`) holds the chat's view and the compactions' view, each with its batch state; an older one without the compactions' view refolds it from the chat's, once.

- Runs, recovery journals, imports and their pointer, usage, settings and `AGENTS.md` stay local files.
- `FileStore` (the layout in the README) is the only store today. Another, such as Postgres, would implement the same few operations.
- Locking lives outside it: sessions are branches with their own folders, and the trunk is changed only under a machine-local lock (see [branches.md](branches.md#locks)). A store on another machine would need its own lock for the trunk.
- Import records (`imports/*.json`, the staging generations and the `active-memory.json` pointer) are per machine, so a second machine with the same `~/.claude` or Codex history on disk may offer those sessions for import again.

## Windows differences

- **Named pipes, not socket files.** The trunk, checkpoint and branch locks listen on `\\.\pipe\optchat-<hash>-<name>`, where the hash comes from the folder's path: a Windows pipe has no filesystem entry inside the profile, so the hash is the only thing separating profiles. Pipes are machine-wide and carry no file permissions, so a Windows profile is not permission-protected the way a POSIX socket file (mode 0600) is.
- **File modes and fsync** (profile folder 0700, socket 0600, directory fsync after a rename) are POSIX-only and are skipped on Windows.
