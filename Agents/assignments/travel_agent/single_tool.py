import os
import re
from pathlib import Path
import json
from dotenv import load_dotenv
import groq
from groq import Groq
from pprint import pprint



# 1. Deterministic Mock Weather Function
def get_weather(city: str) -> dict:
    """
    Returns structured, mock weather information for a given city.
    No live API calls are made here.
    """
    city_lower = city.strip().lower()
    if "chennai" in city_lower:
        return {
            "city": "Chennai",
            "temperature": "32°C",
            "condition": "Humid and partly cloudy",
            "humidity": "78%",
            "wind_speed": "12 km/h",
            "precipitation_chance": "20%"
        }
    elif "kyoto" in city_lower or "tokyo" in city_lower:
        return {
            "city": city.capitalize(),
            "temperature": "22°C",
            "condition": "Clear and sunny",
            "humidity": "45%",
            "wind_speed": "8 km/h",
            "precipitation_chance": "0%"
        }
    else:
        return {
            "city": city.capitalize(),
            "temperature": "25°C",
            "condition": "Scattered clouds",
            "humidity": "60%",
            "wind_speed": "10 km/h",
            "precipitation_chance": "10%"
        }

# 2. Tool Schema Definition (current official OpenAI/Groq API syntax)
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

def extract_failed_generation(e):
    """
    Attempts to extract the raw generated response from a BadRequestError.
    This fixes the issue where gpt-oss-20b outputs in its internal tool channel format
    causing the Groq gateway to reject it as an invalid tool call.
    """
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
                # Clean up any surrounding quotes
                if (raw_text.startswith('"') and raw_text.endswith('"')) or (raw_text.startswith("'") and raw_text.endswith("'")):
                    raw_text = raw_text[1:-1].strip()
                return raw_text
    return None

def clean_response(text: str) -> str:
    """
    Strips the <think>...</think> tags and their contents from the response.
    """
    if not text:
        return ""
    cleaned = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL)
    return cleaned.strip()

def extract_json_block(text: str) -> str:
    """
    Extracts the first JSON object block from a text string.
    """
    cleaned = clean_response(text)
    start_idx = cleaned.find('{')
    end_idx = cleaned.rfind('}')
    if start_idx != -1 and end_idx != -1 and end_idx > start_idx:
        return cleaned[start_idx:end_idx+1]
    return cleaned

