#Type definitions and state schemas
import operator
from typing import Annotated, List, TypedDict


class WorkerInputState(TypedDict):
    #Isolated state payload sent to EACH dynamically spawned worker.
    worker_id: int

#Shared state of the overall workflow.
class GraphState(TypedDict):
    count: int
    # Reducer: operator.add appends new data to the old data
    #Annotated: run time instructions
    #List[str] datatype of completed messages
    #operator.add => how to update => append to list
    completed_messages: Annotated[List[str], operator.add]
