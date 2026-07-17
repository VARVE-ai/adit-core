import { describe, expect, it } from "vitest";
import {
  classifyPromptSubmit,
  extractObservedUserRequest,
  isClaudeMemObserverPrompt,
} from "./system-prompt.js";

const CLAUDE_MEM_PROMPT = `Context: This summary will be shown in a list to help users and Claude choose which conversations are relevant.

Please write a concise summary of this part of a conversation in 2-3 sentences. What happened, what was built/discussed. Use <summary></summary> tags.

User: Hello memory agent, you are continuing to observe the primary Claude session.

<observed_from_primary_session>
  <user_request>Fix the auth bug</user_request>
  <requested_at>2026-06-08</requested_at>
</observed_from_primary_session>

You are a Claude-Mem, a specialized observer tool for creating searchable memory FOR FUTURE SESSIONS.`;

const CLAUDE_MEM_SUMMARY_PROMPT = `Context: This summary will be shown in a list to help users and Claude choose which conversations are relevant.

Please write a concise, factual summary that synthesizes these part-summaries into one cohesive paragraph. Output in <summary></summary> tags. Claude will see this summary when searching previous conversations for useful memories and information.

Part summaries:
1. Primary session implemented a bugfix.`;

describe("system prompt classification", () => {
  it("classifies ordinary user prompts as user", () => {
    expect(classifyPromptSubmit("Fix the bug")?.kind).toBe("user");
  });

  it("classifies task notifications", () => {
    const result = classifyPromptSubmit("<task-notification>Task done</task-notification>");

    expect(result?.kind).toBe("task-notification");
    expect(result?.originalLength).toBeGreaterThan(0);
    expect(result?.originalHash).toHaveLength(64);
  });

  it("classifies Claude-Mem observer prompts and extracts the observed user request", () => {
    const result = classifyPromptSubmit(CLAUDE_MEM_PROMPT);

    expect(result?.kind).toBe("claude-mem-observer");
    expect(result?.observedUserRequest).toBe("Fix the auth bug");
    expect(extractObservedUserRequest(CLAUDE_MEM_PROMPT)).toBe("Fix the auth bug");
  });

  it("classifies Claude-Mem summary synthesis prompts", () => {
    expect(isClaudeMemObserverPrompt(CLAUDE_MEM_SUMMARY_PROMPT)).toBe(true);
    expect(classifyPromptSubmit(CLAUDE_MEM_SUMMARY_PROMPT)?.kind).toBe("claude-mem-observer");
  });

  it("does not classify plain summary prompts without memory markers as Claude-Mem", () => {
    const prompt = `Context: This summary will be shown in a list to help users and Claude choose which conversations are relevant.

Please summarize this document for me.`;

    expect(classifyPromptSubmit(prompt)?.kind).toBe("user");
  });

  it("classifies prompt-submit events with agent IDs as subagent prompts", () => {
    expect(classifyPromptSubmit("Explore this file", { agentId: "agent-1" })?.kind)
      .toBe("subagent-prompt");
  });
});
