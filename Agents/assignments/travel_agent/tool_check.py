import os
from pathlib import Path
from dotenv import load_dotenv
import json
from pprint import pprint

# Load environment variables first
env_path = Path(__file__).parent / ".env"
load_dotenv(dotenv_path=env_path)

# Import the live tools and functions from our multi_tool script
from multi_tool import get_weather, search_places, calculate_budget

def run_weather_check():
    print("\n--- Test get_weather ---")
    city = input("Enter city name (e.g. Bangalore, Chennai, Kyoto): ").strip()
    if not city:
        print("Error: City name cannot be empty.")
        return
        
    print(f"Executing get_weather('{city}')...")
    result = get_weather(city)
    print("\nResult:")
    pprint(result)

def run_places_check():
    print("\n--- Test search_places ---")
    city = input("Enter city name (e.g. Bangalore, Chennai, Tokyo): ").strip()
    category = input("Enter category (e.g. historical, food, nature, shopping): ").strip()
    if not city or not category:
        print("Error: City and Category cannot be empty.")
        return
        
    print(f"Executing search_places('{city}', '{category}')...")
    result = search_places(city, category)
    print("\nResult:")
    pprint(result)

def run_budget_check():
    print("\n--- Test calculate_budget ---")
    try:
        trans_cost = float(input("Enter transportation cost: ") or 0)
        accom_cost = float(input("Enter accommodation cost: ") or 0)
        food_cost = float(input("Enter food cost: ") or 0)
        activ_cost = float(input("Enter activities cost: ") or 0)
    except ValueError:
        print("Error: All costs must be numeric values.")
        return
        
    print(f"Executing calculate_budget({trans_cost}, {accom_cost}, {food_cost}, {activ_cost})...")
    result = calculate_budget(trans_cost, accom_cost, food_cost, activ_cost)
    print("\nResult:")
    pprint(result)

def main():
    while True:
        print("\n==============================================")
        print("           TOOL EXECUTION DIAGNOSTICS         ")
        print("==============================================")
        print("1. Test Weather Tool (get_weather)")
        print("2. Test Attractions Tool (search_places)")
        print("3. Test Budget Tool (calculate_budget)")
        print("4. Exit")
        print("==============================================")
        
        choice = input("Select an option (1-4): ").strip()
        
        if choice == "1":
            run_weather_check()
        elif choice == "2":
            run_places_check()
        elif choice == "3":
            run_budget_check()
        elif choice == "4" or choice.lower() in ["exit", "quit"]:
            print("Goodbye!")
            break
        else:
            print("Invalid selection. Please choose an option between 1 and 4.")

if __name__ == "__main__":
    main()
