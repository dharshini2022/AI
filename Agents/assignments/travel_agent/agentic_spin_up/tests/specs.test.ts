import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { listSpecs, loadSpec } from "../travel_agent/specs.ts";

function tempSpecDir(): string {
  return mkdtempSync(join(tmpdir(), "spec-"));
}

it("parses frontmatter", () => {
  const spec = loadSpec("transportation_agent");
  expect(spec.name).toBe("transportation_agent");
  expect(spec.tools).toEqual(["transport_search"]);
  expect(spec.skills).toEqual([]);
  expect(spec.body).toContain("transport research specialist");
  expect(spec.output).toContain("done");
});

it("loads the place agent's tools and skills", () => {
  const spec = loadSpec("place_agent");
  expect(new Set(spec.tools)).toEqual(
    new Set(["weather_search", "places_search", "restaurants_search", "accommodation_search"]),
  );
  expect(new Set(spec.skills)).toEqual(new Set(["budget_cut", "apply_user_edit"]));
});

it("defaults skills to an empty array when the frontmatter omits the key entirely", () => {
  const dir = tempSpecDir();
  writeFileSync(join(dir, "no_skills_key.md"), "---\ntools: []\n---\nbody");
  expect(loadSpec("no_skills_key", dir).skills).toEqual([]);
});

it("throws at load time when a spec declares an unknown skill", () => {
  const dir = tempSpecDir();
  writeFileSync(join(dir, "bad_agent.md"), "---\nskills: [does_not_exist]\n---\nbody");
  expect(() => loadSpec("bad_agent", dir)).toThrow(/unknown skill 'does_not_exist'/);
});

it("lists specs", () => {
  expect(listSpecs()).toEqual(expect.arrayContaining(["transportation_agent", "place_agent"]));
});

it("never lists main_agent: it lives outside agent_specs/, in its own subfolder", () => {
  // Not `arrayContaining` — this must assert what's absent, or a regression here (e.g. listSpecs() becoming
  // recursive) would pass silently. The second, explicit guard is spinUp.ts's NOT_LAUNCHABLE (tests/subagents.test.ts).
  expect(listSpecs()).not.toContain("main_agent");
});
