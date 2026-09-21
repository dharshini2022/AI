import { settings } from "./config.ts";

// Opt-in latency logs (TRIP_TIMING=1) on stderr, because the MCP server's stdout is the JSON-RPC channel.
export function startTimer(label: string): (detail?: string) => void {
  if (!settings.timing) return () => {};
  const started = performance.now();
  return (detail = "") =>
    console.error(`[timing] ${label} ${Math.round(performance.now() - started)}ms${detail && ` ${detail}`}`);
}
