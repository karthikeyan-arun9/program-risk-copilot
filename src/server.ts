import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateObject,
  NoSuchToolError,
  pruneMessages,
  stepCountIs,
  streamText,
  tool,
  wrapLanguageModel,
  type LanguageModelMiddleware
} from "ai";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Program Risk Copilot
// A stateful agent that reviews program status updates, scores delivery risk,
// keeps a persistent risk register, and escalates only with human approval.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Workaround for a Workers AI connector bug: Workers AI sends each streamed
// piece in two formats at once, and the connector passes both along, so
// every word (and every piece of tool-call data) arrives twice. Seen with
// both Llama 3.3 and Kimi K2.7.
// This filter drops the second copy of each piece, and rebuilds tool-call
// data from the cleaned pieces so it is valid JSON again.
// ---------------------------------------------------------------------------
const dedupeDoubledStream: LanguageModelMiddleware = {
  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream();
    // Last piece we kept for each text / tool-call stream, waiting to see
    // whether its duplicate comes next.
    const pendingDuplicate = new Map<string, string>();
    // Cleaned-up tool-call data, rebuilt piece by piece.
    const cleanToolInput = new Map<string, string>();

    // biome-ignore lint/suspicious/noExplicitAny: stream parts are a union type
    const filter = new TransformStream<any, any>({
      transform(part, controller) {
        if (part.type === "text-delta" || part.type === "tool-input-delta") {
          const key = `${part.type}:${part.id}`;
          if (pendingDuplicate.get(key) === part.delta) {
            // Second copy of the piece we just kept: drop it.
            pendingDuplicate.delete(key);
            return;
          }
          pendingDuplicate.set(key, part.delta);
          if (part.type === "tool-input-delta") {
            cleanToolInput.set(
              part.id,
              (cleanToolInput.get(part.id) ?? "") + part.delta
            );
          }
          controller.enqueue(part);
          return;
        }

        if (part.type === "tool-call") {
          const clean = cleanToolInput.get(part.toolCallId);
          if (clean && !isValidJson(part.input) && isValidJson(clean)) {
            controller.enqueue({ ...part, input: clean });
            return;
          }
        }

        controller.enqueue(part);
      }
    });

    return { stream: stream.pipeThrough(filter), ...rest };
  }
};

function isValidJson(text: unknown): boolean {
  if (typeof text !== "string") return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// Llama sometimes sends true/false as text ("true"). Accept both forms.
// (Plain z.coerce.boolean() would wrongly turn "false" into true.)
const looseBoolean = z.preprocess(
  (v) => (v === "true" ? true : v === "false" ? false : v),
  z.boolean().optional()
);

// The risk signals the model looks for in each status update.
const SIGNALS = [
  "short_review_window",
  "incomplete_testing",
  "repeat_incidents",
  "risky_timing",
  "rushed_language",
  "missing_rollback_plan"
] as const;

type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "NEEDS_HUMAN_REVIEW";

const LEVELS: RiskLevel[] = ["LOW", "MEDIUM", "HIGH", "NEEDS_HUMAN_REVIEW"];

// Models sometimes send "High" or "needs human review"; normalize to our format.
function normalizeLevel(value: string): RiskLevel {
  const v = value.trim().toUpperCase().replace(/[\s-]+/g, "_") as RiskLevel;
  return LEVELS.includes(v) ? v : "NEEDS_HUMAN_REVIEW";
}

// Models phrase signals loosely ("short review window", "holiday freeze
// proximity"). Map them onto our standard names so filtering and digests
// stay consistent. Anything unrecognized is kept, in the same format.
const SIGNAL_KEYWORDS: [RegExp, (typeof SIGNALS)[number]][] = [
  [/review|approv/, "short_review_window"],
  [/test|qa\b|regression|validat/, "incomplete_testing"],
  [/incident|outage|repeat|recurr/, "repeat_incidents"],
  [/freeze|holiday|timing|friday|weekend|peak|launch window/, "risky_timing"],
  [/rush|asap|urgent|hurr|quick fix/, "rushed_language"],
  [/rollback|roll back|revert|backout|back out/, "missing_rollback_plan"]
];

function normalizeSignals(raw: string[]): string[] {
  const out = new Set<string>();
  for (const signal of raw) {
    const text = signal.trim().toLowerCase();
    if (!text) continue;
    const match = SIGNAL_KEYWORDS.find(([pattern]) => pattern.test(text));
    out.add(match ? match[1] : text.replace(/[\s-]+/g, "_"));
  }
  return [...out];
}

// The same update should not be logged twice. Treat it as a duplicate if the
// same team was logged with the same signals in the last 10 minutes.
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

function sameSignals(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s) => b.includes(s));
}

