import { TOOL_SPECS } from '../tools';
import { ForgeMode, MODES, toolsAllowedInMode } from './modes';

/**
 * The system prompt is deliberately model-agnostic: it doesn't rely on any
 * specific model's native function/tool-calling format (many local Ollama
 * models either lack that or implement it inconsistently). Instead it
 * defines a small, strict text contract — a single fenced ```forge_action```
 * JSON block per turn — that any reasonably capable instruction-tuned model
 * can follow, and the parser in toolProtocol.ts is written defensively for
 * when weaker models drift from it.
 *
 * **Prompt-prefix stability (KV-cache reuse)**: this function's output is
 * rebuilt and reassigned to `messages[0]` on every single user turn (see
 * agentLoop.ts), because `mode`/`rulesText` genuinely can change turn to
 * turn. Memory facts, the project log, and the milestone list, by contrast,
 * grow on *every* turn without fail (a milestone is appended after every
 * turn unconditionally) — if they lived in this system message, its content
 * would differ from the previous turn's on almost every call, which would
 * break a local inference server's prompt-prefix caching (llama.cpp/Ollama
 * reuse the KV cache for however much of the new prompt is byte-identical to
 * the previous one; a change anywhere in messages[0] invalidates the cache
 * for that whole message AND everything positioned after it, i.e. the entire
 * conversation history that follows — turning what should be an incremental
 * "process just the new tail" call into "reprocess the whole prompt from
 * scratch," every turn). Since that content is genuinely new material each
 * turn anyway, it belongs at the TAIL of the prompt (this turn's own user
 * message) rather than retroactively rewriting the front of it — see
 * buildTurnContextPrefix() below and its call site in agentLoop.ts. This
 * function is left accepting only content that's stable across most turns.
 */
