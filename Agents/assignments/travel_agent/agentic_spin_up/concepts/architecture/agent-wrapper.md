# Agent.ts

- It is a sub-agent wrapper class around the LangChain Agent. It is used to create a new agent that can be used to perform a specific task.
- Agent creation happens using LangChain's create_agent method. But Agent wrapper class provides customisation on how the agent's input spec be passed, how the agent's tools be invoked, how the agent's memory be managed etc.

## What work the Agent Wrapper does
## Record in memory storage
- refer to memory-management.md

## send()
- removes subagent invokation boilerplate code

## JSON Parses
- removes string quotes from the Agent's response

## SPEC Construction
- converts the agent spec to system prompt.