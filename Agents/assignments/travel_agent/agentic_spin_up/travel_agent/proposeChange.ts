// The propose_change tool place_agent uses to swap one place, restaurant or accommodation for a researched
// candidate — and the approval gate in front of it. See current_implementation.md steps 2-4 and
// concepts/features/human-in-the-loop.md for why this needs a draft (Scratchpad.setStaging) rather than
// gating the search tools themselves: humanInTheLoopMiddleware pauses *before* a tool runs, and at that point
// the search result the user needs to see doesn't exist yet.
import { humanInTheLoopMiddleware, tool } from "langchain";
import { z } from "zod";
import {
  applyChange,
  findCandidate,
  formatChangeBox,
  MAX_PROPOSAL_TRIES,
  mealOf,
  type ProposalKind,
  type ProposalTracker,
  toolForKind,
} from "./tools/proposals.ts";
import type { Dict } from "./tools/util.ts";
import type { Scratchpad } from "./scratchpad.ts";

const schema = z.object({
  kind: z.enum(["place", "restaurant", "accommodation"]).describe("What is being replaced"),
  day: z.number().int().nullish().describe("The itinerary day this affects, for a place or restaurant"),
  replace: z.string().describe("Name of the current place/restaurant/accommodation being replaced, exactly as shown in the plan"),
  with: z.string().describe("Name of the new candidate, exactly as it appears in your latest search results for this kind"),
});

type Args = { kind: ProposalKind; day?: number | null; replace: string; with: string };

// Approving applies only the one named swap to the live result (Scratchpad.publish over the existing live
// output), never the rest of the turn's re-searched list — the approval box shows exactly this one change,
// so that's exactly what becomes live. `tracker` is the same ProposalTracker the reject path
// (Hitl.reviewToolCalls) records into: it's checked again here as a backstop, in case the middleware's own
// approve/reject decision is ever bypassed (e.g. a future direct call), so an already-rejected candidate or a
// proposal past its retry limit can never be committed just because "approve" was returned.
export function createProposeChangeTool(scratchpad: Scratchpad, tracker: ProposalTracker) {
  return tool(
    ({ kind, replace, with: candidate }: Args) => {
      const toolName = toolForKind(kind);
      const key = tracker.key(kind, replace);
      if (tracker.attemptsFor(key) >= MAX_PROPOSAL_TRIES) {
        return { error: `limit_reached: ${MAX_PROPOSAL_TRIES} tries already used for this change — do not propose it again.` };
      }
      if (tracker.alreadyRejected(key, candidate)) {
        return { error: `The user already said no to '${candidate}' for this change — propose a different candidate.` };
      }
      const staged = scratchpad.stagedOutput(toolName);
      if (staged === undefined) {
        return { error: `Nothing staged for ${kind} yet — search again this turn before proposing a change.` };
      }
      const item = findCandidate(kind, staged, candidate);
      if (!item) {
        return { error: `'${candidate}' was not found in the latest ${kind} search — propose a name exactly as the search returned it.` };
      }
      const live = applyChange(kind, scratchpad.output(toolName), replace, item, kind === "restaurant" ? mealOf(staged, candidate) : null);
      scratchpad.publish(toolName, live);
      tracker.reset(key);
      return { committed: true, kind, replaced: replace, with: candidate };
    },
    {
      name: "propose_change",
      description:
        "Propose replacing one current place, restaurant or accommodation with a specific candidate from the " +
        "search you just ran. Waits for the user's approval before anything changes — nothing is applied until " +
        "you get an approved result back. If rejected, the response tells you whether to try a different " +
        "candidate or to stop; call this again with a different `with` value, never the same one twice.",
      schema,
    },
  );
}

// The description is built entirely from code — the live item (from the scratchpad's current result) and the
// staged candidate (from the draft the search just wrote) — never from the model's own claim about the change.
// It also flags, in the box itself, when the proposal can't actually be applied (candidate missing, already
// rejected, or the retry limit is used up) — a defence-in-depth signal for whoever is answering the prompt,
// on top of the tool body's own refusal to commit in those cases.
export function createProposeChangeMiddleware(scratchpad: Scratchpad, tracker: ProposalTracker) {
  return humanInTheLoopMiddleware({
    interruptOn: {
      propose_change: {
        allowedDecisions: ["approve", "reject"],
        description: (toolCall) => {
          const { kind, replace, with: candidate } = toolCall.args as Dict;
          const k = kind as ProposalKind;
          const toolName = toolForKind(k);
          const oldItem = findCandidate(k, scratchpad.output(toolName), String(replace ?? ""));
          const newItem = findCandidate(k, scratchpad.stagedOutput(toolName), String(candidate ?? ""));
          const key = tracker.key(k, String(replace ?? ""));
          const box = formatChangeBox(k, oldItem, newItem, String(replace ?? ""), tracker.attemptsFor(key) + 1);
          if (tracker.attemptsFor(key) >= MAX_PROPOSAL_TRIES) {
            return `${box}\n⚠ The retry limit for this change was already used — reject this and it will stop being proposed.`;
          }
          if (tracker.alreadyRejected(key, String(candidate ?? ""))) {
            return `${box}\n⚠ You already rejected this exact candidate — reject this too.`;
          }
          if (!newItem) {
            return `${box}\n⚠ This candidate wasn't found in the latest search — reject this.`;
          }
          return box;
        },
      },
    },
  });
}
