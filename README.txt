Atlas CHAT-B20 — Stronger local Apex

B20 selects device-appropriate quantized models: Llama 3.2 1B on iPhone,
Qwen2.5 1.5B on capable Android phones, and Qwen2.5 3B on PC. A 7B PC profile
and a dedicated Qwen2.5 Coder profile are optional downloads in About Apex.
The active model is shown there. Atlas keeps the full chat locally while the
model sees a bounded 4K-token window plus a running summary of older turns.
Repetition handling and code-response checks are stricter; missing code is
reported rather than formatted as a successful snippet. Chat/memory schema v1
and older cached models are preserved. No cloud inference is used.

Atlas CHAT-B19 — Mobile UI and resume reliability

B19 gives phones a dedicated touch layout, a chat drawer, keyboard-aware
composer, and touch-visible actions. Returning to the app reloads the local
Apex runtime while retaining the active chat and unsent draft. Switching chats
stops an active reply before navigating.

B18 — Platinum / Graphite UI

B18 brings the approved design demo into the live app: navy, peach, and white;
Platinum light mode and Graphite dark mode; a persistent desktop sidebar;
streaming code panels; editable saved memory; and accessible dialogs.
Both app entry points share atlas-ui.css. Atlas-Classic.html preserves the
previous interface; Atlas-Design-Concept.html remains the standalone demo.
The model runtime and chat/memory storage schema are unchanged.

B17 historical model selection (superseded by B20)
-------------------------------------------------
Apex 7.3 previously tried:
1. SmolLM2-1.7B-Instruct q4f16
2. SmolLM2-360M q4f16 fallback
3. SmolLM2-360M q4f32 fallback

On devices without shader-f16:
1. SmolLM2-1.7B-Instruct q4f32
2. SmolLM2-360M q4f32 fallback

WHY
---
The 360M model could run quickly, but its responses were often:
- generic instead of answering the question
- parroting the system prompt
- repeating phrases
- explaining coding instead of producing code

B17 also:
- drastically shortens the system prompt
- adds task-specific routing for code / explanation / current-info / chat / creative requests
- lowers temperature
- adds frequency + repetition penalties
- interrupts obvious repetition loops
- gives code responses a larger output budget
- explicitly prevents fake "latest news" claims when Atlas is offline

IMPORTANT
---------
This quality build may require a ONE-TIME larger model download for SmolLM2 1.7B.
The existing 360M model remains available as fallback.
Chats/memory stay on Data Schema v1.
Canonical app filename remains Atlas-CHAT.html.
