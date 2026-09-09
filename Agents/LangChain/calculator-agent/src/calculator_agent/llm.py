import os
from langchain_litellm import ChatLiteLLM


def get_llm():
    return ChatLiteLLM(
        model="groq/openai/gpt-oss-20b",
        api_key=os.getenv("GROQ_API_KEY"),
        temperature=0.0,
    )
