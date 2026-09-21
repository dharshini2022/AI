import { createInterface } from "node:readline/promises";
import type { HITLRequest, HITLResponse } from "langchain";
import type { StdinChannel } from "./stdin.ts";
import { type BudgetRecheck, renderCards } from "./tools/index.ts";
import type { Dict } from "./tools/util.ts";

const YES = new Set(["y", "yes", "ok", "sure", "yeah"]);

// Pure text builders reused as interrupt descriptions (shown before a decision is made),
// with no I/O of their own.
export function formatWeatherBox(weather?: Dict, reason?: string): string {
  const intro = reason ? `${reason} Switch itinerary to indoor activities?` : "The forecast is poor for much of the trip — switch to indoor activities?";
  if (!weather || !Array.isArray(weather.days) || weather.days.length === 0) return intro;
  const lines = [`\n${intro}\n`, `┌ Weather Forecast Notice ──────────────────────────────────────────`];
  if (weather.destination) lines.push(`│ Destination : ${weather.destination}`);
  const badDays = (weather.days as Dict[]).filter((d) => Number(d.rain_pct ?? 0) >= 40);
  lines.push(`│ Summary     : ${badDays.length} of ${weather.days.length} days with high rain probability`, `├ Daily Breakdown:`);
  for (const day of weather.days as Dict[]) {
    const isBad = Number(day.rain_pct ?? 0) >= 40;
    const badTag = isBad ? " [⚠️ BAD WEATHER]" : "";
    const tempStr = day.temp ? ` · ${day.temp}` : "";
    const rainStr = day.rain_pct != null ? ` · ${day.rain_pct}% rain` : "";
    lines.push(`│   • ${day.date} : ${day.condition}${tempStr}${rainStr}${badTag}`);
  }
  lines.push(`└───────────────────────────────────────────────────────────────────`);
  return lines.join("\n");
}

export function formatBookingBox(details: Dict): string {
  const lines = [`\nAuthorize and execute flight ticket booking?\n`, `┌ Flight Booking Authorization ────────────────────────────────────`];
  if (details.destination) lines.push(`│ Destination : ${details.destination}`);
  if (details.transport_option) lines.push(`│ Option      : ${details.transport_option}`);
  if (details.fare) lines.push(`│ Approx Fare : ${details.fare}`);
  lines.push(`└───────────────────────────────────────────────────────────────────`);
  return lines.join("\n");
}

export async function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

// The single human-in-the-loop channel, owned by the Main Agent. Pass `answers` to script it for tests.
// Pass `stdin` in the CLI so prompts share the one persistent reader.
export class Hitl {
  private scripted: string[];
  private stdin?: StdinChannel;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(answers: string[] = [], stdin?: StdinChannel) {
    this.scripted = [...answers];
    this.stdin = stdin;
  }

  // Parallel tool calls must not interleave prompts on one terminal.
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async input(prompt: string): Promise<string> {
    const answer = this.scripted.shift();
    if (answer !== undefined) {
      console.log(`${prompt}${answer}`);
      return answer;
    }
    return this.stdin ? this.stdin.nextLine(prompt) : readLine(prompt);
  }

  askUser(question: string) {
    return this.serial(async () => ({ answer: await this.input(`\n${question}\n> `) }));
  }

  askChoice(prompt: string, options: string[]) {
    return this.serial(async () => {
      console.log(`\n${prompt}`);
      options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));
      const raw = await this.input("> ");
      const index = /^\s*[+-]?\d+\s*$/.test(raw)
        ? Math.max(0, Math.min(Number.parseInt(raw, 10) - 1, options.length - 1))
        : 0;
      return { index, choice: options.length ? options[index] : null };
    });
  }

  askYesNo(question: string) {
    return this.serial(async () => {
      const raw = await this.input(`\n${question} (yes/no)\n> `);
      return { answer: YES.has(raw.trim().toLowerCase()) };
    });
  }

  handleTransportChoice(prompt: string, options: string[]) {
    return this.askChoice(prompt, options);
  }

  handleBudgetResolution(prompt: string, options: string[]) {
    return this.askChoice(prompt, options);
  }

  handleSubagentClarification(question: string) {
    return this.askUser(question);
  }

  // Renders a paused interrupt's action requests and collects an approve/reject decision
  // per action, resuming the LangGraph run that raised it.
  reviewToolCalls(request: HITLRequest): Promise<HITLResponse> {
    return this.serial(async () => {
      const decisions: HITLResponse["decisions"] = [];
      for (let i = 0; i < request.actionRequests.length; i++) {
        const action = request.actionRequests[i];
        const config = request.reviewConfigs[i];
        console.log(action.description ?? `\nTool execution requires approval\n\nTool: ${action.name}`);
        const raw = await this.input(`Approve ${action.name}? (yes/no)\n> `);
        if (YES.has(raw.trim().toLowerCase()) && config.allowedDecisions.includes("approve")) {
          decisions.push({ type: "approve" });
        } else {
          const reason = await this.input("Reason (optional):\n> ");
          decisions.push({ type: "reject", message: reason || undefined });
        }
      }
      return { decisions };
    });
  }

  showPlan(itinerary: Dict, budgetStatus: Dict | null, recheck: BudgetRecheck | null = null): void {
    console.log(`\n${"=".repeat(66)}\nFINAL PLAN\n${"=".repeat(66)}`);
    console.log(renderCards(itinerary, budgetStatus, recheck));
  }
}
