# WorldForge

A Lumiverse (Spindle) extension that gives **each character its own living, self-expanding world**, built directly on Lumiverse's native **World Books** — and lets the AI grow it autonomously, Claude Code–style.

## The idea

Like a Minecraft world: only the "chunks" near the player exist at first, and the world reveals new ones as the player travels and acts — indefinitely. Here, every place, character, faction, and piece of lore is a **keyword-activated World Book entry**. Lumiverse's existing World Info pipeline injects the right entries when their keywords appear, so *keyword activation is the chunk-loading mechanism* — WorldForge never hand-injects anything into the prompt. It just maintains the entries, and they reveal themselves as the player engages.

Side characters are **first-class**. The character card is the protagonist, but every notable NPC gets its own tracked entry, keywords, and state. The agent advances them whether or not the player saw them — including recording **off-screen scenes** (two NPCs meeting, a faction's move) that happen entirely away from the protagonist and persist into later turns.

**Each character owns one dedicated WorldForge world book**, auto-created and attached to the card, shared across all chats with that character. Your own hand-authored world books are never touched — WorldForge only edits the book it created.

## How it works

1. **Grounding is automatic.** WorldForge's entries live in the character's attached world book, so the native World Info system activates and injects them by keyword during normal prompt assembly. No interceptor, no manual injection.

2. **Agentic expansion (after each reply, out-of-band).** Once a reply finishes, the world-engine **agent** runs with full tool access. It lists the tracked entities, generates the locations the player is approaching, creates/advances characters (on- and off-stage), records off-screen scenes between NPCs, updates factions and lore, and reorganizes freely. It loops over tool-call rounds until done. Its edits land before the *next* turn; the player never waits on it, and the visible chat is never touched.

### The agent's tools

`list_entities`, `read_entity`, `create_entity` (kind = location / character / faction / lore / event), `update_entity`, `delete_entity`, `set_player_location`, `set_character_presence` (on/off-stage), and `offscreen_scene` (record a development between NPCs away from the player, appended to each participant's entry plus a rolling event ledger).

Full Claude Code–style authority: create, edit, merge-by-rewrite, delete, reorganize. Oversight lives in the panel, not in caging the agent.

## The WorldForge panel

A drawer tab (also via `Ctrl/Cmd+K`):

- **Entities grouped by kind** — locations, characters (with on/off-stage flags), factions, lore, events. The player's current location is highlighted. Click any entry to read its keywords and content, edit it, or delete it.
- **Agent activity** — what the agent changed last turn.
- **Settings** — enable toggle, agent rounds-per-turn, timeout, and an optional steering directive (tone, standing instructions, recurring off-screen plots).
- **Reset world** — deletes *only* WorldForge's own book and tracked state; your other world books are left alone.

Operator-facing; none of it is shown to the player in the conversation.

## Caveats

- **Cost & latency.** Each turn fires a multi-round tool-calling agent generation on top of the reply. It runs *after* the visible reply (so it doesn't delay the player's first token), with reasoning disabled, but it adds tokens and a little background time, scaling with rounds-per-turn.
- **Per-turn, not retroactive.** Entries created this turn activate on the *next* one.
- **Provider tool support.** The agent uses function calling via `spindle.generate.raw`; use a tools-capable provider/model.
- **Keyword activation.** Entries reveal when their keywords appear in recent messages (the agent sets these). For always-on world rules, the agent can mark an entry constant.

## Permissions

| Permission | Why |
|---|---|
| `generation` | Run the agent's tool-calling generation |
| `chats` | Resolve the active chat → character |
| `chat_mutation` | Read the latest exchange to brief the agent (read-only) |
| `characters` | Read the character, attach the world book, record the owned-book id |
| `world_books` | Create and manage the character's dedicated world book and its entries |

It never writes messages into the chat.

## Layout

```
src/
  world.ts     World Book provisioning, per-character meta index, keyword helpers
  tools.ts     agent tool schemas + executors (entry CRUD, presence, off-screen scenes)
  agent.ts     multi-round tool-calling agent loop
  backend.ts   meta storage, book provisioning, post-turn trigger, frontend bridge
  frontend.ts  the WorldForge drawer tab
```

## Build & install

```bash
bun install
bun run build   # emits dist/backend.js and dist/frontend.js
```

Install via the Extensions panel (or `POST /api/v1/spindle/install`); pushing only `src/` also works (auto-build on install). Update the `author`/`github`/`homepage` fields in `spindle.json` before publishing.
