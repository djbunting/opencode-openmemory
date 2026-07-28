import { openMemoryClient } from "./client.js";
import { log } from "./logger.js";
import { CONFIG } from "../config.js";
import type { MemoryScopeContext } from "../types/index.js";

interface MessageInfo {
  id: string;
  role: string;
  sessionID: string;
  summary?: boolean;
  finish?: boolean;
}

interface MessagePart {
  type: string;
  text?: string;
}

function createCompactionPrompt(projectMemories: string[]): string {
  const memoriesSection = projectMemories.length > 0
    ? `
## Project Knowledge (from OpenMemory)
The following project-specific knowledge should be preserved and referenced in the summary:
${projectMemories.map(m => `- ${m}`).join('\n')}
`
    : '';

  return `[COMPACTION CONTEXT INJECTION]

When summarizing this session, you MUST include the following sections in your summary:

## 1. User Requests (As-Is)
- List all original user requests exactly as they were stated
- Preserve the user's exact wording and intent

## 2. Final Goal
- What the user ultimately wanted to achieve
- The end result or deliverable expected

## 3. Work Completed
- What has been done so far
- Files created/modified
- Features implemented
- Problems solved

## 4. Remaining Tasks
- What still needs to be done
- Pending items from the original request
- Follow-up tasks identified during the work

## 5. MUST NOT Do (Critical Constraints)
- Things that were explicitly forbidden
- Approaches that failed and should not be retried
- User's explicit restrictions or preferences
- Anti-patterns identified during the session
${memoriesSection}
This context is critical for maintaining continuity after compaction.
`;
}

export interface CompactionContext {
  directory: string;
  client: {
    session: {
      messages: (params: {
        path: { id: string };
        query: { directory: string };
      }) => Promise<{ data?: Array<{ info: MessageInfo; parts?: MessagePart[] }> }>;
    };
  };
}

export function createCompactionHook(
  ctx: CompactionContext,
  scopes: { user: MemoryScopeContext; project: MemoryScopeContext }
) {
  // Summary messages we have already persisted, so repeated `message.updated`
  // events for the same message don't create duplicate memories. Bounded so
  // a long-lived server process doesn't accumulate ids forever; compactions
  // are rare, and re-saving one evicted long ago is harmless.
  const savedSummaryMessages = new Set<string>();
  const MAX_TRACKED_SUMMARIES = 256;

  function rememberSummary(messageId: string): void {
    if (savedSummaryMessages.size >= MAX_TRACKED_SUMMARIES) {
      const oldest = savedSummaryMessages.values().next().value;
      if (oldest !== undefined) savedSummaryMessages.delete(oldest);
    }
    savedSummaryMessages.add(messageId);
  }

  async function fetchProjectMemoriesForCompaction(): Promise<string[]> {
    try {
      const result = await openMemoryClient.listMemories(scopes.project, { limit: CONFIG.maxProjectMemories });
      const memories = result.memories || [];
      return memories.map((m) => m.content || "").filter(Boolean);
    } catch (err) {
      log("[compaction] failed to fetch project memories", { error: String(err) });
      return [];
    }
  }

  async function saveSummaryAsMemory(sessionID: string, summaryContent: string): Promise<void> {
    if (!summaryContent || summaryContent.length < 100) {
      log("[compaction] summary too short to save", { sessionID, length: summaryContent.length });
      return;
    }

    try {
      const result = await openMemoryClient.addMemory(
        `[Session Summary]\n${summaryContent}`,
        scopes.project,
        { type: "conversation" }
      );

      if (result.success) {
        log("[compaction] summary saved as memory", { sessionID, memoryId: result.id });
      } else {
        log("[compaction] failed to save summary", { error: result.error });
      }
    } catch (err) {
      log("[compaction] failed to save summary", { error: String(err) });
    }
  }

  async function handleSummaryMessage(sessionID: string, messageInfo: MessageInfo): Promise<void> {
    if (savedSummaryMessages.has(messageInfo.id)) return;
    rememberSummary(messageInfo.id);

    log("[compaction] capturing summary for memory", { sessionID, messageID: messageInfo.id });

    try {
      const resp = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory },
      });

      const messages = (resp.data ?? resp) as Array<{ info: MessageInfo; parts?: MessagePart[] }>;

      const summaryMessage =
        messages.find((m) => m.info.id === messageInfo.id) ??
        messages.findLast((m) => m.info.role === "assistant" && m.info.summary === true);

      log("[compaction] looking for summary message", {
        sessionID,
        found: !!summaryMessage,
        hasParts: !!summaryMessage?.parts,
      });

      if (summaryMessage?.parts) {
        const textParts = summaryMessage.parts.filter((p) => p.type === "text" && p.text);
        const summaryContent = textParts.map((p) => p.text).join("\n");

        log("[compaction] summary content", {
          sessionID,
          textPartsCount: textParts.length,
          contentLength: summaryContent.length,
        });

        if (summaryContent) {
          await saveSummaryAsMemory(sessionID, summaryContent);
        }
      }
    } catch (err) {
      savedSummaryMessages.delete(messageInfo.id);
      log("[compaction] failed to capture summary", { error: String(err) });
    }
  }

  return {
    /**
     * OpenCode detects the context threshold and triggers compaction itself.
     * We only enrich the compaction prompt with project knowledge.
     */
    async "experimental.session.compacting"(
      input: { sessionID: string },
      output: { context: string[]; prompt?: string }
    ) {
      try {
        const projectMemories = await fetchProjectMemoriesForCompaction();
        output.context.push(createCompactionPrompt(projectMemories));

        log("[compaction] context injected with project memories", {
          sessionID: input.sessionID,
          memoriesCount: projectMemories.length,
        });
      } catch (err) {
        log("[compaction] failed to inject compaction context", { error: String(err) });
      }
    },

    async event({ event }: { event: { type: string; properties?: unknown } }) {
      const props = event.properties as Record<string, unknown> | undefined;

      if (event.type === "message.updated") {
        const info = props?.info as MessageInfo | undefined;
        if (!info?.sessionID) return;

        if (info.role === "assistant" && info.summary === true && info.finish) {
          await handleSummaryMessage(info.sessionID, info);
        }
      }
    },
  };
}
