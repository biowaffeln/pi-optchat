# OptChat recipe reference

Author: Victor Taelin.

Source: https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449

The implementation was compared with the recipe fetched on 2026-10-04. The reference content SHA-256 was `8f6997e8944d85e4df53b5704bf7c4e393e4da361071181e9cc2f7d9d1b6e430`.

The source remains upstream rather than duplicating the full article here. Its prompt strings, from the original and the 2026-10-08 revision, are in `src/prompts.ts` with the small adaptations listed in `docs/recipe-differences.md`, and attribution in `THIRD_PARTY_NOTICES.md`.

## Implementation mapping

- `src/memory.ts`: append-only log, binary summary tree, compression scheduling (§4 of the 2026-10-08 revision: a message's summary starts once fewer than 8 lines before it are unbuilt, a merge once both halves are built, kept in a queue so the tree is never scanned for work), the compactions' own view (§4: the view merged further to 16,000-32,000 bytes, ending at the node; unlike the recipe, a line not built yet shows as a placeholder instead of ending it, so a summary still sees the built lines after it), the view (§3.2: the most due pair, measured from its last message, merges in one batch from 128,000 down to 64,000 bytes, and the view is saved to `view.json` rather than refolded at start), zoom/date, and the opt-in text search over original messages (`src/tools.ts` has the tool; not in the recipe, off by default).
- `src/compactor.ts`: contextual compression and size retries, with the 2026-10-08 revision's task (a 512-dash ruler for the size) and its "Too long" retry, verbatim. The compactions' view shows each line under its `id+n|` head, as the task's line ids need, so a reply that copies a head has it removed.
- `src/cache.ts`: Anthropic cache marks: the view in blocks of 4 lines, one mark on the last whole block and one at the request's end, as in recipe §3.3 (a compaction leaves its end unmarked, as Unii does: its task is never sent again), plus a mark on the system prompt (as the recipe has) and one 20 blocks before the last (a compaction, with its end unmarked, also gets one 40 before). Anthropic looks back only 20 blocks from a mark, so with the recipe's one view mark a turn that added more than 80 lines, such as 40 tool calls and their results, made the next turn rewrite the whole view. OpenAI requests get no marks: GPT-5.6 and GPT-6 Luna reject the recipe's `prompt_cache_breakpoint` with a 400 (found by @aaaxn), so they rely on implicit prefix caching. OptChat doesn't set `reasoning.context` either: GPT-5.6 already defaults to the recipe's `"all_turns"`, and OpenAI documents it only for GPT-5.6 and GPT-6.1 Sol.
- `src/transcript.ts`: fresh context per parent run, current-run tool loop retained. The previous completed exchange is also retained in full text (left out if over 16,000 bytes by default), an intentional addition to the summary-only recipe for conversational continuity.
- `src/agents.ts`: asynchronous Pi SDK children and automatic completion reports.
- `src/settings.ts`: per-profile settings for the departures from the recipe. Defaults are the recipe's (no memory search), except the previous exchange (on), the summary size tolerance (640 bytes, against the recipe's strict 512) and the turn refresh threshold (30%, where the recipe has none). Grouped subagent reports are off by default, as in the revised recipe, which reports each subagent on its own.
- `src/import/`: profile-scoped historical imports retain user messages and final assistant replies, following the lighter history described in recipe section 10. An import hands `Memory` one message at a time, each once the one before it is summarized, so the compactor sees the view a live chat would have shown it. Source adapters, final-reply detection, replay filtering, and ChatGPT branch labels are integration choices. Live-chat tool logging remains unchanged.

Profiles, native Pi UI, conversation import, and local Git checkpoints are integration choices described in the README.
