# Prompt Processing Workflow

## 1. Cache the Static Prompt

The application loads the **static system prompt** once and stores it using the LLM's **prompt-prefix cache**.

### Benefits

- Reduces prompt processing time.
- Reduces repeated token transmission.
- Lowers inference cost.
- Ensures consistent behavior across all requests.
- Improves response latency for repeated interactions.

---

## 2. Embed & Store the Static Prompt 

If the application manages multiple prompt templates (e.g., HR, Finance, IT Support), the static prompts can also be:

- Converted into vector embeddings.
- Stored in a Vector Database.
- Retrieved semantically based on the application context.

> **Note:** This approach is used for **prompt template selection** and is **independent of native LLM prompt-prefix caching**.

### Example Use Cases

| Assistant | Prompt Template |
|-----------|-----------------|
| HR Assistant | Leave policies and HR guidelines |
| Finance Assistant | Expense and reimbursement policies |
| IT Support Assistant | Troubleshooting and access policies |

---

## 3. Query the LLM with Dynamic Context

For every employee request, the application performs the following steps:

1. Retrieve the cached static prompt.
2. Fetch the latest employee information.
3. Retrieve the applicable leave policy.
4. Load any current HR annotations.
5. Append the employee's question.
6. Send the combined prompt to the LLM.

### Request Flow

```text
         Cached Static Prompt
                  +
         Employee Context
                  +
       Current Leave Policy
                  +
         Current HR Notes
                  +
          User Question
                  │
                  ▼
                LLM
                  │
                  ▼
          Generated Response
```

### Benefits

- Employee information is always current.
- Policy updates are reflected immediately.
- Only the minimum required dynamic data is transmitted.
- Maintains personalization while maximizing cache reuse.

---

## 4. Cache Freshness

Because leave policies and HR annotations may change over time, cached data must be managed carefully.

### Best Practices

- Apply a **Time-To-Live (TTL)** to cached policy-related data if it is cached separately.
- Invalidate the cache whenever HR publishes updated policies or guidance.
- Always retrieve the latest employee-specific information before invoking the LLM.
- Never cache sensitive employee-specific runtime data across users.

### Outcome

This approach balances:

- High performance
- Low latency
- Reduced token usage
- Up-to-date policy information
- Secure handling of employee-specific data

---

# Overall Workflow

```text
                 ┌──────────────────────────┐
                 │  Static System Prompt    │
                 │   (Cached Once)          │
                 └─────────────┬────────────┘
                               │
                      Prompt Prefix Cache
                               │
                               ▼
               Retrieve Dynamic Employee Data
                               │
                               ▼
               Retrieve Current Leave Policy
                               │
                               ▼
                Retrieve Current HR Notes
                               │
                               ▼
                  Append User Question
                               │
                               ▼
                    Construct Final Prompt
                               │
                               ▼
                             LLM
                               │
                               ▼
                     Employee Response
```