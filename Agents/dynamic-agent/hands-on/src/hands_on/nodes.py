#Blueprint functions for orchestrator, dynamic workers, and collector.
import threading
import time
from hands_on.state import WorkerInputState

def worker_node(state: WorkerInputState) -> dict:
    #Blueprint for the dynamic worker agent.
    #LangGraph will execute this across multiple threads concurrently.
    
    wid = state["worker_id"]
    os_thread = threading.get_ident()
    
    print(f"  --> [Worker #{wid}] SPUN UP! Running on OS Thread: {os_thread}")
    time.sleep(0.3)  # simulate async/IO work
    
    message = f"Worker #{wid} finished on OS Thread {os_thread}"
    return {"completed_messages": [message]}

