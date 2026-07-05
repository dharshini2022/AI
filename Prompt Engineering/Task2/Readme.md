# Assignment 2 – Prompt Security & Caching Refactor

## Objective

Refactor the existing HR Assistant prompt to:

- Separate static and dynamic prompt components.
- Improve prompt caching efficiency.
- Protect sensitive information from prompt injection attacks.
- Strengthen the prompt with security best practices.

---

# Original Problem

The original prompt had two major issues:

1. **Performance**
   - Dynamic employee information was mixed with static instructions.
   - This reduced prompt caching efficiency because the entire prompt changed for every request.

2. **Security**
   - Sensitive information (employee password) was included in the prompt.
   - A malicious user could attempt prompt injection or prompt leakage to expose confidential information.

---

# Solution Overview

The refactored design consists of three major improvements:

## 1. Prompt Segmentation

The prompt was divided into:

- Static (cacheable) instructions
- Dynamic employee context
- User query

This enables efficient reuse of the static prompt while keeping employee-specific information separate.

---

## 2. Prompt Caching

The static system prompt contains:

- Assistant role
- Response guidelines
- Security rules

Because this content rarely changes, it can be cached and reused across requests.

Only the following are supplied dynamically:

- Employee information
- Leave policy
- HR annotations
- User query

A TTL (Time-To-Live) or cache invalidation mechanism ensures updated HR policies are reflected when changes occur.

---

## 3. Security Refactor

The following security improvements were implemented:

- Removed employee passwords from the prompt.
- Added strict security rules.
- Prevented prompt injection attacks.
- Prevented prompt leakage.
- Applied the Principle of Least Privilege.
- Restricted responses to official leave policies only.

---


# Key Improvements

| Area | Original Prompt | Refactored Prompt |
|--------|-----------------|-------------------|
| Prompt Structure | Mixed static and dynamic content | Clearly separated |
| Caching | Inefficient | Static prompt cacheable |
| Sensitive Data | Password included | Password removed |
| Prompt Injection | Vulnerable | Security rules added |
| Prompt Leakage | Possible | Explicitly prevented |
| Authorization | Implicit | Handled outside the LLM |
| Maintainability | Low | Modular prompt structure |

---

# Conclusion

The refactored prompt improves both **performance** and **security** by separating cacheable instructions from dynamic employee data, removing sensitive information, and introducing explicit safeguards against prompt injection and prompt leakage attacks. This design follows modern prompt engineering best practices and is more suitable for production-grade AI applications.