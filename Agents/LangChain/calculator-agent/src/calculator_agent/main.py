from pathlib import Path
from dotenv import load_dotenv
from .agent import run_agent

env_path = Path(__file__).resolve().parent / ".env"
load_dotenv(dotenv_path=env_path)
load_dotenv()

def main():
    print("This is a calculator agent. Ask simple math questions")
    user_input = input("You: ")

    answer = run_agent(user_input)
    print(answer)


if __name__ == "__main__":
    main()