// Llama tends to repeat earlier tool calls from chat history (for example,
// re-logging an old update when the user only asked to clear the register).
// So the logging tool only writes when the latest message looks like a
// status update, not a command or question about the register.
function isRegisterCommand(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return true;
  if (
    /^(clear|reset|list|show|what|which|who|how|why|when|escalate|send|schedule|remind|cancel|delete|remove|give|get|approve|hi|hello|hey|thanks|thank you|yes|no|ok|okay)\b/.test(
      t
    )
  ) {
    return true;
  }
  return t.endsWith("?") && t.length < 150;
}

// Builds a plain-language reply from what the tools did this turn. Used only
// when the model ends a turn without writing any text itself.
// biome-ignore lint/suspicious/noExplicitAny: tool results vary by tool
function fallbackReply(steps: any[]): string {
  const lines: string[] = [];
  for (const step of steps) {
    for (const result of step.toolResults ?? []) {
      const input = result.input ?? {};
      const output = result.output ?? {};
      switch (result.toolName) {
        case "logRiskUpdate":
          if (output.logged) {
            lines.push(
              `Logged **${output.riskLevel}** risk for ${input.team} (id \`${output.id}\`).\n\n` +
                `**Why:** ${input.rationale}\n\n` +
                `**Recommended action:** ${input.recommendedAction}\n\n` +
                "This is a flag for you to review, not a go/no-go decision."
            );
          } else if (output.duplicate) {
            lines.push(
              `This update is already in the register as \`${output.id}\` (${output.riskLevel}), so it wasn't logged again.`
            );
          }
          break;
        case "listRisks":
          if (Array.isArray(output)) {
            lines.push(
              `${output.length} risk(s) in the register:\n` +
                output
                  .map(
                    (r: RiskEntry) =>
                      `- **${r.riskLevel}** · ${r.team} (\`${r.id}\`)${r.escalated ? " · escalated" : ""}: ${r.summary}`
                  )
                  .join("\n")
            );
          } else {
            lines.push(String(output));
          }
          break;
        case "clearRegister":
          if (output.cleared) {
            lines.push(`Cleared the risk register (${output.removed} removed).`);
          }
          break;
        case "escalateRisk":
          lines.push(
            output.escalated
              ? `Escalated ${output.team} (\`${output.riskId}\`) to leadership.`
              : `Escalation didn't go through: ${output.error ?? "unknown error"}`
          );
          break;
        case "scheduleDigest":
        case "getScheduledTasks":
        case "cancelScheduledTask":
          lines.push(typeof output === "string" ? output : JSON.stringify(output));
          break;
      }
    }
  }
  return lines.length > 0
    ? lines.join("\n\n")
    : "Sorry, I didn't produce a reply that time. Please try again.";
}

type RiskEntry = {
  id: string;
  team: string;
  summary: string;
  signals: string[];
  riskLevel: RiskLevel;
  rationale: string;
  recommendedAction: string;
  loggedAt: string;
  escalated: boolean;
};

// Persistent memory: this survives restarts and is stored with the agent.
type RiskState = {
  risks: RiskEntry[];
};

export class ChatAgent extends AIChatAgent<Env, RiskState> {
  maxPersistedMessages = 100;
  // Wait for MCP connections to be re-established after hibernation before
  // processing a message, so MCP tools aren't intermittently missing.
  waitForMcpConnections = true;

  // Starting state for a brand-new agent: an empty risk register.
  initialState: RiskState = { risks: [] };

