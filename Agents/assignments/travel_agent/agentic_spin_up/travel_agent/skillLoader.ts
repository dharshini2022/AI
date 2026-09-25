import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tool } from "langchain";
import { z } from "zod";
import { settings } from "./config.ts";
import { splitFrontmatter } from "./specs.ts";
import type { Dict } from "./tools/util.ts";


export interface SkillHeader {
  name: string;
  description: string;
}


const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;

function readSkillFile(name: string, skillDir: string): [Dict, string] {
  if (!SAFE_NAME.test(name)) throw new Error(`invalid skill name '${name}'`);
  const path = join(skillDir, name, "SKILL.md");  //skill file path
  if (!existsSync(path)) throw new Error(`no skill '${name}' in ${skillDir}`);
  return splitFrontmatter(readFileSync(path, "utf8"));  //splits skill into frontmatter and body
}

export function loadSkillHeader(name: string, skillDir: string = settings.skillDir): SkillHeader {
  const [meta] = readSkillFile(name, skillDir);
  return { name: meta.name ?? name, description: meta.description ?? "" };
}

export function loadSkillBody(name: string, skillDir: string = settings.skillDir): string {
  const [, body] = readSkillFile(name, skillDir);
  return body;
}

// Instructions to process skills and the list of available skills for an agent.
export function skillCatalog(names: string[]): string {
  if (!names.length) return "";
  const lines = names.map((name) => `- ${name}: ${loadSkillHeader(name).description}`);
  return (
    "\n\n## Skills available to you\n" +
    "These are extra instructions for a situation that doesn't come up on every turn. When a message " +
    "matches one below, call load_skill with its name BEFORE acting, and follow what it returns for that turn:\n" +
    lines.join("\n")
  );
}

// function that returns a langchain tool using which an agent can load its skills by name.
export function createLoadSkillTool(names: string[]) {
  const allowed = new Set(names);
  return tool(
    ({ name }: { name: string }) => {
      if (!allowed.has(name)) return { error: `'${name}' is not a skill available to you. Available: ${[...allowed].join(", ") || "(none)"}` };
      try {
        return { instructions: loadSkillBody(name) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
    {
      name: "load_skill",
      description: "Load the full instructions for one of your available skills by name, before acting on it.",
      schema: z.object({ name: z.string().describe("The skill's name, exactly as listed in your system prompt") }),
    },
  );
}
