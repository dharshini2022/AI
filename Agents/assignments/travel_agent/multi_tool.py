import os
import re
import time
from pathlib import Path
import json
from dotenv import load_dotenv
import groq
from groq import Groq
from pprint import pprint
import urllib.request
import urllib.parse
from ddgs import DDGS
import ssl

# Fallback patch for environments using older LibreSSL (like default macOS Python 3.9)
# to prevent "Unsupported protocol version 0x304" (TLS 1.3 negotiation failure)
orig_create_default_context = ssl.create_default_context
def secure_create_default_context(*args, **kwargs):
    context = orig_create_default_context(*args, **kwargs)
    if hasattr(context, "maximum_version"):
        context.maximum_version = ssl.TLSVersion.TLSv1_2
    return context
ssl.create_default_context = secure_create_default_context

# 1. Real-Time Weather Function (OpenWeatherMap Integration)
def get_weather(city: str) -> dict:
    """
    Retrieves real-time weather information for a given city from OpenWeatherMap API.
    Normalizes the output to match the format expected by the planning agent.
    """
    api_key = os.getenv("WEATHER_API_KEY")
    if not api_key:
        return {
            "error": "Weather API key is not configured. Please set WEATHER_API_KEY in environment."
        }
        
    city_clean = city.strip()
    base_url = "https://api.openweathermap.org/data/2.5/weather"
    params = {
        "q": city_clean,
        "appid": api_key,
        "units": "metric"
    }
    
    url = f"{base_url}?{urllib.parse.urlencode(params)}"
    
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "TravelAgent/1.0"})
        # Timeout set to 5 seconds
        with urllib.request.urlopen(req, timeout=5) as response:
            data = json.loads(response.read().decode("utf-8"))
            
            # Extract and normalize fields to isolate the agent from API specifics
            weather_desc = data["weather"][0]["description"].capitalize() if data.get("weather") else "Unknown"
            temp = data["main"]["temp"]
            humidity = data["main"]["humidity"]
            wind_speed = data["wind"]["speed"]
            
            # Infer precipitation likelihood based on cloud cover or presence of rain block
            rain_chance = "0%"
            if "rain" in data:
                rain_chance = "High (active rain)"
            elif "clouds" in data and data["clouds"].get("all", 0) > 50:
                rain_chance = "Moderate (cloudy)"
                
            return {
                "city": data["name"],
                "temperature": f"{temp}°C",
                "condition": weather_desc,
                "humidity": f"{humidity}%",
                "wind_speed": f"{wind_speed} m/s",
                "precipitation_chance": rain_chance
            }
            
    except urllib.error.HTTPError as e:
        try:
            err_body = json.loads(e.read().decode("utf-8"))
            err_message = err_body.get("message", e.reason)
        except Exception:
            err_message = e.reason
            
        print(f"  -> Weather API HTTP Error: {e.code} - {err_message}")
        return {
            "error": f"Weather API error {e.code}: {err_message}"
        }
    except urllib.error.URLError as e:
        print(f"  -> Weather API Connection Error: {e.reason}")
        return {
            "error": f"Failed to connect to Weather Service: {e.reason}"
        }
    except TimeoutError as e:
        print(f"  -> Weather API Timeout: {e}")
        return {
            "error": "Weather Service request timed out after 5 seconds."
        }
    except Exception as e:
        print(f"  -> Weather API Unexpected Error: {e}")
        return {
            "error": f"Unexpected error during weather lookup: {str(e)}"
        }

