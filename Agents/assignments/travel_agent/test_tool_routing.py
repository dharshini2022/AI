import os
from pathlib import Path
from dotenv import load_dotenv
import groq
from groq import Groq
import json

# 1. Load configuration
env_path = Path(__file__).parent / ".env"
load_dotenv(dotenv_path=env_path)
API_KEY = os.getenv("API_KEY")

if not API_KEY:
    raise ValueError("API_KEY is not set. Please set it in the .env file.")

client = Groq(api_key=API_KEY)

# 2. Tool schemas
weather_tool_schema = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the current weather information for a specific destination city to help customize travel advice.",
        "parameters": {
            "type": "object",
            "properties": {
                "city": {
                    "type": "string",
                    "description": "The name of the city, e.g., Chennai, Kyoto."
                }
            },
            "required": ["city"]
        }
    }
}

search_places_tool_schema = {
    "type": "function",
    "function": {
        "name": "search_places",
        "description": "Search for top attractions, sights, landmarks, or places in a destination city by category (e.g., historical, food, nature, shopping).",
        "parameters": {
            "type": "object",
            "properties": {
                "city": {
                    "type": "string",
                    "description": "The name of the destination city, e.g., Bangalore, Kyoto."
                },
                "category": {
                    "type": "string",
                    "description": "The type of places to search for. Common categories include 'historical', 'food', 'nature', 'shopping'."
                }
            },
            "required": ["city", "category"]
        }
    }
}

tools = [weather_tool_schema, search_places_tool_schema]

# 3. Test prompts
queries = [
    "Will it rain in Bangalore?",
    "What historical places should I visit in Bangalore?",
    "Will it rain and what historical places should I visit?",
    "Will it rain in Bangalore and what historical places should I visit?"
]

def extract_failed_generation(e):
    if hasattr(e, 'body') and isinstance(e.body, dict):
        error_info = e.body.get('error', {})
        if error_info.get('code') == 'tool_use_failed' and 'failed_generation' in error_info:
            failed_gen = error_info['failed_generation']
            marker = '"arguments":'
            if marker in failed_gen:
                idx = failed_gen.find(marker) + len(marker)
                raw_text = failed_gen[idx:].strip()
                if raw_text.endswith('}'):
                    raw_text = raw_text[:-1].strip()
                if (raw_text.startswith('"') and raw_text.endswith('"')) or (raw_text.startswith("'") and raw_text.endswith("'")):
                    raw_text = raw_text[1:-1].strip()
                return raw_text
    return None

def test_query(query: str):
    print(f"\n==================================================")
    print(f"QUERY: '{query}'")
    print(f"==================================================")
    
    messages = [
        {
            "role": "system",
            "content": "You are a professional travel planner. Evaluate the user prompt and decide which tool calls (if any) are necessary to answer it."
        },
        {
            "role": "user",
            "content": query
        }
    ]
    
    try:
        completion = client.chat.completions.create(
            messages=messages,
            model="qwen/qwen3.6-27b",
            tools=tools,
            temperature=0.0
        )
        
        message = completion.choices[0].message
        print(f"Model Content Response: {message.content}")
        
        tool_calls = message.tool_calls
        if tool_calls:
            print(f"Detected {len(tool_calls)} Tool Call(s):")
            for i, tool_call in enumerate(tool_calls, 1):
                print(f"  Tool {i}: {tool_call.function.name}")
                print(f"  Arguments: {tool_call.function.arguments}")
        else:
            print("No Tool Calls requested directly.")
            
    except groq.BadRequestError as e:
        recovered = extract_failed_generation(e)
        if recovered:
            print("Recovered generation from BadRequestError:")
            print(recovered)
        else:
            print(f"API Error: {e}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    for query in queries:
        test_query(query)
