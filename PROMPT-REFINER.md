---
name: prompt-refiner
description: Fundamental guidance for any programming request. Use this skill whenever a task involves coding, refactoring, or system design so the agent remembers to: always use a CLI (Codex first, Claude only when Codex is unavailable); review the human’s instructions and refine them into the optimal prompt before any work; start complex/abstract work by querying a deep high-reasoning model for a step-by-step plan; then delegate implementation to a faster, lower-reasoning model; and insist on TDD plus well-separated code (files usually under 200 LoC).
---

# Prompt Refiner

## When to use this skill
- Trigger this skill for any request involving programming work, refactoring, architecture, or configuration automation.
- If the work is mostly documentation, research, or non-programming craft, you may skip the coding-specific requirements but still keep this skill handy in case the scope shifts.
- Always start by carefully reviewing the human’s instructions, distilling their intent, filling missing details, and reformulating them into the clearest, most efficient prompt before launching any CLI runs.

## Programming workflow
1. **CLI-first**: Always run the work through a CLI. The preferred CLI is Codex. If Codex cannot be reached, fallback to Claude. Never edit code manually; orchestrate the CLI runs, review the output, and summarize the results.
2. **Model sequencing**: For any complex or abstract task, begin by querying a deep high-reasoning model (e.g., `gpt-5.4` or another nominated high-effort model) and explicitly ask it for a detailed, step-by-step plan before any code is touched. Once the plan is locked in and reviewed, switch to a faster, lower-reasoning model (e.g., `gpt-5.1-codex-mini`, `gpt-5.3-codex`, or similar) to actually run the CLI and implement the work.
3. **TDD-first**: In every coding cycle, ask the CLI to follow Test-Driven Development whenever possible: write (or update) tests before implementing behavioral changes, run the tests, then deliver the minimal passing code. If a requested change cannot be easily testable, explain why before coding.
4. **Structure & size**: Demand a reasonable code structure. Break the work into logical files and modules. Whenever practical, keep each file under 200 lines of code—if a file must exceed that, justify why the logic cannot be split further. Favor small helper files over long monoliths.

## Communication guidelines
- Before launching CLI runs, mention which models you are using for the plan and the implementation, so downstream agents or future sessions know the strategy.
- After the CLI completes, summarize what tests were added/updated, how they prove correctness, and whether TDD was respected.
- If any part of the plan changes (e.g., added steps, discovered blockers), rerun the high-reasoning planning query to keep the documented strategy accurate.
