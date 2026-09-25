import { describe, expect, it } from "vitest";
import { MainAgentSession } from "../travel_agent/mainAgent.ts";

// MainAgentSession mirrors SubagentTask's inbox: idle runs now, busy queues, resolved once the queued
// turn actually runs. A fake Agent stands in for the real one — MainAgentSession only ever calls `.send`.
function fakeAgent(behaviour: (message: string, turn: number) => unknown, delayMs = 0) {
  let turn = 0;
  const history: string[] = [];
  const send = async (message: string) => {
    turn++;
    history.push(message);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return behaviour(message, turn);
  };
  return { agent: { send } as any, history };
}

describe("MainAgentSession", () => {
  it("runs an idle turn immediately", async () => {
    const { agent } = fakeAgent(() => ({ requirements: { num_days: 3 } }));
    const session = new MainAgentSession(agent);
    await expect(session.send("Bangalore to Munnar")).resolves.toEqual({ requirements: { num_days: 3 } });
  });

  it("a message sent while busy is queued and resolves with its own reply, not the busy turn's", async () => {
    const { agent, history } = fakeAgent((_, turn) => (turn === 1 ? { requirements: { num_days: 3 } } : { requirements: { num_days: 5 } }), 50);
    const session = new MainAgentSession(agent);

    const first = session.send("Bangalore to Munnar");
    const second = session.send("actually 5 days");
    await expect(first).resolves.toEqual({ requirements: { num_days: 3 } });
    await expect(second).resolves.toEqual({ requirements: { num_days: 5 } });
    expect(history).toEqual(["Bangalore to Munnar", "actually 5 days"]);
  });

  it("queues multiple messages behind a busy turn and drains them in order", async () => {
    const { agent, history } = fakeAgent((msg) => ({ done: true, msg }), 20);
    const session = new MainAgentSession(agent);

    const p1 = session.send("initial request");
    const p2 = session.send("second message");
    const p3 = session.send("third message");

    await Promise.all([p1, p2, p3]);

    expect(history).toEqual([
      "initial request",
      "second message",
      "third message",
    ]);
  });
});