# 2. Live Places Search Function (DuckDuckGo Web Search Integration)
def search_places(city: str, category: str) -> dict:
    """
    Searches DuckDuckGo for top attractions/places in a destination city by category.
    Returns the top 4 results including their URLs.
    """
    category_clean = category.strip().lower()
    if "food" in category_clean or "restaurant" in category_clean or "dining" in category_clean:
        query = f"famous local restaurants food spots dining in {city}"
    elif "shopping" in category_clean or "mall" in category_clean or "market" in category_clean:
        query = f"popular shopping malls traditional markets bazaars in {city}"
    elif "historical" in category_clean or "history" in category_clean or "heritage" in category_clean:
        query = f"top historical sites landmarks heritage spots in {city}"
    elif "nature" in category_clean or "outdoor" in category_clean or "park" in category_clean or "lake" in category_clean:
        query = f"top parks gardens lakes nature spots in {city}"
    else:
        query = f"top {category} attractions sights places in {city}"
    try:
        results = []
        with DDGS() as ddgs:
            # Execute text search, limiting to top 4 results
            response = ddgs.text(query, max_results=4)
            if response:
                for r in response:
                    results.append({
                        "name": r.get("title", "Unknown Attraction"),
                        "description": r.get("body", "No description available."),
                        "url": r.get("href", "")
                    })
            else:
                return {
                    "city": city.capitalize(),
                    "category": category,
                    "message": f"No search results found on DuckDuckGo for query: '{query}'",
                    "places": []
                }
        return {
            "city": city.capitalize(),
            "category": category,
            "places": results
        }
    except Exception as e:
        print(f"  -> DuckDuckGo Search Error: {e}")
        return {
            "error": f"Failed to perform web search for attractions: {str(e)}"
        }

def calculate_budget(transportation_cost: float, accommodation_cost: float, food_cost: float, activities_cost: float) -> dict:
    """
    Calculates the total estimated travel cost based on individual components.
    """
    try:
        t_cost = float(transportation_cost)
        acc_cost = float(accommodation_cost)
        f_cost = float(food_cost)
        act_cost = float(activities_cost)
    except (ValueError, TypeError) as e:
        return {
            "error": "Invalid cost inputs. All inputs must be numeric values.",
            "details": str(e)
        }
        
    total = t_cost + acc_cost + f_cost + act_cost
    return {
        "transportation_cost": t_cost,
        "accommodation_cost": acc_cost,
        "food_cost": f_cost,
        "activities_cost": act_cost,
        "total_estimated_cost": total
    }

# 3. Tool Schema Definitions
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

calculate_budget_tool_schema = {
    "type": "function",
    "function": {
        "name": "calculate_budget",
        "description": "Calculate the total estimated cost of the trip by summing up transportation, accommodation, food, and activities costs.",
        "parameters": {
            "type": "object",
            "properties": {
                "transportation_cost": {
                    "type": "number",
                    "description": "Estimated cost for local and inter-city transportation."
                },
                "accommodation_cost": {
                    "type": "number",
                    "description": "Estimated cost for lodging/accommodation."
                },
                "food_cost": {
                    "type": "number",
                    "description": "Estimated cost for meals and beverages."
                },
                "activities_cost": {
                    "type": "number",
                    "description": "Estimated cost for entry tickets, guided tours, and other activities."
                }
            },
            "required": ["transportation_cost", "accommodation_cost", "food_cost", "activities_cost"]
        }
    }
}

