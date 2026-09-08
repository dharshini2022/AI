import os
from litellm import completion


def call_llm(messages, tools):
    response = completion(
        model="groq/openai/gpt-oss-20b",
        messages=messages,
        tools=tools,
        api_key=os.getenv("GROQ_API_KEY")
    )
    return response.choices[0].message
