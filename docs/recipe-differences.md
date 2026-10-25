# How OptChat differs from the recipe

The README has the summary table. This page has the detail: what changed in each prompt, the numbers OptChat keeps, and how each addition behaves. `docs/victor-recipe.md` maps the recipe's sections to the source files.

## Prompts

`src/prompts.ts` holds every prompt sent to a model (the recipe's four, the subagent instruction paragraphs, the compaction task and its retry, the import note), each with a comment on where it goes. Tool descriptions stay with their tools. The recipe's prompts are lightly adapted:

- **Main agent.** The turn rules are the revised recipe's (2026-10-08) word for word, with three changes:
  - its paragraph on computers is left out;
  - reports start `[id] ` instead of `[Name]`;
  - two sentences are added: don't poll anything slow (CI, a deploy) yourself, hand the watching to a subagent; and a message starting `[OptChat status]` is OptChat's own note, not the user.
- **View doc.** Keeps the original's description of the view. It drops the "No message appears in full" line (untrue with Previous exchange on) and the list of when to zoom, adds one sentence on zooming out from a message to the summaries above it, and ends with the revised recipe's rule that the view is the truth and zoom the only way through it.
- **Compactor.** The revised recipe's intro, view and Compactions sections (with its closing note that compaction is a small, mechanical job to do fast with few tokens), without its turn-only sections, and with:
  - OptChat's kinds: `talk` for replies, subagent reports as `work`;
  - its value list reworded so the size limit is a ceiling rather than a target: bare approvals are recorded as the decision they made, lines don't narrate what wasn't seen yet, and a tool result is described by what its output shows rather than by a cause guessed from an exit code or an empty match. An A/B found less filler and no recall loss (#129).
- **Compaction task and "Too long" retry.** The recipe's, verbatim, with a 512-dash ruler for the size.
- **Compactor instructions.** Unlike the recipe, the compactor doesn't get your instructions: an A/B found they added nothing (#112).
- **Tool results.** A tool result's leaf summary also gets the raw tool call it answers, as a `<call>` block of context (#153 A/B: recall 3.88 → 4.22).
- **Subagent prompt.** The original's, plus a closing note on time: report progress on long tasks with `tell_parent`, and say so before waiting on something slow, so the main agent can go on.

## Numbers kept from the recipe

- 512-byte summary nodes. By default summaries up to 640 bytes are accepted without a retry, as long as they are smaller than what they replace (setting: Summary size tolerance).
- A memory view that grows a line per message and, past 128,000 bytes, merges in one batch down to 64,000. Between batches it only grows at its end, so each turn reads the last one's view from the cache. The view is saved and reloaded as it was.
- Binary merges, 8 compression workers by default (setting: Summaries at once), fixed retry delays, 5 shortening attempts, and a 30,000-character tool output cap. As in UniiChat, a node the model refuses keeps the first 512 bytes of its source instead (#193), and a summarizer is sent at most 100,000 characters of one message; zoom still pages through all of it.

## Compaction view and scheduling

Compactions get their own view, as in the 2026-10-08 revision: the memory view merged further, to between 16,000 and 32,000 bytes with the same sawtooth, ending at the line being built.

A message's summary starts once fewer than N lines before it are unsummarized, so up to N compactions run at once on one cached view (N is the **Summaries at once** setting, 8 by default). An import logs its messages the same way, waiting only while that many messages and due merges are unbuilt, so the merges keep up.

Where the recipe ends a compaction's view at the first line not summarized yet, OptChat shows that line as a placeholder and keeps the lines after it. Cutting there also hid the short lines that follow, such as an echo's own tool call, and an A/B on real turns scored those summaries lower (#101).

## Cache marks

Anthropic requests split the view into blocks of 4 lines, with cache marks on the last whole one and on the block 20 before it. The system prompt gets a mark too, as in the recipe, so a view written anew (a batch merge, a new session) writes only itself and reads the system prompt and tools from the cache. Anthropic looks back only 20 blocks from a mark, so with the recipe's one view mark a turn that added more than 80 lines (such as 40 tool calls and their results) made the next turn rewrite the whole view. With the extra mark, a turn that adds up to 160 lines still reads the last view from the cache. A compaction leaves its end unmarked, so its view gets a third mark 40 blocks back and reaches 240 lines. OpenAI requests get no marks (see `docs/victor-recipe.md`).

`OPTCHAT_CACHE_REPORT=1 npm test -- test/cache-replay.test.ts` replays a long chat against a fake Anthropic with a Pi-sized system prompt and prints what each kind of request read and wrote; it is how marks are compared.

When that view is not cached yet, one compactor call goes first and the others wait until it starts answering, so they read the cache instead of each writing it.

## Additions

Each run's context is the memory view, the previous exchange, and your new message. The additions that change the recipe's behaviour are settings (see [Settings](../README.md#settings)).

1. **Previous exchange kept verbatim.** Your last request (with any steering) and the final answer are included in full, so "why is that?" refers to what you actually read. Tool calls and reasoning are not carried over. It comes on top of the 128,000-byte view. If it is over 16,000 bytes (about 4,000 tokens, usually a big paste; setting: Previous exchange limit) it is left out entirely, and the model relies on the view and zoom as in Victor's recipe. A new Pi session starts with the memory view only.
2. **Subagents** are built in with Pi's SDK rather than a separate package. With Subagent levels above 1 they can delegate further. A spawn can set each task's model and thinking level when you ask for them.
3. **Memory search** (off by default). With the setting on, the agent also gets `search(text, before?)`: plain, case-insensitive text matching over the original messages, never the summaries (a summary can be wrong, and one fact repeats at every level of the tree), skipping logged zoom and search results. It returns 20 hits at a time, newest first, each with its id, the view line that holds it when that is a summary (`1234 (in 1024+256)`), its date and a snippet. `before: id` pages back, and `zoom(id, 1)` reads a hit. One line about it is added to the system prompt, and the rule that zoom is the only way through memory names search too. Turning it on or off changes the cached prompt once.
4. **Large messages.** `zoom(id, 1)` returns a message over 25,000 characters in pages, `[showing characters 0-25000 of 92000; next page: offset 25000]`, and `offset`/`limit` read any part of one (used on a shorter message, the page adds a note that it fits in one zoom). The recipe returns it whole, where the 30,000-character tool output cap cut out its middle.
5. **Turn refresh** (#146). Once the current turn's verbatim messages pass the Turn refresh threshold (30% by default), they move into memory and the turn goes on with a fresh window. 0% is off, as in the recipe. See "Long turns" in the README.
6. **Profiles**, the **inspector**, the **usage ledger**, **import**, **branches** and **peers** are additions (see the README for the last two). Import adds historical-record guidance to the prompts.
7. **Not done**: computer use and hosting on an always-on machine.
