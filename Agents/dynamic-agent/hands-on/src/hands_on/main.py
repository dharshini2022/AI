from hands_on.graph import app


def run_test(count: int):
    print("=" * 60)
    print(f"RUNNING TEST: User requests {count} dynamic workers")
    print("=" * 60)
    
    initial_state = {
        "count": count,
        "completed_messages": []
    }
    
    result = app.invoke(initial_state)
    
    print("\n[Main Runner] Graph execution complete!")
    print(f"[Main Runner] Total messages merged by reducer: {len(result['completed_messages'])}")
    for msg in result["completed_messages"]:
        print(f"   • {msg}")


if __name__ == "__main__":
    node = int(input("Enter the no.of workers to spin up:"))
    run_test(node)

