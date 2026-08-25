import os
from pathlib import Path
from dotenv import load_dotenv
import groq
from groq import Groq
import json

# 1. Load configuration and client
env_path = Path(__file__).parent / ".env"
load_dotenv(dotenv_path=env_path)
API_KEY = os.getenv("API_KEY")

if not API_KEY:
    raise ValueError("API_KEY is not set. Please set it in the .env file.")

client = Groq(api_key=API_KEY)

# 2. Local Python Functions (Mock)
def get_weather(city: str) -> dict:
    print("  -> Python Function 'get_weather' executing locally...")
    return {
        "city": city.capitalize(),
        "temperature": "25°C",
        "condition": "Scattered clouds",
        "precipitation_chance": "10%"
    }

def search_places(city: str, category: str) -> dict:
    print("  -> Python Function 'search_places' executing locally...")
    return {
        "city": city.capitalize(),
        "category": category,
        "places": [
            {"name": "Bangalore Palace", "description": "Royal palace built in 1887."},
            {"name": "Tipu Sultan's Summer Palace", "description": "18th-century teakwood palace."}
        ]
    }

def calculate_budget(transportation_cost: float, accommodation_cost: float, food_cost: float, activities_cost: float) -> dict:
    print("  -> Python Function 'calculate_budget' executing locally...")
    total = transportation_cost + accommodation_cost + food_cost + activities_cost
    return {
        "transportation_cost": transportation_cost,
        "accommodation_cost": accommodation_cost,
        "food_cost": food_cost,
        "activities_cost": activities_cost,
        "total_estimated_cost": total
    }

# 3. Tool schemas exposed to the LLM
tools = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get current weather info for a city.",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {"type": "string", "description": "The name of the destination city."}
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
                    "city": {"type": "string", "description": "The destination city."},
                    "category": {"type": "string", "description": "The type of places, e.g. historical."}
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

# 4. Core Agent Loop Implementation
def run_agent(user_input: str) -> str:
    """
    Main agent execution loop. Runs repeatedly until the model stops requesting tools.
    """
    print(f"\n==================================================")
    print(f"Starting run_agent for user input:")
    print(f"'{user_input}'")
    print(f"==================================================")
    
    # Setup initial messages
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
            "content": user_input
        }
    ]
    
    step = 1
    while True:
        print(f"\n[Step {step}] Sending conversation history to model...")
        
        # 1. Send the conversation to the model
        completion = client.chat.completions.create(
            messages=messages,
            model="qwen/qwen3.6-27b",
            tools=tools,
            temperature=0.0
        )
        
        response_message = completion.choices[0].message
        tool_calls = response_message.tool_calls
        
        # 2. Check whether the model requested a tool call
        if tool_calls:
            print(f"[Step {step}] Model requested {len(tool_calls)} tool call(s).")
            # Append the assistant's message requesting tool execution to history
            messages.append(response_message)
            
            for tool_call in tool_calls:
                func_name = tool_call.function.name
                args_str = tool_call.function.arguments
                
                # Mention that the tool is executing
                print(f"  -> Tool '{func_name}' executing...")
                
                # Validate and parse arguments
                try:
                    args = json.loads(args_str)
                except Exception as e:
                    print(f"  -> Argument validation/parsing failed: {e}")
                    result = {"error": f"Invalid arguments format: {e}"}
                else:
                    # Execute corresponding Python function
                    if func_name == "get_weather":
                        result = get_weather(args.get("city", "Bangalore"))
                    elif func_name == "search_places":
                        result = search_places(args.get("city", "Bangalore"), args.get("category", "historical"))
                    elif func_name == "calculate_budget":
                        result = calculate_budget(
                            transportation_cost=args.get("transportation_cost", 0),
                            accommodation_cost=args.get("accommodation_cost", 0),
                            food_cost=args.get("food_cost", 0),
                            activities_cost=args.get("activities_cost", 0)
                        )
                    else:
                        print(f"  -> Unrecognized tool name: {func_name}")
                        result = {"error": f"Tool {func_name} is not implemented."}
                
                print(f"  -> Tool '{func_name}' result: {result}")
                
                # Add the tool result back into the conversation logs
                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "name": func_name,
                    "content": json.dumps(result)
                })
                
            step += 1  # Increment loop step
        else:
            # 4. If the model does not request another tool, return final response.
            print(f"[Step {step}] Model did not request any tool call. Finalizing response.")
            return response_message.content

if __name__ == "__main__":
    prompt = "Plan a 3-day Bangalore trip under ₹15,000. I like historical places and want to know if I need an umbrella."
    final_itinerary = run_agent(prompt)
    print("\n==============================================")
    print("                FINAL ITINERARY               ")
    print("==============================================")
    print(final_itinerary)
    print("==============================================\n")
