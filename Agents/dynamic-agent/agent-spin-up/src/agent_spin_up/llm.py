import os
from dotenv import load_dotenv
from langchain_litellm import ChatLiteLLM

load_dotenv()


def get_llm(max_tokens=600):
    """Returns a fast Groq chat model."""
    return ChatLiteLLM(
        model="groq/openai/gpt-oss-20b",
        api_key=os.getenv("GROQ_API_KEY"),
        temperature=0.1,
        max_tokens=max_tokens,
    )
