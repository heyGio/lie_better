# Web Game Structure Merge (README + develop-web-game/SKILL)

Original sources merged:
- `/Users/martin/lie_better/README.md`
- `/Users/martin/.codex/skills/develop-web-game/SKILL.md`

## Goal
Use the existing Next.js game codebase, but keep a reliable web-game iteration loop inspired by `develop-web-game`:
- small changes
- deterministic test actions
- screenshot/state checks
- tight debug loop

## Imported Structure
- `public/assets/game.png`
- `public/assets/game-small.svg`
- `tools/develop-web-game/scripts/web_game_playwright_client.js`
- `tools/develop-web-game/references/action_payloads.json`

## Project-Specific Workflow
1. Implement one small feature at a time in `/Users/martin/lie_better/app`.
2. Keep game loop behaviors observable in UI and API logs.
3. Run quality checks:
   - `npm run lint`
   - `npm run build`
4. Use the imported Playwright client for browser action bursts when needed:
   - Script: `tools/develop-web-game/scripts/web_game_playwright_client.js`
   - Payload examples: `tools/develop-web-game/references/action_payloads.json`

## Suggested Runtime Variables
```bash
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export WEB_GAME_CLIENT="/Users/martin/lie_better/tools/develop-web-game/scripts/web_game_playwright_client.js"
export WEB_GAME_ACTIONS="/Users/martin/lie_better/tools/develop-web-game/references/action_payloads.json"
```

## Notes
- This repo stays on Next.js App Router + API routes (no architecture reset).
- Imported assets are now available through `/assets/*` from `public/`.
- The current TV feed UI already uses `/assets/game-small.svg` as a visual placeholder.
