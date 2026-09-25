import type { Dict } from "./tools/util.ts";
import type { ValidatedRequirements } from "./validation.ts";

// One shared scratchpad per trip. Every agent keeps its own conversation memory (checkpointer); the scratchpad
// holds what they must agree on. Who writes what:
//   requirements + preferences: the Main Agent's intake code and its update_preferences tool
//   results:                    code only, from the tool-result hook — sub-agents never write here
// The API is deliberately narrow so the in-memory maps can later become a LangGraph Store.

export interface Preferences {
  exclude: string[]; // kinds of place the user does not want, e.g. "temples"
  indoorMode: boolean;
}

interface ToolRecord {
  args: Dict;
  output: unknown;
}

// Tool arguments that are trip facts: whatever the model passes, these tools get the saved values.
// transport_search is pinned only on the day count: a new date or route there is the user's explicit request.
const PINNED: Record<string, Record<string, keyof ValidatedRequirements>> = {
  transport_search: { num_days: "num_days" },
  weather_search: { destination: "destination", num_days: "num_days", start_date: "start_date" },
  places_search: { destination: "destination" },
  restaurants_search: { destination: "destination" },
  accommodation_search: { destination: "destination", travellers: "num_travellers", start_date: "start_date" },
};
const EXCLUDABLE = new Set(["places_search", "restaurants_search"]);

// The same place, allowing for case, spacing and a qualified form: "Chennai, Tamil Nadu" is still "chennai".
const wordsOf = (name: string) => name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ");
const sameName = (given: unknown, saved: string) => ` ${wordsOf(String(given))} `.includes(` ${wordsOf(saved)} `);

const normalise = (terms: string[]) => [...new Set(terms.map((t) => t.trim().toLowerCase()).filter(Boolean))];

export class Scratchpad {
  private saved: ValidatedRequirements | null = null;
  private results = new Map<string, ToolRecord>();
  private writes = 0;
  readonly preferences: Preferences = { exclude: [], indoorMode: false };

  get requirements(): ValidatedRequirements | null {
    return this.saved;
  }

  requireRequirements(): ValidatedRequirements {
    if (!this.saved) throw new Error("Trip requirements were never saved — the intake must finish first.");
    return this.saved;
  }

  setRequirements(requirements: ValidatedRequirements): void {
    this.saved = requirements;
  }

  updateRequirements(patch: Partial<ValidatedRequirements>): void {
    this.saved = { ...this.requireRequirements(), ...patch };
  }

  addExclusions(terms: string[]): void {
    this.preferences.exclude = normalise([...this.preferences.exclude, ...terms]);
  }

  removeExclusions(terms: string[]): void {
    const drop = new Set(normalise(terms));
    this.preferences.exclude = this.preferences.exclude.filter((t) => !drop.has(t));
  }

  setIndoorMode(enabled: boolean): void {
    this.preferences.indoorMode = enabled;
  }

  record(tool: string, args: Dict, output: unknown): void {
    this.results.set(tool, { args, output });
    this.writes++;
  }

  output(tool: string): any {
    return this.results.get(tool)?.output;
  }

  // The latest output of each named tool that has run, keyed by tool name.
  outputs(tools: string[]): Dict {
    return Object.fromEntries(tools.filter((t) => this.results.has(t)).map((t) => [t, this.results.get(t)!.output]));
  }

  // Counts every recorded result, so a cached plan can tell when the research behind it has changed.
  get version(): number {
    return this.writes;
  }

  // Added to a sub-agent's system prompt on every model call, so it never has to remember the facts.
  factsBlock(): string {
    if (!this.saved) return "";
    const lines = [
      "\n\n## Trip facts (authoritative)",
      "The Main Agent saved these from the user. Never change them. If a task or message disagrees with them, the facts win.",
      JSON.stringify(this.saved),
    ];
    if (this.preferences.exclude.length) {
      lines.push(`The user does NOT want: ${this.preferences.exclude.join(", ")}. Pass this list as "exclude" to places_search and restaurants_search.`);
    }
    return lines.join("\n");
  }

  // Guardrail run before every sub-agent tool call: puts the saved facts back if the model drifted from them.
  // `notice` is set only when a value the model chose was replaced, so the model can be told about it.
  pin(tool: string, input: Dict): { input: Dict; notice?: string } {
    const facts = this.saved;
    if (!facts) return { input };
    const next: Dict = { ...input };
    const replaced: string[] = [];
    for (const [arg, field] of Object.entries(PINNED[tool] ?? {})) {
      const saved = facts[field];
      const given = next[arg];
      const same = arg === "destination" ? given !== undefined && sameName(given, String(saved)) : String(given) === String(saved);
      if (same) continue; // keep the model's own spelling
      if (given !== undefined) {
        console.log(`  [guard] ${tool}: ${arg} '${given}' replaced with the saved '${saved}'`);
        replaced.push(`${arg} '${given}' → '${saved}'`);
      }
      next[arg] = saved;
    }
    if (EXCLUDABLE.has(tool) && this.preferences.exclude.length) {
      next.exclude = normalise([...(input.exclude ?? []), ...this.preferences.exclude]);
    }
    const notice = replaced.length
      ? `The trip facts are fixed, so the search used the saved values instead: ${replaced.join("; ")}. Do not try other names for the destination.`
      : undefined;
    return { input: next, notice };
  }
}
