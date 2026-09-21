#Orchestrator, Specialist Worker, and Synthesizer agent blueprints
import json
import threading
from langchain_core.messages import SystemMessage, HumanMessage
from agent_spin_up.llm import get_llm
from agent_spin_up.state import AgentTaskState, AuditGraphState

"""
Analyzes the user's code and dynamically decides which
specialist agents need to be spun up.
"""
def orchestrator_node(state: AuditGraphState) -> dict:

    print("\n[Orchestrator Agent] Analyzing code to plan dynamic specialist agents...")
    llm = get_llm()

    system_prompt = (
        "You are a Lead Software Architect. Analyze the provided code snippet and decide "
        "which 2 to 3 specialized review agents should be created to audit it (e.g., Security, "
        "Performance, Code Quality/Architecture).\n"
        "Return ONLY a valid JSON array of objects with keys: 'role', 'focus_area', 'instructions'.\n"
        "Do not wrap in markdown quotes if possible, or use standard JSON."
    )

    response = llm.invoke([
        SystemMessage(content=system_prompt),
        HumanMessage(content=f"Code snippet to audit:\n\n{state['code_to_review']}")
    ])

    # Clean JSON text in case of markdown formatting
    content = response.content.strip()
    if content.startswith("```"):
        content = content.split("```")[1]
        if content.startswith("json"):
            content = content[4:]
        content = content.strip()

    try:
        tasks = json.loads(content)
    except Exception:
        print("[Orchetrator] Error creating Tasks")
        return {}

    # Inject the code snippet into each task dictionary
    for t in tasks:
        t["code_snippet"] = state["code_to_review"]

    print(f"[Orchestrator Agent] Decided to spin up {len(tasks)} specialist agents:")
    for t in tasks:
        print(f"   • {t['role']} (Focus: {t['focus_area']})")

    #In LangGraph, always the return dict corresponds to state update.
    return {"specialist_tasks": tasks}


"""
Blueprint for EACH dynamic worker agent.
LangGraph runs this concurrently for each task yielded by Send().
"""
def specialist_agent_node(state: AgentTaskState) -> dict:

    role = state["role"]
    focus = state["focus_area"]
    thread_id = threading.get_ident()

    print(f"  --> [Spawned Agent: {role}] RUNNING on OS Thread: {thread_id}...")
    llm = get_llm()

    system_prompt = (
        f"You are a senior {role} focusing strictly on: {focus}.\n"
        f"Context: {state['instructions']}\n"
        "Provide exactly 2 to 3 concise bullet points reviewing the code snippet:\n"
        "• [Severity: High/Med/Low] Issue: <brief explanation>\n"
        "  Recommendation: <how to fix>\n"
        "DO NOT use asterisks (no **bold**). Keep your entire answer under 150 words."
    )

    response = llm.invoke([
        SystemMessage(content=system_prompt),
        HumanMessage(content=state["code_snippet"])
    ])

    report = {
        "role": role,
        "focus_area": focus,
        "findings": response.content,
        "thread_id": thread_id
    }

    # operator.add merges this into audit_reports
    return {"audit_reports": [report]}


"""
Aggregates all dynamic audit reports into an executive verdict.
"""
def synthesizer_node(state: AuditGraphState) -> dict:
    print("\n[Synthesizer Agent] All dynamic audits received. Generating final verdict...")
    llm = get_llm(max_tokens=800)

    reports_text = ""
    for r in state["audit_reports"]:
        reports_text += f"\n--- Report from {r['role']} (Focus: {r['focus_area']}) ---\n"
        reports_text += r["findings"] + "\n"

    system_prompt = (
        "You are the Engineering Director. Synthesize the findings from your specialist auditors "
        "into a clean, executive review verdict.\n\n"
        "CRITICAL FORMATTING RULES:\n"
        "- Do NOT use asterisks for bolding (never write **word**).\n"
        "- Do NOT use HTML tags (no <br>).\n"
        "- Do NOT use markdown tables.\n"
        "- Use clean text headers and indented bullet points.\n\n"
        "Required Structure:\n"
        "OVERALL STATUS: [BLOCKED / WARNINGS / APPROVED] - Brief 1-sentence reason\n\n"
        "KEY RISKS IDENTIFIED:\n"
        "  1. [Risk Area]: Explanation\n"
        "  2. [Risk Area]: Explanation\n"
        "  3. [Risk Area]: Explanation\n\n"
        "REQUIRED ACTIONS BEFORE MERGE:\n"
        "  • [Action Item]: Concrete remediation step\n"
        "  • [Action Item]: Concrete remediation step\n"
        "  • [Action Item]: Concrete remediation step\n\n"
        "NEXT STEPS:\n"
        "  Brief guidance on re-audit and merge clearance."
    )

    response = llm.invoke([
        SystemMessage(content=system_prompt),
        HumanMessage(content=f"Auditor Reports:\n{reports_text}")
    ])

    return {"final_report": response.content}
