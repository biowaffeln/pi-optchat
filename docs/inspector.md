# Inspector in detail

The README has the keys. This page covers what each page shows and the edge cases.

## Agents

Runs are listed as a tree with state, elapsed time, current tool, and last activity. Navigate with **Up/Down**, **Page Up/Down**, **Home/End**, and press **M** to pick the subagent model.

### Deleting an agent

Press **D** twice to delete the selected agent and the agents it started, with their transcripts.

- An agent that is still working is stopped first, and its stop report reaches its parent before it is deleted. The report tells the parent that you dropped the task, so it does not delegate it again.
- Deleting a finished agent sends no report, so memory logs `[id] deleted by the user` right away, without a model turn.
- The main agent can no longer resume a deleted agent.

### An agent's conversation

**Enter** swaps the screen to that agent's conversation, drawn with Pi's own chat components, so it reads like the main chat: its task, replies, and collapsed tool calls, following live output. Typing and **Enter** send it guidance. Guidance from the main agent and reports from the agent's own agents show in labelled boxes, so only your own messages look typed. **Escape** goes back to the main chat.

- **Ctrl+C** never ends the agent: queued messages go to it at once and it carries on; with none queued it waits for you (**interrupted · waiting for you**) until your next message, or a `tell` from the main agent, resumes it.
- When you interrupt an agent with nothing queued, the agent that started it gets a one-line note instead of a report, so it isn't left waiting.
- Guidance shows as queued until delivered, or undelivered if the child stops first. Guidance you send is also saved in main memory.
- Reasoning is not shown.
- Transcripts stay browsable after restart, and browsing them makes no model calls.

## Usage

Shows this session, last hour, today, last 7 days, or all time (**Left/Right**): one row per role and model (main agent, subagents, compactor, imports) with estimated cost, share of the total, output tokens, and how much input came from the cache.

- Costs are API-rate estimates, not your subscription bill. Unknown rates show zero.
- Record counts are not request counts; retries and tool overhead can add records.
- Main-agent tracking starts with v0.3.0 (resumed sessions are backfilled). Older records without a parent session are left out of **This session**.
- All views are limited to the active profile.

## Activity

A memory gauge: how many messages the profile holds and how much of the 128 KB view they fill, then either **Settled** or **Catching up · 12 of 40 summaries** with a progress bar counted from when the backlog last grew from empty.

- If summarizing keeps failing, the last error and the retry countdown show under it. A turn waiting for summaries shows the same error next to its spinner, usually a summarizer model you aren't logged in to (`/optchat model`).
- Once every summary a turn waits for has failed, the turn goes on, with "(not summarized yet: zoom it)" in place of the missing lines, and the failed summaries keep retrying in the background.
- A summary the model itself won't write (a refusal, an empty reply, or 5 replies cut off at the token limit) isn't retried: that line keeps the start of what it summarizes, after "(not summarized: zoom it)", and a warning names it once. Errors such as a dropped connection, a rate limit or a missing login keep retrying.
- It also counts running agents, and interrupted ones waiting for you; their list is on Agents.
- While summaries or agents are at work, the bar's Activity item gets a **●**.
