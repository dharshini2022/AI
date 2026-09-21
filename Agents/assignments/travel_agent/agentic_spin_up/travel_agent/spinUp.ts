// SpinUp class is custom defined class used for subagent management

import { MemorySaver } from "@langchain/langgraph"; //conversational memory in RAM for each sub-agent
import { tool } from "langchain";
import { z } from "zod";
import { Agent } from "./agent.ts";
import { settings } from "./config.ts";
import type { McpTools } from "./mcpClient.ts";
import { listSpecs, loadSpec } from "./specs.ts";
import { type Dict, truthy } from "./tools/util.ts";
import { isValidFutureDate } from "./validation.ts";

export type SubagentStatus = "running" | "done" | "needs_clarification" | "failed" | "stopped";

export interface SubagentTask {
  id: string;
  specName: string;
  status: SubagentStatus;
  task: Dict;
  tools: Dict; // tool name → latest raw result
  reply: Dict | null;
  error: string | null;
  turns: number;
  clarifications: number;
  startedAt: number;
  finishedAt: number | null;
  inbox: string[]; // messages that arrived mid-turn; each becomes the next turn
  done: Promise<void>; // settles when the task stops running; never rejects
  agent: Agent;
  abort: AbortController | null;
}

export type ResearchSummary = (tools: Dict) => unknown;