def main():
    # Resolve absolute path to the .env file relative to this script
    env_path = Path(__file__).parent / ".env"
    load_dotenv(dotenv_path=env_path)
    
    # Retrieve the API_KEY from the environment (.env)
    API_KEY = os.getenv("API_KEY")
    
    if not API_KEY:
        print("Warning: API_KEY is not set in the environment or .env file. Using placeholder 'API_KEY'.")
        API_KEY = "API_KEY"
    
    # Initialize the Groq client
    client = Groq(api_key=API_KEY)
    
    # System instructions defining rules for gathering details one-by-one
    system_instruction = (
        "You are a professional Travel Guidance Assistant. Your goal is to help users plan their trips.\n\n"
        "You must collect the following five details from the user before planning:\n"
        "   - Destination\n"
        "   - Duration\n"
        "   - Budget\n"
        "   - Transportation preferences\n"
        "   - Personal interests\n\n"
        "When responding to the user, you must follow these rules:\n"
        "1. Analyze the conversation history to determine which details have already been provided and which are missing.\n"
        "2. If any of the details are missing, ask for exactly ONE missing detail at a time. Do NOT list multiple missing details or ask for more than one at a time. Keep it friendly and conversational.\n"
        "3. Once all five details have been successfully gathered, output a summary of all five details and end your response with the exact tag: '[SUCCESS] All details gathered!'\n"
        "4. Do NOT invent or speculate on real-time information (e.g. weather, flight prices).\n"
        "5. Respond only in plain conversational text. Do NOT use or output any JSON formatting, internal XML/HTML-like tags, or tool-calling structures.\n"
    )

    # Initialize conversation history with system instructions
    messages = [
        {
            "role": "system",
            "content": system_instruction
        }
    ]
    
    print("=== Travel Agent (Interactive Step 1) ===")
    print("Type 'exit' or 'quit' to end the session.\n")
    
    while True:
        user_input = input("You: ")
        
        if user_input.strip().lower() in ["exit", "quit"]:
            print("Goodbye!")
            break
            
        if not user_input.strip():
            continue
            
        # Append user input to history
        messages.append({
            "role": "user",
            "content": user_input
        })
        
        print("\nAgent is thinking...")
        
        response_text = None
        
        try:
            # Send message history to the model
            completion = client.chat.completions.create(
                messages=messages,
                model="qwen/qwen3.6-27b",
                temperature=0.0
            )
            response_text = completion.choices[0].message.content
            
        except groq.BadRequestError as e:
            # Attempt to recover generation from the exception body
            recovered_text = extract_failed_generation(e)
            if recovered_text:
                response_text = recovered_text
            else:
                print(f"\nError communicating with Groq API: {e}")
                break
        except Exception as e:
            print(f"\nError communicating with Groq API: {e}")
            break
            
        if response_text:
            cleaned_text = clean_response(response_text)
            print(f"\nAgent: {cleaned_text}\n")
            
            # Save assistant response to history
            messages.append({
                "role": "assistant",
                "content": cleaned_text
            })
            
            # Check if details collection is complete
            if "[SUCCESS]" in cleaned_text:
                print("Extracting structured travel requirements...")
                
                # Formulate the extraction prompt and schema
                extraction_messages = messages.copy()
                extraction_prompt = (
                    "You are an information extraction assistant. Analyze the conversation history "
                    "and extract the user's travel requirements into a single JSON object matching this schema:\n"
                    "{\n"
                    "  \"origin\": string or null (where they travel from, if mentioned),\n"
                    "  \"destination\": string or null (destination city/region),\n"
                    "  \"duration_days\": integer or null (duration converted to days, e.g., '2 days' -> 2),\n"
                    "  \"budget\": string or null (budget with currency, e.g. '₹15,000' or '5000 INR'),\n"
                    "  \"transportation_preference\": string or null (e.g. train, flight, bike),\n"
                    "  \"interests\": array of strings (e.g. ['food']),\n"
                    "  \"travel_dates\": string or null (specific dates or approximate months, if mentioned)\n"
                    "}\n\n"
                    "Return ONLY a valid JSON object matching the schema. Do not write markdown, code blocks, or explanations."
                )
                extraction_messages.append({
                    "role": "user",
                    "content": extraction_prompt
                })
                
                extracted_json_text = None
                try:
                    # Make standard call, parsing JSON block client-side
                    extraction_completion = client.chat.completions.create(
                        messages=extraction_messages,
                        model="qwen/qwen3.6-27b",
                        temperature=0.0
                    )
                    extracted_json_text = extraction_completion.choices[0].message.content
                except groq.BadRequestError as e:
                    recovered_json = extract_failed_generation(e)
                    if recovered_json:
                        extracted_json_text = recovered_json
                    else:
                        print(f"\nError extracting requirements: {e}")
                        break
                except Exception as e:
                    print(f"\nError extracting requirements: {e}")
                    break
                
                structured_data = {}
                if extracted_json_text:
                    try:
                        cleaned_json = extract_json_block(extracted_json_text)
                        structured_data = json.loads(cleaned_json)
                        print("\n==============================================")
                        print("       STRUCTURED REQUIREMENTS SCHEMA         ")
                        print("==============================================")
                        print(json.dumps(structured_data, indent=2))
                        print("==============================================\n")
                    except Exception as parse_err:
                        print(f"\nError parsing structured JSON: {parse_err}")
                        print(f"Raw Output: {extracted_json_text}")
                
                # Now, generate the final plan based on the structured requirements
                print("Generating your personalized travel plan...")
                planning_messages = [
                    {
                        "role": "system",
                        "content": (
                            "You are a professional travel planner. Create detailed day-by-day travel itineraries. "
                            "You have access to the get_weather tool to look up current weather for the destination "
                            "city, enabling you to suggest weather-appropriate advice (e.g., carrying umbrellas or choosing indoor/outdoor activities)."
                        )
                    },
                    {
                        "role": "user",
                        "content": (
                            f"Generate a detailed, day-by-day travel itinerary using these requirements:\n"
                            f"{json.dumps(structured_data, indent=2)}\n\n"
                            f"Important: Check the weather for the destination first, then plan the trip based on the weather info."
                        )
                    }
                ]
                
                plan_text = None
                try:
                    # Step A: Request containing the exposed tool schema
                    plan_completion = client.chat.completions.create(
                        messages=planning_messages,
                        model="qwen/qwen3.6-27b",
                        tools=[weather_tool_schema],
                        temperature=0.0
                    )
                    
                    response_message = plan_completion.choices[0].message
                    tool_calls = response_message.tool_calls
                    
                    if tool_calls:
                        # Append the assistant's message requesting tool execution to message history
                        planning_messages.append(response_message)
                        
                        # Step B: Process tool calls locally in application space
                        for tool_call in tool_calls:
                            if tool_call.function.name == "get_weather":
                                args = json.loads(tool_call.function.arguments)
                                city_arg = args.get("city", "Chennai")
                                
                                print(f"\n>>> [App Tool Execution] Calling Python function get_weather('{city_arg}')...")
                                weather_result = get_weather(city_arg)
                                print(f">>> [App Tool Output] Function returned: {weather_result}\n")
                                
                                # Step C: Send the function response back to the LLM
                                planning_messages.append({
                                    "role": "tool",
                                    "tool_call_id": tool_call.id,
                                    "name": "get_weather",
                                    "content": json.dumps(weather_result)
                                })
                        
                        # Step D: Final model call with the tool results included in the conversation
                        print("Planning your trip with weather details...")
                        final_plan_completion = client.chat.completions.create(
                            messages=planning_messages,
                            model="qwen/qwen3.6-27b",
                            temperature=0.0
                        )
                        plan_text = final_plan_completion.choices[0].message.content
                    else:
                        plan_text = response_message.content
                        
                except groq.BadRequestError as e:
                    recovered_plan = extract_failed_generation(e)
                    if recovered_plan:
                        plan_text = recovered_plan
                    else:
                        print(f"\nError generating plan: {e}")
                        break
                except Exception as e:
                    print(f"\nError generating plan: {e}")
                    break
                
                if plan_text:
                    cleaned_plan = clean_response(plan_text)
                    print("\n==============================================")
                    print("            YOUR PLANNED TRIP                 ")
                    print("==============================================")
                    print(cleaned_plan)
                    print("==============================================\n")
                break

if __name__ == "__main__":
    main()
