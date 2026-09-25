// converts agent prompt markdown files into AgentSpec objects, which are used to create agents at runtime
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { settings } from "./config.ts";
import type { Dict } from "./tools/util.ts";

// Markdown + YAML frontmatter: name, description, tools, skills, temperature, output.
export interface AgentSpec {
  name: string;
  description: string;
  tools: string[];
  skills: string[]; 
  body: string; //system prompt body
  temperature: number | null;
  output: string | null;
}

// splits prompt and skills files into frontmatter and body, returning a Dict of frontmatter and a string of body text
export function splitFrontmatter(text: string): [Dict, string] {
  if (!text.trimStart().startsWith("---")) return [{}, text.trim()];
  const [, frontmatter, ...body] = text.split("---");
  return [parse(frontmatter) ?? {}, body.join("---").trim()];
}

// To check whether the skill.md declared in agent spec exisits. This is to avoid runtime errors when creating an agent with a spec that declares a skill that does not exist.
function skillExist(names: string[], specName: string, skillDir: string): void {
  for (const name of names) {
    const path = join(skillDir, name, "SKILL.md");
    if (!existsSync(path)) throw new Error(`agent spec '${specName}' declares unknown skill '${name}' (no ${path})`);
  }
}

export function loadSpec(name: string, specDir: string = settings.specDir): AgentSpec {
  const path = join(specDir, `${name}.md`);
  if (!existsSync(path)) throw new Error(`no agent spec '${name}' in ${specDir}`);
  const [meta, body] = splitFrontmatter(readFileSync(path, "utf8"));  //read ans spits agent spec
  const skills = [...(meta.skills ?? [])];  //take skills from the frontmatter
  skillExist(skills, meta.name ?? name, settings.skillDir); //check whether skill exists
  return {
    name: meta.name ?? name,
    description: meta.description ?? "",
    tools: [...(meta.tools ?? [])],
    skills,
    body,
    temperature: meta.temperature ?? null,
    output: meta.output ?? null,
  };
}

//list the agent spec files names to main-agent
export function listSpecs(specDir: string = settings.specDir): string[] {
  if (!existsSync(specDir) || !statSync(specDir).isDirectory()) return [];
  return readdirSync(specDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
}
