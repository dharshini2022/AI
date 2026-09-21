import { createInterface, type Interface } from "node:readline";

// The single stdin reader for the CLI run. Reads prompts sequentially for Hitl.
export class StdinChannel {
  private rl: Interface;
  private pending: ((line: string) => void) | null = null;

  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout });
    this.rl.on("line", (line) => this.handle(line));
  }

  // Resolves with the next line typed into stdin.
  nextLine(prompt: string): Promise<string> {
    process.stdout.write(prompt);
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }

  close(): void {
    this.rl.close();
  }

  private handle(line: string): void {
    const resolve = this.pending;
    this.pending = null;
    resolve?.(line.trim());
  }
}

