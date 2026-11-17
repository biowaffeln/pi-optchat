# Changelog

Pi shows the entries newer than the version you last saw on its next launch after an update.

## [0.11.4] - 2026-11-17

First release on npm, as `@biowaffeln/pi-optchat`. If you installed from git, switch with
`pi remove git:github.com/biowaffeln/pi-optchat@v0.11.3` and `pi install npm:@biowaffeln/pi-optchat`.

Ported from upstream [jonaslsaa/pi-optchat](https://github.com/jonaslsaa/pi-optchat):

- The compactor asks again when the model replies with no text at all, instead of failing the summary (#292).
- The memory prompt says that newer statements replace older ones, and that a tool can show a newer state than the chat (#280).
- The compactor sees the images in a message, so summaries can say what a screenshot shows (#284). Each image costs a little on the compactor's model.
- Subagent tasks can carry a short title. The Agents page, the status line and reports (`[id · title]`) show it, and worktree commits use it (#243).
- OptChat keeps working when a Pi RPC host switches sessions (#258).

Fixes:

- When another session binds over an open one, the old session's branch is closed and merged first instead of being left open.
- Subagents still skip loading a second copy of OptChat under the new package name.
