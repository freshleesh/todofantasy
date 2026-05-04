# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working agreement

**결정 사항을 나열했으면, 사용자가 답하기 전까지는 구현을 시작하지 않는다.** A~G 같은 항목별 질문을 던졌다면 그건 정보가 아니라 blocking checkpoint다. 동일 메시지 재전송이나 짧은 동의("ㅇㅇ", "ㄱ" 등)는 묵시적 합의로 해석하지 말 것 — 모호함 신호로 보고 한 줄 재확인. 부득이 추천안대로 진행해야 하면 응답 첫 줄에 "확인 못 받았으니 추천안대로 진행, 다르면 멈춰주세요"를 명시.

## Project

Todo Fantassy — a single-page Korean-language RPG-themed todo app. The user inputs mundane tasks; Gemini rewrites them as medieval-fantasy quests **and assigns a difficulty (상/중/하)**. Completing quests grants XP, levels, and probabilistic equipment drops (also AI-generated). UI copy and prompts are in Korean — preserve that when editing user-visible strings.

## Running

Static frontend (no build) + a single Cloudflare Pages Function (`functions/api/gemini.js`) that proxies Gemini.

- **Local frontend-only iteration**: `python3 -m http.server` works for everything except real Gemini calls (the proxy isn't running). Use `test_app.py` (Playwright + mocked Gemini) to exercise the full UI flow.
- **Local with real proxy**: `npx wrangler pages dev .` (needs `.dev.vars` with `GEMINI_API_KEY=...`). Serves both static files and the function.
- **Production**: Cloudflare Pages auto-deploys from the GitHub `master` branch; `GEMINI_API_KEY` set in the Pages project's environment variables.
- **Tests**: `.venv/bin/python test_app.py` — spins up a local http.server, intercepts `/api/gemini` with canned responses, walks onboarding → quest → drop → equip → level-up, dumps screenshots into `test_screenshots/`.

## Architecture

Plain `<script>`-tag files with no module system — load order in `index.html` matters: `prompts.js` defines prompt globals (`JOB_TRANSFORM_PROMPT`, `buildQuestPrompt`, `buildEquipmentPrompt`, `SLOT_NAMES_KO`), then `app.js` consumes them.

- **`app.js`** — everything: state, game math, Gemini calls, rendering, event wiring. Single top-level `state` object mirrored to localStorage under `STORAGE_KEY = 'todofantassy_v2'`. Sections are commented (`// ── Constants ──`, `// ── Game Math ──`, etc.) — keep that organization when adding code.
- **`prompts.js`** — all LLM prompts. The two task-specific ones are functions that close over `jobFantasy` so the user's fantasy class is woven into every generation.
- **`style.css`** — parchment/medieval theme; `:root` custom properties are the single source of truth for colors.

### State shape

```
state = {
  character: {
    jobInput, jobFantasy,                       // onboarding
    level, xp, stats: {str, luk, int},          // progression
    pendingStatPoints,                          // unspent on level-up
    inventory: [item],                          // unequipped
    equipped: { head, body, legs, feet, hands, leftHand, rightHand },
    questSlots: { available, lastRecoveredAt }, // 3 max, time-gated
  },
  quests: [{ id, original, fantasy, difficulty, done }],
}
item = { id, name, slot, stats:{str,luk,int}, uniqueEffect, rarity:'normal'|'unique' }
```

### Game loop (where the rules live)

All tunable game math is in the constants block at the top of `app.js`:

- **Quest registration consumes a slot** (`consumeQuestSlot`). Slots regenerate at `slotCooldownMs()` = `max(20min, 120min - str×5min)`. Recovery is computed lazily from `lastRecoveredAt` on every `recoverQuestSlots()` call (run by render-tick `setInterval` and on user actions) — no background timers move state on their own.
- **Completing a quest** (`completeQuest`): grants `XP_BY_DIFFICULTY[difficulty] × (1 + int×INT_XP_BONUS)`, then rolls `rollDrop()` (luck-modified drop rate, then luck-modified unique rate, then random slot). On a drop, makes a *second* Gemini call (`generateEquipment`) to AI-generate the item. Multi-level-ups are queued as `pendingStatPoints` and the modal is reopened.
- **Total stats** = base + sum of equipped items (`totalStats()`). Always recompute, never cache.

### Rendering

Full re-render on every state change via `renderAll()` (delegates to per-section renderers). Event wiring is delegation on container elements (`#questList`, `#inventoryList`, `#equipmentSlots`) — never per-item handlers. The 1-second `setInterval` in `init()` only re-renders the character panel for the slot countdown; it returns early before onboarding is complete.

## Gemini API

Frontend never sees the key. Flow: `app.js callGemini()` → POST `/api/gemini` → `functions/api/gemini.js` → `gemini-2.5-flash:generateContent` with `env.GEMINI_API_KEY`.

The proxy enforces:
- **Origin check** — only requests whose `Origin` matches the same host pass (blocks direct API abuse from elsewhere)
- **Per-IP rate limit** — module-scope `Map` keyed by `CF-Connecting-IP`, 20 req/min/IP. Lives in the isolate so it's not perfect across cold starts, but combined with the Gemini free-tier daily quota it's enough for hobby scale.

Two structured calls use `responseMimeType: "application/json"` and `JSON.parse` the result — keep that pattern when adding new structured prompts (and validate the parsed shape before trusting it, like `transformQuest` does for `difficulty`). The model string lives in **two places**: `gemini-2.5-flash` is hardcoded in `functions/api/gemini.js` — update there when changing models, not in `app.js`.

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
