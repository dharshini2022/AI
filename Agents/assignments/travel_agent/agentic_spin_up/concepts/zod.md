## zod
- Zod acts here like a json validator.
- It valides a tool input schema

## Example

```
LLM generates invalid arguments
(e.g., passes "ten" instead of number 10, or omits a required field)
                     │
                     ▼
             Zod Schema Validation
                     │
            [ Validation Fails ]
                     │
                     ▼
          Throws a `ZodError`
                     │
                     ▼
LangChain catches the error & formats it as a Tool Error:
"Invalid tool arguments: Expected number, received string at 'num_days'"
                     │
                     ▼
      Error sent back to LLM in the next turn
                     │
                     ▼
     LLM reads the error and corrects itself!

``` 
