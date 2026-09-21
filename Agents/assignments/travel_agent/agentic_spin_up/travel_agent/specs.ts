import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { settings } from "./config.ts";
import type { Dict } from "./tools/util.ts";

// Markdown + YAML frontmatter: name, description, tools, model, temperature, output.
export interface AgentSpec {
  name: string;
  description: string;
  tools: string[];
  body: string;
  model: string | null;
  temperature: number | null;
  output: string | null;
}

function splitFrontmatter(text: string): [Dict, string] {
  if (!text.trimStart().startsWith("---")) return [{}, text.trim()];
  const [, frontmatter, ...body] = text.split("---");
  return [parse(frontmatter) ?? {}, body.join("---").trim()];
}

export function loadSpec(name: string, specDir: string = settings.specDir): AgentSpec {
  const path = join(specDir, `${name}.md`);
  if (!existsSync(path)) throw new Error(`no agent spec '${name}' in ${specDir}`);
  const [meta, body] = splitFrontmatter(readFileSync(path, "utf8"));
  return {
    name: meta.name ?? name,
    description: meta.description ?? "",
    tools: [...(meta.tools ?? [])],
    body,
    model: meta.model ?? null,
    temperature: meta.temperature ?? null,
    output: meta.output ?? null,
  };
}

export function listSpecs(specDir: string = settings.specDir): string[] {
  if (!existsSync(specDir) || !statSync(specDir).isDirectory()) return [];
  return readdirSync(specDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
}
