# DYNAMIC WORKER NODE EXECUTION SPIN UP
## Send() 
- It passes the payload to the node to spin its execution. It is like assigning new task to a worker

---
## Reducer
- It updates on how to merge the results from multiple worker instances without RACE Condition.

### Step-by-Step Execution Workflow

1. **User Input (`main.py`)**  
   The user enters a number (e.g., `3`) via the console prompt.

2. **Graph Invocation (`main.py`)**  
   `run_test` initializes the starting `GraphState`:
   - `count: 3`
   - `completed_messages: []`  
   Then it triggers the graph execution using `app.invoke(initial_state)`.

3. **Routing at START (`graph.py`)**  
   Execution begins at `START`.  
   Because `START` has a conditional edge pointing to `dynamic_fan_out`, LangGraph executes the `dynamic_fan_out(state)` function.

4. **Dynamic Work Orders Generated (`dispatcher.py`)**  
   `dynamic_fan_out` reads `count = 3` from state and creates a list of 3 `Send` objects:
   ```python
   [
       Send("worker_node", {"worker_id": 1}),
       Send("worker_node", {"worker_id": 2}),
       Send("worker_node", {"worker_id": 3})
   ]
   ```
   It returns these 3 "work orders" back to LangGraph's engine.

5. **Dynamic Worker Spin-Up**  
   LangGraph reads the 3 `Send` objects and spins up **3 independent execution instances** of `worker_node` concurrently across separate OS threads.

6. **Worker Execution (`nodes.py`)**  
   Each worker instance runs in isolation with its own `WorkerInputState`.  
   When finished, each returns its result:
   ```python
   {"completed_messages": ["Worker #X finished on OS Thread ..."]}
   ```

7. **State Reduction & Merging (`state.py`)**  
   Before moving to the next step, LangGraph hits a synchronization barrier.  
   It uses the reducer `Annotated[List[str], operator.add]` to concatenate all 3 worker results into the shared `GraphState["completed_messages"]` list without race conditions or overwriting.

8. **Graph Termination (`graph.py`)**  
   Because `builder.add_edge("worker_node", END)` is defined, once all 3 workers finish and merge, the graph transitions to `END` and terminates.

9. **Result Display (`main.py`)**  
   Control returns to `main.py`.  
   `app.invoke()` returns the final state dictionary, and `main.py` prints the merged messages.