# 4. Safe Tool Registry
TOOL_REGISTRY = {
    "get_weather": get_weather,
    "search_places": search_places,
    "calculate_budget": calculate_budget
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

def call_groq_with_retry(client: Groq, **kwargs):
    max_retries = 4
    delay = 10
    for attempt in range(max_retries):
        try:
            return client.chat.completions.create(**kwargs)
        except groq.RateLimitError as rle:
            print(f"\n[Rate Limit] TPM/RPM limit hit. Waiting {delay}s before retry (Attempt {attempt + 1}/{max_retries})...")
            time.sleep(delay)
            delay *= 2
        except Exception as e:
            err_str = str(e).lower()
            if "rate limit" in err_str or "429" in err_str:
                print(f"\n[Rate Limit] 429 error detected. Waiting {delay}s before retry (Attempt {attempt + 1}/{max_retries})...")
                time.sleep(delay)
                delay *= 2
            else:
                raise e
    return client.chat.completions.create(**kwargs)

def run_agent(structured_data: dict, client: Groq) -> str:
    """
    Executes the travel agent planning loop using the gathered requirements and tools.
    """
    planning_messages = [
        {
            "role": "system",
            "content": (
                "You are a professional travel planner specializing in high-fidelity, grounded travel itineraries.\n"
                "You have access to three tools to help customize the itinerary:\n"
                "1. get_weather: check current weather for a city.\n"
                "2. search_places: search for top attractions/sights in a city by category.\n"
                "3. calculate_budget: calculate the total estimated cost.\n\n"
                "CRITICAL INSTRUCTIONS FOR ACCURACY & GROUNDING:\n"
                "- Extract the **specific local places, attractions, restaurants, or malls** mentioned inside the search results "
                "(either in the name or the description/snippet text). Do NOT use generic listicle titles (like 'THE 10 BEST Restaurants...' or 'Wikipedia') as the names of the places in your schedule.\n"
                "- Do NOT hallucinate or invent place names. Every place you recommend must be mentioned in the search results payload. "
                "For example, if the description mentiones 'Gedee Car Museum', you may recommend 'Gedee Car Museum'.\n"
                "- You should perform **multiple search_places tool calls for different categories** (e.g. search for 'food' AND search for 'historical' or 'nature') to gather enough real-world attractions and restaurants to fully plan every day requested by the user. Ensure every day has breakfast, lunch, and dinner recommendations using the search results.\n"
                "- For every place you recommend, include its original web source link using the 'url' field of the search result "
                "from which you extracted it: `[Original Source]({url})`.\n"
                "- You MUST also include the official Google Maps search link for every place, formatted exactly as follows:\n"
                "  `[Open in Google Maps](https://www.google.com/maps/search/?api=1&query={url_encoded_place_name}+{city})`\n"
                "  Replace {url_encoded_place_name} with the specific place name (spaces replaced by +) and {city} with the destination city.\n\n"
                "OUTPUT FORMAT INSTRUCTIONS:\n"
                "- Do NOT use markdown tables to represent schedules. Instead, organize the itinerary day-by-day using clear headers (e.g. '### Day 1 – ...') and bold block sections for daily time blocks (e.g. Morning, Afternoon, Evening).\n"
                "- For each activity block, list:\n"
                "  - **🕒 Timeframe / Part of Day** (e.g., Morning, Afternoon, Evening)\n"
                "  - **📍 Place**: [Specific Place Name](https://www.google.com/maps/search/?api=1&query=url_encoded_place_name+city)\n"
                "  - **🌐 Reference**: [Original Web Source](url_from_tool)\n"
                "  - **📝 Recommendation Notes**: A brief description based strictly on the search result description."
            )
        },
        {
            "role": "user",
            "content": (
                f"Generate a detailed, day-by-day travel itinerary using these requirements:\n"
                f"{json.dumps(structured_data, indent=2)}\n\n"
                f"Important: Run the required tools first. Check the weather, search for attractions/places matching the user's category interests, and calculate the estimated budget using the calculate_budget tool. Only finalize the response once you have called the tools and received their results. Follow the strict grounding and formatting instructions."
            )
        }
    ]
    
    step = 1
    while True:
        try:
            # 1. Send the conversation to the model
            plan_completion = client.chat.completions.create(
                messages=planning_messages,
                model="qwen/qwen3.6-27b",
                tools=[weather_tool_schema, search_places_tool_schema, calculate_budget_tool_schema],
                temperature=0.0
            )
        except groq.BadRequestError as e:
            recovered_plan = extract_failed_generation(e)
            if recovered_plan:
                return recovered_plan
            else:
                print(f"\nError communicating with model: {e}")
                return "Error: Could not generate plan."
        except Exception as e:
            print(f"\nError communicating with model: {e}")
            return "Error: Could not generate plan."
            
        response_message = plan_completion.choices[0].message
        tool_calls = response_message.tool_calls
        
        # 2. Check whether the model requested a tool call
        if tool_calls:
            # Append the assistant's message requesting tool execution to message history
            planning_messages.append(response_message)
            
            # Process tool calls locally in application space
            for tool_call in tool_calls:
                func_name = tool_call.function.name
                args_str = tool_call.function.arguments
                
                print(f"\n>>> [App Tool Execution] Tool '{func_name}' executing...")
                
                # 1. Verify tool existence in registry (handling unknown tool)
                if func_name not in TOOL_REGISTRY:
                    print(f"  -> Error: Unrecognized tool name '{func_name}'.")
                    result = {"error": f"Tool '{func_name}' is not recognized/registered."}
                else:
                    # 2. Validate parameters (handling invalid arguments)
                    try:
                        args = json.loads(args_str)
                    except json.JSONDecodeError as jde:
                        print(f"  -> Error parsing JSON arguments: {jde}")
                        result = {"error": f"Invalid JSON arguments: {jde}"}
                    except Exception as e:
                        print(f"  -> Argument validation failed: {e}")
                        result = {"error": f"Argument validation failed: {e}"}
                    else:
                        # 3. Execute only the registered function and handle exceptions
                        try:
                            func = TOOL_REGISTRY[func_name]
                            result = func(**args)
                            print(f"  -> Function '{func_name}' executed successfully. Return: {result}")
                        except TypeError as te:
                            # Catches mismatching arguments (e.g. missing required, extra/unexpected args)
                            print(f"  -> Argument signature mismatch for '{func_name}': {te}")
                            result = {"error": f"Argument signature mismatch: {te}. Check tool parameters."}
                        except Exception as e:
                            # Catches tool execution exceptions
                            print(f"  -> Exception during execution of '{func_name}': {e}")
                            result = {"error": f"Tool execution failed due to an internal error: {e}"}
                    
                # Add the tool result back into the conversation logs
                planning_messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "name": func_name,
                    "content": json.dumps(result)
                })
            step += 1
        else:
            # 4. Return the final response if no more tool calls
            return response_message.content

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
    
    print("=== Travel Agent (Interactive Step 1 - Multi-Tool Version) ===")
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
                    # Make standard call with retry, parsing JSON block client-side
                    extraction_completion = call_groq_with_retry(
                        client,
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
                        
                # --- Validation Step ---
                destination = structured_data.get("destination")
                budget = structured_data.get("budget")
                is_valid = True
                validation_error_msg = ""
                
                # Check for empty or obvious placeholders in destination
                if not destination or destination.strip().lower() in ["xxx", "placeholder", "anywhere", "none", "null"]:
                    is_valid = False
                    validation_error_msg = "It looks like the destination city provided is a placeholder or invalid. Could you please specify a real city you want to visit?"
                
                # Check for empty or obvious placeholders in budget
                elif not budget or budget.strip().lower() in ["yy budget", "placeholder", "none", "null", "any"]:
                    is_valid = False
                    validation_error_msg = "It looks like the budget provided is invalid or a placeholder. Could you please specify your budget (e.g. ₹15,000 or $500)?"
                
                else:
                    # Run a quick check against the live weather API to verify city existence
                    print(f"Validating destination city '{destination}'...")
                    validation_result = get_weather(destination)
                    if "error" in validation_result:
                        # Check if it was a 404 City Not Found
                        if "404" in validation_result["error"] or "not found" in validation_result["error"].lower():
                            is_valid = False
                            validation_error_msg = f"I couldn't find a city named '{destination}'. Could you please double-check the spelling or specify another destination city?"
                        else:
                            # Log connection/API warnings without breaking flow
                            print(f"Warning: Destination validation skipped due to API connection issue: {validation_result['error']}")
                
                if not is_valid:
                    print(f"\nAgent: {validation_error_msg}\n")
                    # Append validation warning as assistant response to let the conversation continue
                    messages.append({
                        "role": "assistant",
                        "content": validation_error_msg
                    })
                    continue
                        
                # Now, generate the final plan based on the structured requirements
                print("Generating your personalized travel plan...")
                plan_text = run_agent(structured_data, client)
                
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
