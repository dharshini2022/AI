import os
from pathlib import Path
from dotenv import load_dotenv
import groq
from groq import Groq
import json

# Setup environment
env_path = Path(__file__).parent / ".env"
load_dotenv(dotenv_path=env_path)
API_KEY = os.getenv("API_KEY")
client = Groq(api_key=API_KEY)

# Mock functions
def get_weather(city: str) -> dict:
    return {"city": city, "temperature": "25°C", "condition": "Scattered clouds", "precipitation_chance": "10%"}

def search_places(city: str, category: str) -> dict:
    return {
        "city": city,
        "category": category,
        "places": [
            {"name": "Bangalore Palace", "description": "Royal palace built in 1887."},
            {"name": "Tipu Sultan Palace", "description": "18th-century teakwood palace."}
        ]
    }

def calculate_budget(transportation_cost: float, accommodation_cost: float, food_cost: float, activities_cost: float) -> dict:
    return {
        "transportation_cost": transportation_cost,
        "accommodation_cost": accommodation_cost,
        "food_cost": food_cost,
        "activities_cost": activities_cost,
        "total_estimated_cost": transportation_cost + accommodation_cost + food_cost + activities_cost
    }

# Tool schemas
tools = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get current weather info for a city.",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {"type": "string"}
                },
                "required": ["city"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_places",
            "description": "Search attractions in a city by category.",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {"type": "string"},
                    "category": {"type": "string"}
                },
                "required": ["city", "category"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "calculate_budget",
            "description": "Calculate the total estimated cost of the trip by summing up transportation, accommodation, food, and activities costs.",
            "parameters": {
                "type": "object",
                "properties": {
                    "transportation_cost": {"type": "number"},
                    "accommodation_cost": {"type": "number"},
                    "food_cost": {"type": "number"},
                    "activities_cost": {"type": "number"}
                },
                "required": ["transportation_cost", "accommodation_cost", "food_cost", "activities_cost"]
            }
        }
    }
]

def run_agent_loop(query: str):
    print(f"\n==================================================")
    print(f"RUNNING AGENT LOOP FOR QUERY: '{query}'")
    print(f"==================================================")
    
    messages = [
        {
            "role": "system",
            "content": (
                "You are a professional travel planner. Answer the user prompt fully by calling any necessary tools step-by-step. "
                "You have access to get_weather, search_places, and calculate_budget. Always use them to gather info and perform sums before rendering the final itinerary."
            )
        },
        {
            "role": "user",
            "content": query
        }
    ]
    
    step = 1
    while step <= 6:  # Avoid infinite loop
        print(f"\n--- Step {step} ---")
        try:
            completion = client.chat.completions.create(
                messages=messages,
                model="qwen/qwen3.6-27b",
                tools=tools,
                temperature=0.0
            )
        except Exception as e:
            print(f"Error: {e}")
            break
            
        message = completion.choices[0].message
        tool_calls = message.tool_calls
        
        if tool_calls:
            print(f"Model requested {len(tool_calls)} tool call(s):")
            messages.append(message)  # Append assistant message with tool calls
            
            for tool_call in tool_calls:
                func_name = tool_call.function.name
                args = json.loads(tool_call.function.arguments)
                print(f"  Executing: {func_name}({args})")
                
                if func_name == "get_weather":
                    result = get_weather(args.get("city", ""))
                elif func_name == "search_places":
                    result = search_places(args.get("city", ""), args.get("category", "general"))
                elif func_name == "calculate_budget":
                    result = calculate_budget(
                        args.get("transportation_cost", 0),
                        args.get("accommodation_cost", 0),
                        args.get("food_cost", 0),
                        args.get("activities_cost", 0)
                    )
                else:
                    result = {"error": "unknown tool"}
                    
                print(f"  Returned: {result}")
                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "name": func_name,
                    "content": json.dumps(result)
                })
            step += 1
        else:
            print("No tool calls requested. Final response content:")
            print(message.content)
            break

if __name__ == "__main__":
    run_agent_loop("I want to visit Bangalore for 3 days with a budget of ₹15,000. I prefer historical places. Also tell me whether I need an umbrella.")
