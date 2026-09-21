# TypeScript Migration

The planner was ported from Python to TypeScript as a 1:1 translation. The architecture didn't change: the Main Agent, spec-driven sub-agents and the stdio MCP server all work as before. Only the language and libraries changed.

## Decisions

- **Runtime:** ESM on Node 26, which runs `.ts` files directly by stripping types. There is no build step, and `tsc --noEmit` only type-checks. As a result the code can't use TypeScript syntax that has runtime behaviour (`enum`, `namespace`, constructor parameter properties); `erasableSyntaxOnly` in `tsconfig.json` enforces this.
- **Libraries:** LangChain.js `createAgent` and `tool`, `@modelcontextprotocol/sdk`, `zod` for MCP input schemas, `yaml` for spec frontmatter, `dotenv`. Switching agent frameworks during the port was ruled out so there was only one source of risk.
- **LLM routing:** `llm.ts` builds `ChatOpenAI` with `configuration.baseURL = LLM_API_BASE`. LiteLLM has no TypeScript SDK, so switching providers goes through a LiteLLM **proxy**. This is the same path the Python agents already used, since `get_chat_model` was the only LLM helper with callers.
- **MCP client:** The Python client needed a background thread, an asyncio loop and a job queue to call async MCP from sync code. In Node all of that is replaced by `async call()` plus a small concurrency limiter.
- **Naming:** TypeScript identifiers are camelCase. Everything that crosses a boundary stays snake_case: MCP tool names and arguments, JSON result keys, spec frontmatter and env vars. That is why the prompts, specs and `docs/output_schema.md` didn't change.
- **Not ported (no callers):** the unused `litellm` wrapper and `run_agent` loop in `llm.py`, `SpinUp.schema()`, `search_named`, `_cheapest`, `_kg_price`, and the unused settings `agent_max_steps`, `serper_api_key`, `duffel_api_key`, `budget_retry_limit`.
- **Original Python source:** kept in [`travel_agent_python/`](../travel_agent_python/), a self-contained sibling of the TypeScript `travel_agent/` package (own `.venv`, `requirements.txt`, tests, and a copy of `agent_specs/`), rather than deleted. It shares the project-root `.env`. See the README's "Original Python Implementation" section for how to run it.

## Matching Python's behaviour

The tools port Python's exact behaviour through small helpers in `travel_agent/tools/util.ts`:

| Python behaviour | Helper | Why it matters |
|---|---|---|
| `round()` / `:.0f` round halves to even, based on the exact binary value | `pyRound`, `fmtFixed` | `Math.round(2.5)` is 3; Python gives 2 (e.g. places-per-day, `₹` amounts) |
| `a or b` returns an operand, and `[]` / `{}` count as false | `pyOr`, `truthy` | Empty lists and dicts are truthy in JS |
| `dict.get(k, default)` | `get` | A stored `null` must win over the default |
| `str(12.0)` is `"12.0"` | `numStr` | Distances, flight hours and temperatures in rendered text |
| `str.title()`, `urllib.parse.quote` | `pyTitle`, `pyQuote` | Booking link titles and URLs |
| `strptime("%Y-%m-%d")` + `timedelta` | `parseIsoDate`, `addDays` | Everything is computed in UTC, so no timezone drift |

`tests/tools.test.ts` checks every tool against `tests/fixtures/parity.json`. Those outputs were recorded from the Python tools against the same canned HTTP responses (`tests/fixtures/http_responses.json`).

## Known differences

- **Whole-number floats from API JSON:** JSON parsing can't tell `4.0` from `4`, so a rating the API sends as `4.0` renders as `★4` instead of `★4.0`. Values the code computes itself still print with `.0`.
- **Sub-agent task message:** it's serialized with `JSON.stringify`, which has no spaces after separators and doesn't escape non-ASCII. The model gets the same data.
- **Numeric-looking keys:** in offer dicts, keys like `"0"` are iterated in numeric order (JS object order) instead of insertion order.
- **Unchanged Python quirk:** the frontmatter field `model` is parsed but not applied to the sub-agent's chat model, exactly as in Python.