  onStart() {
    // Configure OAuth popup behavior for MCP servers that require authentication
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });

    // Kimi K2.7 on Workers AI: the model Cloudflare's current agents-starter
    // template uses, and much more reliable at tool calling than Llama 3.3
    // (which repeated old tool calls and ignored "don't retry" results).
    // The dedupe filter is applied to every model: the doubled streaming is
    // a connector bug, not specific to one model.
    const MODEL_ID = "@cf/moonshotai/kimi-k2.7-code";
    const model = wrapLanguageModel({
      model: workersai(MODEL_ID, { sessionAffinity: this.sessionAffinity }),
      middleware: dedupeDoubledStream
    });

    // Text of the user's latest message, used to decide which tools to offer.
    const lastUser = [...this.messages].reverse().find((m) => m.role === "user");
    const latestText = (lastUser?.parts ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(" ");
    const latestIsCommand = isRegisterCommand(latestText);

    const tools = {
    // MCP tools from connected servers
    ...mcpTools,

    // Server-side tool: the model fills in a structured risk assessment,
    // and we save it to the agent's persistent state (memory).
    logRiskUpdate: tool({
      description:
        "Log a program or change status update with a structured risk assessment into the risk register.",
      inputSchema: z.object({
        team: z.string().describe("Team, workstream, or system name"),
        summary: z.string().describe("One-sentence summary of the update"),
        signals: z
          .array(z.string())
          .describe(
            `Risk signals found in the update (can be empty). Prefer these names: ${SIGNALS.join(", ")}`
          ),
        riskLevel: z
          .string()
          .describe("One of: LOW, MEDIUM, HIGH, NEEDS_HUMAN_REVIEW"),
        rationale: z
          .string()
          .describe("Short explanation of why this level was assigned"),
        recommendedAction: z
          .string()
          .describe("One concrete next step for the program manager")
      }),
      execute: async ({
        team,
        summary,
        signals,
        riskLevel,
        rationale,
        recommendedAction
      }) => {
        // Only log when the latest message is a new status update.
        // For commands and questions, do nothing and tell the model to
        // stop trying, so it answers the actual request instead.
        if (latestIsCommand) {
          return {
            logged: false,
            skipped: true,
            note: "The user's latest message is a command or question, not a new status update. Nothing was logged. Do not call logRiskUpdate again; answer the user's request."
          };
        }
        try {
          const level = normalizeLevel(riskLevel);
          const cleanSignals = normalizeSignals(signals);
          const current = this.state?.risks ?? [];

          // Guard against logging the same update twice.
          const now = Date.now();
          const existing = current.find(
            (r) =>
              r.team.trim().toLowerCase() === team.trim().toLowerCase() &&
              sameSignals(r.signals, cleanSignals) &&
              now - new Date(r.loggedAt).getTime() < DUPLICATE_WINDOW_MS
          );
          if (existing) {
            return {
              logged: false,
              duplicate: true,
              id: existing.id,
              riskLevel: existing.riskLevel,
              note: "This update is already in the register; not logged again."
            };
          }

          const entry: RiskEntry = {
            id: crypto.randomUUID().slice(0, 8),
            team,
            summary,
            signals: cleanSignals,
            riskLevel: level,
            rationale,
            recommendedAction,
            loggedAt: new Date().toISOString(),
            escalated: false
          };
          this.setState({ risks: [...current, entry] });
          return {
            logged: true,
            id: entry.id,
            riskLevel: level,
            totalInRegister: current.length + 1
          };
        } catch (error) {
          console.error("logRiskUpdate failed:", error);
          return { logged: false, error: String(error) };
        }
      }
    }),

    // Server-side tool: read back what is in memory.
    listRisks: tool({
      description:
        "List risks in the register. Optionally filter by risk level or show only open (not escalated) items.",
      inputSchema: z.object({
        riskLevel: z
          .string()
          .optional()
          .describe(
            "Only show this risk level: LOW, MEDIUM, HIGH, or NEEDS_HUMAN_REVIEW"
          ),
        openOnly: looseBoolean.describe(
          "If true, hide items already escalated"
        )
      }),
      execute: async ({ riskLevel, openOnly }) => {
        let items = this.state?.risks ?? [];
        if (riskLevel) {
          const level = normalizeLevel(riskLevel);
          items = items.filter((r) => r.riskLevel === level);
        }
        if (openOnly) items = items.filter((r) => !r.escalated);
        return items.length > 0
          ? items
          : "No matching risks in the register.";
      }
    }),

    // Human-in-the-loop tool: always requires the user's approval.
    escalateRisk: tool({
      description:
        "Escalate a logged risk to leadership. Always requires the user's approval before it runs.",
      inputSchema: z.object({
        riskId: z.string().describe("The id of the risk to escalate"),
        message: z
          .string()
          .describe(
            "Short message to leadership with options and trade-offs"
          )
      }),
      needsApproval: async () => true,
      execute: async ({ riskId, message }) => {
        const risks = this.state?.risks ?? [];
        const found = risks.find((r) => r.id === riskId);
        if (!found) return { error: `No risk found with id ${riskId}` };
        this.setState({
          risks: risks.map((r) =>
            r.id === riskId ? { ...r, escalated: true } : r
          )
        });
        this.broadcast(
          JSON.stringify({
            type: "scheduled-task",
            description: `Escalated ${found.team}: ${message}`,
            timestamp: new Date().toISOString()
          })
        );
        return { escalated: true, riskId, team: found.team };
      }
    }),

    // Simple scheduling tool: schedule the digest to run after a delay.
    scheduleDigest: tool({
      description:
        "Schedule a risk digest to run after a delay. Use this when the user asks for a digest or reminder later.",
      inputSchema: z.object({
        delayInSeconds: z.coerce
          .number()
          .describe("Seconds from now until the digest runs"),
        description: z
          .string()
          .describe("Short label, for example: Weekly risk digest")
      }),
      execute: async ({ delayInSeconds, description }) => {
        try {
          this.schedule(delayInSeconds, "executeTask", description, {
            idempotent: true
          });
          return `Digest scheduled in ${delayInSeconds} seconds: "${description}"`;
        } catch (error) {
          return `Error scheduling digest: ${error}`;
        }
      }
    }),

    // Reset the register (useful before a demo). Requires approval,
    // because it permanently deletes every logged risk.
    clearRegister: tool({
      description:
        "Delete every risk in the register. Only use when the user explicitly asks to clear or reset the register. Always requires approval.",
      inputSchema: z.object({}),
      needsApproval: async () => true,
      execute: async () => {
        const count = (this.state?.risks ?? []).length;
        this.setState({ risks: [] });
        return { cleared: true, removed: count };
      }
    }),

    getScheduledTasks: tool({
      description: "List all tasks that have been scheduled",
      inputSchema: z.object({}),
      execute: async () => {
        const tasks = this.getSchedules();
        return tasks.length > 0 ? tasks : "No scheduled tasks found.";
      }
    }),

    cancelScheduledTask: tool({
      description: "Cancel a scheduled task by its ID",
      inputSchema: z.object({
        taskId: z.string().describe("The ID of the task to cancel")
      }),
      execute: async ({ taskId }) => {
        try {
          this.cancelSchedule(taskId);
          return `Task ${taskId} cancelled.`;
        } catch (error) {
          return `Error cancelling task: ${error}`;
        }
      }
    })
  };

    const result = streamText({
      model,
      system: `You are the Program Risk Copilot, an assistant for technical program managers.

When the user shares a project or change status update:
1. Look for these risk signals: ${SIGNALS.join(", ")}.
2. Call the logRiskUpdate tool with the team, a one-sentence summary, the signals you found, a risk level, a short rationale, and a concrete recommended action.
3. Reply briefly with the risk level, why, and the recommended action.

Risk level rules:
- LOW: no meaningful signals.
- MEDIUM: one moderate signal, or two minor ones.
- HIGH: any single severe signal (for example skipped testing), or three or more signals.
- NEEDS_HUMAN_REVIEW: you are not confident. Never guess.

Only call logRiskUpdate for a NEW status update in the user's latest message. Updates from earlier in the conversation have already been handled; never log them again. If logRiskUpdate reports a duplicate, tell the user it is already in the register.

Important behavior:
- You never make a final go/no-go decision. You surface risk so a human can decide.
- To escalate a risk to leadership, use the escalateRisk tool. It always asks the user for approval first.
- If the user asks what is open, flagged, or risky, use only the listRisks tool. Do not log anything.
- If the user asks to clear or reset the register, use the clearRegister tool. It asks the user for approval first.
- If the user wants a digest or reminder later, use the scheduleDigest tool with a delay in seconds.
- If the user only greets you, reply with a short greeting and explain that you review program status updates and keep a risk register.`,
      // Prune old tool calls and reasoning to save tokens on long conversations
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        // Keep earlier tool calls in the history, so the model can see that
        // past updates were already logged and doesn't try to log them again.
        // (maxPersistedMessages above caps how long the history gets.)
        toolCalls: "none",
        reasoning: "before-last-message"
      }),

      // Second safety net: if tool-call data is still unreadable after the
      // dedupe filter, ask the model again, without streaming, for the
      // tool's arguments in clean JSON that matches the tool's schema.
      experimental_repairToolCall: async ({
        toolCall,
        tools,
        messages,
        error
      }) => {
        if (NoSuchToolError.isInstance(error)) return null;
        const brokenTool = tools[toolCall.toolName as keyof typeof tools];
        if (!brokenTool) return null;
        try {
          const { object } = await generateObject({
            model,
            // biome-ignore lint/suspicious/noExplicitAny: schema comes from the tool definition
            schema: brokenTool.inputSchema as any,
            messages: [
              ...messages,
              {
                role: "user",
                content: `Produce the arguments for the ${toolCall.toolName} tool based on the conversation above. Return only the JSON object.`
              }
            ]
          });
          console.log(`Repaired tool call for ${toolCall.toolName}`);
          return { ...toolCall, input: JSON.stringify(object) };
        } catch (repairError) {
          console.error("Tool call repair failed:", repairError);
          return null;
        }
      },

      tools,
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal,
      onError: ({ error }) => {
        console.error("streamText error:", error);
      }
    });

    // Pass the model's reply through to the chat. If a turn ends without
    // any visible text (Kimi sometimes treats the tool card as the whole
    // answer), write a short reply ourselves from the tool results, so the
    // user always gets an answer in words.
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        let wroteText = false;
        let awaitingApproval = false;
        for await (const chunk of result.toUIMessageStream({
          sendFinish: false,
          onError: (error) => {
            console.error("Stream error:", error);
            return error instanceof Error ? error.message : String(error);
          }
        })) {
          if (chunk.type === "text-delta" && chunk.delta.trim()) wroteText = true;
          if (chunk.type === "tool-approval-request") awaitingApproval = true;
          writer.write(chunk);
        }
        if (!wroteText && !awaitingApproval) {
          const id = crypto.randomUUID();
          writer.write({ type: "text-start", id });
          writer.write({
            type: "text-delta",
            id,
            delta: fallbackReply(await result.steps)
          });
          writer.write({ type: "text-end", id });
        }
        writer.write({ type: "finish" });
      }
    });
    return createUIMessageStreamResponse({ stream });
  }

  // Runs when a scheduled task fires. Here it doubles as the weekly digest:
  // it summarizes open HIGH / NEEDS_HUMAN_REVIEW risks from memory.
  async executeTask(description: string, _task: Schedule<string>) {
    console.log(`Executing scheduled task: ${description}`);

    const openUrgent = (this.state?.risks ?? []).filter(
      (r) =>
        !r.escalated &&
        (r.riskLevel === "HIGH" || r.riskLevel === "NEEDS_HUMAN_REVIEW")
    );
    const digest =
      openUrgent.length > 0
        ? openUrgent
            .map((r) => `${r.team} [${r.riskLevel}] ${r.summary}`)
            .join(" | ")
        : "No open high-risk items.";

    // Notify connected clients via a broadcast event.
    // We use broadcast() instead of saveMessages() to avoid injecting
    // into chat history — that would cause the AI to see the notification
    // as new context and potentially loop.
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description: `${description} — Digest: ${digest}`,
        timestamp: new Date().toISOString()
      })
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;