const ICONS: Record<SubagentStatus, string> = {
  running: "[running]",
  done: "[done]",
  needs_clarification: "[clarify]",
  failed: "[failed]",
  stopped: "[stopped]",
};

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function safely(fn: () => unknown): Promise<unknown> {
  try {
    return await fn();
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

// The Main Agent never names a sub-agent in code: it launches whichever spec it chooses. Each launch
// runs in the background with its own session (memory), status and inbox.
export class SpinUp {
  private mcp: McpTools;
  private summarize: ResearchSummary;
  private checkpointer = new MemorySaver();
  private records = new Map<string, SubagentTask>();
  private counters = new Map<string, number>();

  constructor(mcp: McpTools, summarize: ResearchSummary) {
    this.mcp = mcp;
    this.summarize = summarize;
  }

  launch(specName: string, task: Dict = {}): SubagentTask {
    if (task.start_date && !isValidFutureDate(String(task.start_date))) {
      throw new Error(`Invalid start_date '${task.start_date}': Must be a valid date in YYYY-MM-DD format and cannot be in the past.`);
    }
    const spec = loadSpec(specName);
    const n = (this.counters.get(specName) ?? 0) + 1;
    this.counters.set(specName, n);
    const id = `${specName}-${n}`;
    const tools: Dict = {};
    const record: SubagentTask = {
      id,
      specName,
      status: "running",
      task,
      tools,
      reply: null,
      error: null,
      turns: 0,
      clarifications: 0,
      startedAt: Date.now(),
      finishedAt: null,
      inbox: [],
      done: Promise.resolve(),
      abort: null,
      agent: new Agent(spec, this.mcp, {
        sessionId: id,
        checkpointer: this.checkpointer,
        onToolResult: (name, result) => {
          tools[name] = result;
        },
      }),
    };
    this.records.set(id, record);
    record.done = this.runTurn(record, JSON.stringify(task));
    return record;
  }

  // Idle sub-agents start a new turn at once; busy ones receive the message as their next turn.
  send(taskId: string, message: string): SubagentTask {
    const record = this.get(taskId);
    if (record.status === "running") record.inbox.push(message);
    else record.done = this.runTurn(record, message);
    return record;
  }

  stop(taskId: string, reason = "stopped by the Main Agent"): SubagentTask {
    const record = this.get(taskId);
    if (record.status === "running") {
      record.inbox = [];
      record.abort?.abort(new Error(reason));
    }
    return record;
  }

  async wait(
    taskIds: string[] | null = null,
    { until = "all", timeoutMs = settings.subagentWaitTimeoutMs }: { until?: "all" | "any"; timeoutMs?: number } = {},
  ): Promise<SubagentTask[]> {
    const targets = taskIds?.length ? taskIds.map((id) => this.get(id)) : [...this.records.values()];
    const pending = targets.filter((r) => r.status === "running").map((r) => r.done);
    if (pending.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      await Promise.race([until === "any" ? Promise.race(pending) : Promise.all(pending), timeout]);
      clearTimeout(timer);
    }
    return targets;
  }

  //recent task details
  latest(specName: string): SubagentTask | undefined {
    return [...this.records.values()].filter((r) => r.specName === specName).at(-1);
  }

  //Board shows all sub-agents' task details
  board(): Dict[] {
    return [...this.records.values()].map((r) => ({
      task_id: r.id,
      spec_name: r.specName,
      status: r.status,
      turns: r.turns,
      seconds: this.seconds(r),
    }));
  }

  //exposes tools to main agent
  langchainTools() {
    const ids = z.array(z.string()).nullish().describe("Task ids to include; omit for every sub-agent task");
    return [
      tool((input) => safely(() => this.entry(this.launch(input.spec_name, input.task))), {
        name: "launch_subagent",
        description:
          "Start a research sub-agent from its spec file. It runs in the background and this returns a task_id " +
          "immediately; collect its result with wait_for_subagents. " +
          `Available specs: ${listSpecs().join(", ") || "(none)"}.`,
        schema: z.object({
          spec_name: z.string().describe("Spec file stem, e.g. 'transportation_agent' or 'place_agent'"),
          task: z.record(z.string(), z.any()).default({}).describe("Input payload passed to the sub-agent"),
        }),
      }),
      tool(
        (input) =>
          safely(async () => {
            const timeoutMs = input.timeout_seconds ? input.timeout_seconds * 1000 : undefined;
            const targets = await this.wait(input.task_ids ?? null, { until: input.until, timeoutMs });
            return targets.map((r) => this.entry(r));
          }),
        {
          name: "wait_for_subagents",
          description:
            "Wait until every sub-agent task stops running (until='all'), or until the next running one finishes, " +
            "asks a question or fails (until='any'); then return each task's status, question, error and research summary.",
          schema: z.object({
            task_ids: ids,
            until: z.enum(["all", "any"]).default("all"),
            timeout_seconds: z.number().positive().nullish(),
          }),
        },
      ),
      tool((input) => safely(() => this.statusOf(input.task_ids ?? null)), {
        name: "check_subagent_status",
        description: "Look at sub-agent tasks right now without waiting: status, turns, seconds, question, error, summary.",
        schema: z.object({ task_ids: ids }),
      }),
      tool(
        (input) =>
          safely(() => {
            const record = this.send(input.task_id, input.message);
            return { task_id: record.id, status: record.status, queued_messages: record.inbox.length };
          }),
        {
          name: "send_message_to_subagent",
          description:
            "Continue a sub-agent's own conversation: answer its question, add a comment or change its instructions. " +
            "An idle sub-agent starts working on it at once; a busy one gets it as its next turn. " +
            "Collect the result with wait_for_subagents.",
          schema: z.object({ task_id: z.string(), message: z.string() }),
        },
      ),
      tool(
        (input) =>
          safely(() => {
            const wasRunning = this.get(input.task_id).status === "running";
            const record = this.stop(input.task_id, input.reason ?? undefined);
            return { task_id: record.id, stop_requested: wasRunning, status: record.status };
          }),
        {
          name: "stop_subagent",
          description:
            "Stop a running sub-agent and drop its queued messages. Its memory is kept, so send_message_to_subagent can resume it later.",
          schema: z.object({ task_id: z.string(), reason: z.string().nullish() }),
        },
      ),
    ];
  }

  private get(taskId: string): SubagentTask {
    const record = this.records.get(taskId);
    if (!record) throw new Error(`Unknown sub-agent task '${taskId}'`);
    return record;
  }

  private statusOf(taskIds: string[] | null): Dict[] {
    const targets = taskIds?.length ? taskIds.map((id) => this.get(id)) : [...this.records.values()];
    return targets.map((r) => this.entry(r));
  }

  private seconds(record: SubagentTask): number {
    return Math.round(((record.finishedAt ?? Date.now()) - record.startedAt) / 100) / 10;
  }

  // What the Main Agent sees: status and a compact summary, never the raw research.
  private entry(record: SubagentTask): Dict {
    return {
      task_id: record.id,
      spec_name: record.specName,
      status: record.status,
      turns: record.turns,
      seconds: this.seconds(record),
      queued_messages: record.inbox.length,
      question: record.status === "needs_clarification" ? (record.reply?.needs_clarification ?? null) : null,
      error: record.error,
      //summarised version of 
      summary: this.summarize(record.tools),
      reply: record.reply,
    };
  }

  private async runTurn(record: SubagentTask, message: string): Promise<void> {
    const controller = new AbortController();
    record.status = "running";
    record.abort = controller;
    record.error = null;
    record.finishedAt = null;
    record.turns++;
    console.log(`  [Main Agent] ${ICONS.running} ${record.id} ${record.turns === 1 ? "launched" : `turn ${record.turns}`}`);

    try {
      const reply = await record.agent.send(message, controller.signal);
      record.reply = reply;
      if (!truthy(reply.needs_clarification)) {
        record.status = "done";
      } else if (++record.clarifications > settings.subagentMaxClarifications) {
        record.status = "failed";
        record.error = `needs clarification beyond the limit of ${settings.subagentMaxClarifications}: ${reply.needs_clarification}`;
      } else {
        record.status = "needs_clarification";
      }
    } catch (err) {
      record.status = controller.signal.aborted ? "stopped" : "failed";
      record.error = errorMessage(controller.signal.aborted ? controller.signal.reason : err);
    } finally {
      record.abort = null;
      record.finishedAt = Date.now();
    }

    const detail = record.status === "needs_clarification" ? `: ${record.reply?.needs_clarification}` : record.error ? `: ${record.error}` : "";
    console.log(`  [Main Agent] ${ICONS[record.status]} ${record.id} ${record.status} after ${this.seconds(record)}s${detail}`);

    const next = record.status === "stopped" ? undefined : record.inbox.shift();
    if (next !== undefined) await this.runTurn(record, next);
  }
}