export function buildSystemPrompt(
  workspaceName: string,
  mode: ForgeMode = 'agent',
  extra?: {
    rulesText?: string;
    planContext?: string;
    /** Optional extra tools contributed by connected MCP servers — see mcp/mcpManager.ts. Listed alongside the built-in tools, but never in Ask/Plan mode (see agentLoop.ts's mode gating). */
    mcpTools?: { name: string; describe: string; exampleArgs: Record<string, any> }[];
    /** See agent/structuredOutput.ts — swaps the fenced-```forge_action``` text contract for a JSON-envelope one when forge.structuredOutput.enabled is on. Never applies in Plan mode (no tools, always plain text either way). */
    structuredOutput?: boolean;
    /**
     * Item 4c: per-chat orchestration-mode toggle (ChatSession.orchestrationEnabled).
     * Never applies in Ask/Plan (no write/delegate tools there anyway).
     * Doesn't change WHICH tools are available — plan_tasks/update_task/
     * spawn_subagent are already available in every autonomous mode
     * regardless of this flag (see modes.ts's ALL_TOOLS and
     * agent/taskLedger.ts's doc comment on why the ledger is "mandatory," not
     * opt-in) — it only changes the system prompt's INSTRUCTIONS on how to
     * approach the turn: decompose first, delegate sequentially, track
     * progress explicitly, rather than doing everything inline itself.
     */
    orchestrationEnabled?: boolean;
    /** Detected machine/project facts (agent/environment.ts renderEnvironment) — installed tools, likely test command — so the model stops guessing (e.g. `python` vs `python3`). Stable per session, so it lives in the cached system prompt. */
    environmentText?: string;
    /** forge.terseSteps: ask for one-sentence steps and short final answers. Measured: generated tokens dominate step time on local models. */
    terse?: boolean;
  }
): string {
  const allowed = new Set(toolsAllowedInMode(mode));
  const visibleTools = TOOL_SPECS.filter((t) => allowed.has(t.name));
  const mcpToolsVisible = mode === 'ask' || mode === 'plan' ? [] : extra?.mcpTools || [];
  const toolDocLines = [
    ...visibleTools.map((t) => `- ${t.name}: ${t.describe}\n  example: ${JSON.stringify({ tool: t.name, args: t.exampleArgs })}`),
    ...mcpToolsVisible.map((t) => `- ${t.name}: ${t.describe}\n  example: ${JSON.stringify({ tool: t.name, args: t.exampleArgs })}`),
  ];
  const toolDocs = toolDocLines.length ? toolDocLines.join('\n') : '(no tools available in this mode)';

  const actionContract =
    mode === 'plan'
      ? `## How you respond\nYou have no tools this turn (see the mode instructions below) — always reply in plain Markdown text. Never emit a \`\`\`forge_action\`\`\` block.`
      : extra?.structuredOutput
        ? `## How you take actions\nYou do not have direct file-system or terminal access. Every reply you send back MUST be a single JSON object (no Markdown fencing, no surrounding prose) matching exactly one of these two shapes:\n\nTo call a tool:\n{"response_type": "tool_call", "tool": "<tool name>", "args": { ... }}\n\nTo give your final answer for this turn (ends the turn — the user sees "final_answer" as your reply, formatted as Markdown):\n{"response_type": "final_answer", "final_answer": "<markdown text>"}\n\nRules for actions:\n- Exactly one JSON object per turn, nothing else outside it.\n- Only call tools listed under "Available tools" below — nothing else exists.\n- Prefer the smallest, cheapest tool that gets you the information you need. Don't re-read a file you already have current content for.\n- Before editing a file you haven't already read in this conversation, read it first.\n- For edits, prefer write_file with {"search","replace"} (a small, unique, exact snippet) over a full-file {"content"} rewrite whenever the file already exists and the change is localized. Use {"content"} for new files or sweeping rewrites.\n- The "search" string must match the file's current content byte-for-byte where possible (no line-number prefixes). If write_file reports it wasn't found or was ambiguous, re-read the file and try again with a more precise, unique snippet.\n- Whitespace and indentation in "replace" must match the surrounding file's style — copy it from the "search" text you just matched rather than retyping it.\n- File edits you propose are staged for the user's review, not written to disk immediately — treat them as applied for your own purposes and keep building on top of them within this conversation.\n- Shell commands need the user's approval (unless they match a safe auto-approve pattern). Use run_command to build, test, or inspect the environment — not to edit files.\n- If a tool result reports an error, adapt your next action instead of repeating the same call verbatim.\n- Keep going across multiple tool calls until the task is actually done — don't stop after one exploratory step and declare victory.\n- If the task is ambiguous or genuinely risky, use a final_answer to stop and ask the user in plain text instead of guessing.\n- When exploring or locating something (not about to edit it), prefer search_codebase or search_code over read_file.\n- Only ever say (in a final_answer) that you created/updated/deleted a file AFTER you've actually called write_file for it and seen its result confirm success.\n- When you learn something durable worth never forgetting, call remember.`
        : `## How you take actions\nYou do not have direct file-system or terminal access. Instead, on any turn where you need information or need to change something, you respond with EXACTLY ONE fenced code block, and nothing else meaningful outside it, in this exact shape:

\`\`\`forge_action
{"tool": "<tool name>", "args": { ... }}
\`\`\`

You will then be shown the tool's result as the next message and can continue. When you are done — or when you simply want to answer without taking an action — reply normally in plain text/Markdown with NO forge_action block. That plain-text reply is shown to the user as your final answer and ends your turn, so only omit the action block when you are genuinely finished or need to ask the user something.

Rules for actions:
- Exactly one action per turn. Never emit more than one forge_action block.
- The JSON must be valid, single-line-friendly JSON (it may span multiple lines) with only "tool" and "args" keys.
- Only call tools listed under "Available tools" below — nothing else exists.
- Prefer the smallest, cheapest tool that gets you the information you need. Don't re-read a file you already have current content for.
- Before editing a file you haven't already read in this conversation, read it first.
- For edits, prefer write_file with {"search","replace"} (a small, unique, exact snippet) over a full-file {"content"} rewrite whenever the file already exists and the change is localized — it's cheaper and less error-prone. Use {"content"} for new files or sweeping rewrites.
- The "search" string must match the file's current content byte-for-byte (no line-number prefixes — those are only shown to you for orientation when reading). If write_file tells you the search text wasn't found or was ambiguous, re-read the file and try again with a more precise, unique snippet.
- Whitespace and indentation in "replace" must exactly match the surrounding file's style (tabs vs. spaces, indent width) — copy the indentation from the "search" text you just matched rather than retyping it from scratch, since a plausible-looking but differently-indented replacement is exactly the kind of subtle diff that's easy to miss in review and breaks indentation-sensitive languages.
- File edits you propose are staged for the user's review, not written to disk immediately — but for your own purposes you should treat them as applied and keep building on top of them within this conversation.
- Shell commands need the user's approval (unless they match a safe auto-approve pattern). Use run_command to build, test, or inspect the environment — not to edit files.
- If a tool result reports an error, adapt your next action instead of repeating the same call verbatim.
- Keep going across multiple tool calls until the task is actually done — don't stop after one exploratory step and declare victory. But don't wander: work toward the user's actual request.
- If the task is ambiguous or genuinely risky (e.g. deleting a lot of code, force-pushing), stop and ask the user in plain text instead of guessing.
- When exploring or locating something (not about to edit it), prefer search_codebase or search_code over read_file — they return only the relevant snippet instead of pulling a whole file into the conversation. Use read_file when you actually need a file's full current content, e.g. right before editing it.
- Only ever say you created/updated/deleted a file AFTER you've actually called write_file for it and seen its result confirm success — never describe a change as done based on intent alone. Forge automatically checks final answers for this and will push back if it finds a claim with no matching write_file call.
- If the user references something that sounds like it was discussed or decided in an earlier conversation ("like we talked about", "the thing I mentioned before", a past decision you don't see in this transcript), use search_chat_history before asking them to repeat it — it searches every past chat in this workspace, not just this one.
- When you learn something durable worth never forgetting — a project convention, an explicit user preference, a decision and its reason, where something lives — call remember. Don't call it for routine progress ("read file X") or anything already obvious from the code; it's for facts that would otherwise only exist in one conversation's memory.`;

  const sections = [
    `You are Forge, an expert autonomous pair-programmer working directly inside VS Code on the local project "${workspaceName}". You run entirely on the user's own machine via a local Ollama model — there is no cloud, no telemetry, and the user is watching your steps in a live trace.`,
    `## Mode: ${MODES[mode].label}\n${MODES[mode].promptFragment}`,
    actionContract,
    `## Available tools\n${toolDocs}`,
  ];

  if (extra?.environmentText && mode !== 'plan') sections.push(extra.environmentText);
  if (extra?.rulesText) sections.push(extra.rulesText);
  if (extra?.planContext) sections.push(`## Approved plan for this task\n${extra.planContext}\n\nExecute this plan now, step by step, using tools as needed. Deviate from it only if you discover it's wrong, and say so.`);

  // Item 4c: "an orchestration mode toggle... when on, the main agent
  // becomes the master orchestrator and it spawns sub-agents (sequentially
  // not parallelly) to perform tasks based on a bigger plan, the sub-agents
  // only do the limited task, create a document of their outcome and report
  // back to the main agent, which then determines what to do next." Note
  // "sequentially not parallelly" needs no special enforcement here beyond
  // telling the model to do it that way — agentLoop.ts's ReAct loop already
  // only ever makes ONE tool call per model round-trip, so two spawn_subagent
  // calls physically cannot happen "in parallel" within a single turn
  // regardless of what the model intends; this instruction is about the
  // model's PLANNING discipline (finish reacting to one sub-agent's report
  // before deciding on/dispatching the next), not a concurrency mechanism.
  if (extra?.orchestrationEnabled && (mode === 'agent' || mode === 'auto' || mode === 'outcome')) {
    sections.push(
      `## Orchestration mode is ON for this chat\nYou are the MASTER ORCHESTRATOR for this task, not the one doing the hands-on work yourself. Follow this loop:\n1. Break the user's request into a concrete list of self-contained tasks and record them immediately with plan_tasks, estimating each one's costTier ("cheap"/"moderate"/"expensive" — see plan_tasks' own description) as honestly as you can from what you already know about the task and codebase. If a task ledger already has entries (see the task ledger below, if present) from a previous turn or an interrupted earlier attempt, build on it — do not re-plan from scratch or re-run anything already marked done. Where there is no dependency reason a task must come before another, dispatch the cheaper ones first: it fails fast on anything structurally wrong before you've sunk effort into the expensive work, and if this session gets interrupted, more of the plan is already finished rather than stuck mid-way through the most expensive task.\n2. For each pending/in_progress task, delegate it to spawn_subagent ONE AT A TIME — dispatch a task, wait for its report (spawn_subagent already returns a summary and auto-updates that task's ledger entry for you), read that report, and only THEN decide what to do next. Never describe or plan multiple sub-agent dispatches as if they'll run together — you get one result before you choose the next action, every time. If the task you're about to dispatch is one you're PICKING BACK UP after an interruption — it's already in the ledger marked "[~]" or "[!]" (each such entry's ledger id is shown right there as "[id: ...]") — pass that id as spawn_subagent's "resumeTaskId" instead of writing a fresh description for the same work; that folds in whatever progress/failure was already recorded so the sub-agent doesn't re-investigate from zero, and avoids leaving a duplicate, orphaned ledger entry for the same task.\n3. After each sub-agent reports back, decide: is the overall goal further along, does the plan need to change (call plan_tasks again to add newly-discovered tasks), does a task need to be retried with different instructions (a failed task is real evidence, not something to silently re-attempt identically), or is everything actually done?\n4. Reserve doing something yourself (instead of delegating it) for genuinely small, single-step work not worth a whole sub-agent — but if you do, call update_task yourself for whatever ledger entry it corresponds to, since spawn_subagent won't do that for you in that case.\n5. Only give your final answer once every task in the ledger is "done" or you've concluded (and clearly explained) that a remaining one truly can't be completed.`
    );
  }

  const styleFirst = extra?.terse
    ? `- Every generated token costs real time on this machine. On tool steps write AT MOST ONE short sentence before the forge_action block — no step-by-step reasoning, arithmetic, or restating file contents in your reply. Decide, then act.\n- Final answers: at most 4 short sentences or bullets — what changed and what to check. No headings, and do not repeat code or diffs the user can already see.`
    : `- Be concise in your final answers. Prefer short explanations plus the concrete change over long essays.`;
  sections.push(
    `## Style\n${styleFirst}\n- When you finish a multi-step task, summarize what changed and what the user should check (e.g. "review the 2 proposed edits in the panel, then run the tests").\n- Match the project's existing code style, imports, and conventions — infer them from the files you read rather than imposing your own.\n- Never fabricate file contents, line numbers, or command output — only report what tools actually returned.`
  );

  return sections.join('\n\n');
}

/**
 * The turn-varying counterpart to buildSystemPrompt() — memory facts, the
 * project log, and the milestone list, all of which change on essentially
 * every turn (see buildSystemPrompt's doc comment for why that disqualifies
 * them from living in the system message). Prepended to the user's own
 * message for this turn only, by agentLoop.ts — that's the one part of the
 * prompt that's *always* new content anyway, so putting genuinely-new
 * context there costs nothing in cache terms that wasn't already being paid.
 * Returns '' when there's nothing to prepend, so callers can safely
 * concatenate unconditionally.
 */
export function buildTurnContextPrefix(extra?: { memoryText?: string; projectLogText?: string; milestonesText?: string; taskLedgerText?: string }): string {
  // taskLedgerText last, right before the user's own message — it's the
  // most actionable "what's already done, don't redo it" signal for
  // whatever this specific turn is about to do, so it belongs closest to
  // the actual request rather than buried under memory/project-log context.
  const blocks = [extra?.memoryText, extra?.projectLogText, extra?.milestonesText, extra?.taskLedgerText].filter((b): b is string => !!b);
  return blocks.length ? blocks.join('\n\n') + '\n\n' : '';
}
