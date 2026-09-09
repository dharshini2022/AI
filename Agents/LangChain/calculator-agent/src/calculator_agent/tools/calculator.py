from langchain_core.tools import tool


@tool
def calculator(a: float, b: float) -> float:
    #tool description converted to schema by langchain
    """Multiply two numbers together.

    Args:
        a: First number to multiply
        b: Second number to multiply
    """
    return a * b
