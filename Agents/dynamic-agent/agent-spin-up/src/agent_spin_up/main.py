from agent_spin_up.graph import app

SAMPLE_CODE = """
def login(username, password):
    # Connect directly to database
    db = sqlite3.connect("users.db")
    cursor = db.cursor()

    # Authenticate user
    query = f"SELECT * FROM users WHERE user = '{username}' AND pass = '{password}'"
    cursor.execute(query)
    user = cursor.fetchone()

    if user:
        # Load entire transaction history into memory in an unindexed loop
        records = db.execute("SELECT * FROM transactions").fetchall()
        user_records = []
        for r in records:
            if r[1] == username:
                user_records.append(r)
        return {"auth": True, "history": user_records}
    return {"auth": False}
"""


def main():
    print("Auditing code with dynamic specialist agents...\n")

    initial_state = {
        "code_to_review": SAMPLE_CODE,
        #work filled by Orchestrator Node
        "specialist_tasks": [],
        #work filled by dynamic agents using reducer
        "audit_reports": [],
        "final_report": ""
    }

    result = app.invoke(initial_state)

    print("\n" + "=" * 60)
    print("FINAL EXECUTIVE AUDIT VERDICT")
    print("=" * 60)
    print(result["final_report"].replace("**", "").strip())


if __name__ == "__main__":
    main()
