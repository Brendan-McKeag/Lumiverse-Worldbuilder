declare const spindle: import('lumiverse-spindle-types').SpindleAPI

import { WorldMeta, emptyMeta, metaPath, ensureWorldBook, readAwareness, isVisibleTo } from './world'
import { runWorldAgent } from './agent'

/* ------------------------------------------------------------------ *
 * WorldForge — backend (World Books backed)
 *
 * Each character owns a dedicated, auto-attached World Book. Because the
 * native World Info pipeline already injects keyword-activated entries from
 * the character's attached books, WorldForge does NOT inject anything into
 * the prompt itself — it just maintains the entries. That's the "chunk
 * loading": entries reveal themselves by keyword as the player engages.
 *
 * Per turn: after the reply, the world-engine agent runs out-of-band and
 * freely creates/edits/reorganizes entries and records off-screen scenes.
 * Each character has one persistent world across all their chats.
 * ------------------------------------------------------------------ */

interface Config {
  enabled: boolean
  maxRounds: number
  directive: string
  agentTimeoutMs: number
}

const DEFAULT_CONFIG: Config = { enabled: true, maxRounds: 6, directive: '', agentTimeoutMs: 60000 }
const CONFIG_PATH = 'config.json'

let config: Config = { ...DEFAULT_CONFIG }

const chatChar = new Map<string, string>()
const running = new Set<string>()
const observers = new Map<string, ReturnType<typeof spindle.generate.observe>>()

/* ----------------------------- storage ----------------------------- */

async function loadConfig() {
  config = await spindle.storage.getJson<Config>(CONFIG_PATH, { fallback: { ...DEFAULT_CONFIG } })
}
async function saveConfig() {
  await spindle.storage.setJson(CONFIG_PATH, config, { indent: 2 })
}
async function loadMeta(cid: string): Promise<WorldMeta> {
  return spindle.storage.getJson<WorldMeta>(metaPath(cid), { fallback: emptyMeta(cid) })
}
async function saveMeta(cid: string, meta: WorldMeta) {
  await spindle.storage.setJson(metaPath(cid), meta, { indent: 2 })
}

async function characterForChat(
  chatId: string,
  userId?: string,
): Promise<{ id: string; name: string } | null> {
  const cached = chatChar.get(chatId)
  if (cached) {
    const c = await spindle.characters.get(cached, userId)
    return c ? { id: c.id, name: c.name } : null
  }
  try {
    const chat = await spindle.chats.get(chatId, userId)
    const cid = (chat as { character_id?: string } | null)?.character_id
    if (!cid) return null
    chatChar.set(chatId, cid)
    const c = await spindle.characters.get(cid, userId)
    return c ? { id: c.id, name: c.name } : { id: cid, name: 'the character' }
  } catch {
    return null
  }
}

/* --------------------- post-turn world agent ----------------------- */

// The agent reconciles the world against the ENTIRE story to date, not a recent
// window — facts established anywhere in the history must be honored. A single
// safety valve bounds pathologically long stories (see clampTranscript): we keep
// the opening (where characters/places are first established) and the most recent
// turns, eliding only the middle, so early facts and current state both survive.
const MAX_TRANSCRIPT_CHARS = 120_000

async function buildTranscript(chatId: string, reply: string): Promise<string> {
  const lines: string[] = []
  try {
    const msgs = await spindle.chat.getMessages(chatId)
    for (const m of msgs) {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      if (!text.trim()) continue
      lines.push(`${m.role === 'user' ? 'PLAYER' : 'CHARACTER'}:\n${text.trim()}`)
    }
  } catch {
    /* ignore */
  }
  // Ensure the just-generated reply is the final CHARACTER turn. It may not be
  // persisted in getMessages yet; only append it if the history doesn't end on it.
  const r = reply.trim()
  if (r && !(lines.length && lines[lines.length - 1].includes(r))) {
    lines.push(`CHARACTER:\n${r}`)
  }
  return clampTranscript(lines.join('\n\n').trim())
}

// Keep the whole story when it fits; otherwise preserve head + tail and elide the
// middle. The opening turns establish the durable facts (species, names, places)
// the agent must not contradict, and the tail carries current state.
function clampTranscript(t: string): string {
  if (t.length <= MAX_TRANSCRIPT_CHARS) return t
  const head = Math.floor(MAX_TRANSCRIPT_CHARS * 0.4)
  const tail = MAX_TRANSCRIPT_CHARS - head
  return `${t.slice(0, head)}\n\n[… middle of the story elided for length; opening and recent turns shown in full …]\n\n${t.slice(-tail)}`
}

// The character card is the canonical source of truth for the protagonist's
// own basic facts. The agent never sees it otherwise, which is how a deer ends
// up recorded as a rabbit. Read whatever standard card fields are present
// (defensively — field availability varies) and cap length to stay economical.
function buildCardContext(char: unknown): string {
  const c = (char ?? {}) as Record<string, unknown>
  const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
  const fields: [string, unknown, number][] = [
    ['Name', c.name, 200],
    ['Description', c.description, 2000],
    ['Personality', c.personality, 1000],
    ['Scenario', c.scenario, 1000],
    ['Opening', c.first_mes, 1500],
  ]
  return fields
    .filter(([, v]) => typeof v === 'string' && (v as string).trim())
    .map(([k, v, n]) => `${k}: ${cap((v as string).trim(), n)}`)
    .join('\n\n')
}

async function runAgentForChat(chatId: string, reply: string, userId?: string) {
  if (!config.enabled || !reply.trim()) return
  const char = await characterForChat(chatId, userId)
  if (!char) return
  if (running.has(char.id)) return

  running.add(char.id)
  try {
    const meta = await loadMeta(char.id)
    await ensureWorldBook(meta, userId) // provision + attach the dedicated book

    const transcript = await buildTranscript(chatId, reply)
    const fullChar = await spindle.characters.get(char.id, userId).catch(() => null)
    const cardContext = buildCardContext(fullChar)
    const before = JSON.stringify(meta.entries)
    const signal = AbortSignal.timeout(config.agentTimeoutMs)

    const result = await runWorldAgent(meta, char.name, transcript, {
      maxRounds: config.maxRounds,
      directive: config.directive,
      signal,
      userId,
      cardContext,
    })

    await saveMeta(char.id, meta)

    const changed = JSON.stringify(meta.entries) !== before || result.toolCalls.length > 0
    spindle.sendToFrontend({
      type: 'world_changed',
      characterId: char.id,
      entityCount: Object.keys(meta.entries).length,
      rounds: result.rounds,
      edits: result.toolCalls.length,
      note: result.finalNote,
    })
    spindle.log.info(
      `[worldforge] ${char.name}: ${result.toolCalls.length} edits / ${result.rounds} rounds${
        changed ? '' : ' (no-op)'
      }`,
    )
  } catch (err) {
    const msg = err instanceof Error && err.name === 'AbortError' ? 'agent timed out' : String(err)
    spindle.log.error(`[worldforge] agent failed: ${msg}`)
  } finally {
    running.delete(char.id)
  }
}

function ensureObserver(chatId: string) {
  if (!observers.has(chatId)) observers.set(chatId, spindle.generate.observe(chatId))
  return observers.get(chatId)!
}
function dropObserver(chatId: string) {
  const o = observers.get(chatId)
  if (o) {
    o.dispose()
    observers.delete(chatId)
  }
}

spindle.on('GENERATION_STARTED', (payload) => {
  if (!config.enabled || !payload.chatId) return
  ensureObserver(payload.chatId)
})

spindle.on('GENERATION_ENDED', async (payload, userId) => {
  if (!config.enabled || !payload.chatId) return
  const chatId = payload.chatId
  if (payload.error) return dropObserver(chatId)
  const gt = payload.generationType
  if (gt === 'impersonate' || gt === 'quiet') return dropObserver(chatId)
  const obs = observers.get(chatId)
  const reply = (payload.content ?? obs?.content ?? '').trim()
  dropObserver(chatId)
  await runAgentForChat(chatId, reply, userId)
})

spindle.on('GENERATION_STOPPED', async (payload, userId) => {
  if (!config.enabled || !payload.chatId) return
  const obs = observers.get(payload.chatId)
  const reply = (payload.content ?? obs?.content ?? '').trim()
  dropObserver(payload.chatId)
  await runAgentForChat(payload.chatId, reply, userId)
})

/* --------------------------- frontend bridge ----------------------- */

async function activeCharacter(
  payloadCid?: string,
  userId?: string,
): Promise<{ id: string; name: string } | null> {
  if (payloadCid) {
    const c = await spindle.characters.get(payloadCid, userId)
    return c ? { id: c.id, name: c.name } : null
  }
  const active = await spindle.chats.getActive(userId)
  if (!active) return null
  return characterForChat(active.id, userId)
}

/** Assemble a panel-friendly snapshot from meta + live entry content. */
async function snapshot(cid: string, userId?: string) {
  const meta = await loadMeta(cid)
  const entities = []
  for (const [id, e] of Object.entries(meta.entries)) {
    let content = ''
    let keys: string[] = []
    try {
      const entry = await spindle.world_books.entries.get(id, userId)
      if (entry) {
        content = entry.content
        keys = entry.key
      }
    } catch {
      /* entry may have been deleted out from under us */
    }
    entities.push({ id, kind: e.kind, name: e.name, onstage: e.onstage, status: e.status, private: Boolean(e.private), audience: e.audience ?? [], keys, content })
  }
  return {
    characterId: cid,
    worldBookId: meta.worldBookId,
    currentLocation: meta.currentLocation,
    entities,
  }
}

spindle.onFrontendMessage(async (payload: any, userId) => {
  switch (payload?.type) {
    case 'get_config':
      spindle.sendToFrontend({ type: 'config', config }, userId)
      break

    case 'set_config':
      config = {
        enabled: Boolean(payload.config?.enabled ?? config.enabled),
        maxRounds: clampInt(payload.config?.maxRounds ?? config.maxRounds, 1, 20),
        directive: String(payload.config?.directive ?? config.directive),
        agentTimeoutMs: clampInt(payload.config?.agentTimeoutMs ?? config.agentTimeoutMs, 5000, 300000),
      }
      await saveConfig()
      spindle.sendToFrontend({ type: 'config', config }, userId)
      break

    case 'get_world': {
      const char = await activeCharacter(payload.characterId, userId)
      if (!char) {
        spindle.sendToFrontend({ type: 'world', characterId: null, snapshot: null }, userId)
        break
      }
      spindle.sendToFrontend({ type: 'world', characterName: char.name, snapshot: await snapshot(char.id, userId) }, userId)
      break
    }

    case 'save_entity': {
      // Operator hand-edit of an entry's content/keywords.
      const char = await activeCharacter(payload.characterId, userId)
      if (!char || !payload.entity?.id) break
      const meta = await loadMeta(char.id)
      const e = meta.entries[payload.entity.id]
      if (e) {
        const patch: Record<string, unknown> = {}
        if (typeof payload.entity.content === 'string') patch.content = payload.entity.content
        if (typeof payload.entity.name === 'string') {
          e.name = payload.entity.name
        }
        if (Object.keys(patch).length) await spindle.world_books.entries.update(payload.entity.id, patch, userId)
        await saveMeta(char.id, meta)
      }
      spindle.sendToFrontend({ type: 'world', characterName: char.name, snapshot: await snapshot(char.id, userId) }, userId)
      break
    }

    case 'delete_entity': {
      const char = await activeCharacter(payload.characterId, userId)
      if (!char || !payload.id) break
      const meta = await loadMeta(char.id)
      if (meta.entries[payload.id]) {
        try {
          await spindle.world_books.entries.delete(payload.id, userId)
        } catch {
          /* already gone */
        }
        delete meta.entries[payload.id]
        await saveMeta(char.id, meta)
      }
      spindle.sendToFrontend({ type: 'world', characterName: char.name, snapshot: await snapshot(char.id, userId) }, userId)
      break
    }

    case 'reset_world': {
      // Detach + delete our book, wipe meta. Leaves the user's own books alone.
      const char = await activeCharacter(payload.characterId, userId)
      if (!char) break
      const meta = await loadMeta(char.id)
      if (meta.worldBookId) {
        try {
          const c = await spindle.characters.get(char.id, userId)
          const remaining = (c?.world_book_ids ?? []).filter((b) => b !== meta.worldBookId)
          await spindle.characters.update(char.id, { world_book_ids: remaining, extensions: { worldforge: {} } }, userId)
          await spindle.world_books.delete(meta.worldBookId, userId)
        } catch {
          /* best effort */
        }
      }
      await saveMeta(char.id, emptyMeta(char.id))
      spindle.sendToFrontend({ type: 'world', characterName: char.name, snapshot: await snapshot(char.id, userId) }, userId)
      break
    }

    case 'reclassify_all_public': {
      // Recovery action for worlds where the agent overzealously tagged
      // entries as private. Walks every tracked entry and rewrites its
      // awareness to public, leaving content untouched. New entries the
      // agent creates afterward follow the corrected prompt rules.
      const char = await activeCharacter(payload.characterId, userId)
      if (!char) break
      const meta = await loadMeta(char.id)
      let changed = 0
      for (const [id, e] of Object.entries(meta.entries)) {
        if (!e.private) continue
        try {
          const entry = await spindle.world_books.entries.get(id, userId)
          if (!entry) continue
          const current = (entry.extensions?.['worldforge'] as { kind?: string } | undefined) ?? {}
          await spindle.world_books.entries.update(
            id,
            { extensions: { worldforge: { kind: current.kind ?? e.kind, private: false, audience: [] } } },
            userId,
          )
          e.private = false
          e.audience = []
          e.updatedAt = Date.now()
          changed++
        } catch {
          /* skip missing entries */
        }
      }
      meta.updatedAt = Date.now()
      await saveMeta(char.id, meta)
      spindle.log.info(`[worldforge] reclassified ${changed} entries as public for ${char.id}`)
      spindle.sendToFrontend(
        { type: 'world', characterName: char.name, snapshot: await snapshot(char.id, userId), note: `Reclassified ${changed} entries as public.` },
        userId,
      )
      break
    }
  }
})

function clampInt(v: unknown, min: number, max: number): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

/* ----------------- knowledge-boundary enforcement ------------------ *
 * Runs before world-info activation. For the character speaking THIS turn,
 * disable every candidate entry that is private knowledge whose audience
 * doesn't include them — so a character can never surface a conversation or
 * event it never witnessed or was told about. "disabled" wins against
 * everything downstream, so this is a hard guarantee, not a hint.
 *
 * The active character is ctx.characterId. We treat it as the protagonist
 * when it equals the chat's own character card; off-stage NPC "scenes" use
 * a different characterId, and their private entries are keyed to them.
 * ------------------------------------------------------------------ */
spindle.registerWorldInfoInterceptor(async (ctx) => {
  // WorldForge entries are disabled AT REST (see createEntry), so when this
  // extension isn't running they inject nothing and the prompt is normal. Our
  // job here, while running, is to vote `enabled` for the entries the active
  // character is allowed to see — which un-gates them for normal keyword
  // activation (chunk-loading), NOT force-inject them. Knowledge boundaries are
  // enforced by simply NOT enabling private entries the character isn't privy to.
  if (!config.enabled) return // panel toggle off -> leave everything at rest (off)
  const active = ctx.characterId
  if (!active) return

  // The active speaker is the chat's own character card, so entries whose
  // audience contains the PROTAGONIST token are visible to them.
  const isProtagonist = true

  const enabled: string[] = []
  for (const entry of ctx.entries) {
    const aw = readAwareness(entry.extensions)
    if (!aw) continue // not a WorldForge entry — leave it alone
    // Fail-open: an empty-audience private entry is almost certainly a tagging
    // mistake; treat it as public rather than hide canon from everyone.
    const visible =
      !aw.private || !aw.audience || aw.audience.length === 0 || isVisibleTo(aw, active, isProtagonist)
    if (visible) enabled.push(entry.id)
  }
  return enabled.length ? { enabled } : undefined
}, 50)

/* --------------------- one-time entry migration -------------------- *
 * Older worlds created their entries enabled (disabled:false), which meant they
 * kept injecting through the native pipeline even when this extension was off.
 * On boot (which only happens while the extension is running), flip every
 * WorldForge-owned entry to disabled-at-rest so the on/off guarantee holds. The
 * interceptor re-enables the visible ones each generation. Idempotent.
 * ------------------------------------------------------------------ */
async function migrateEntriesToDisabledAtRest() {
  try {
    const { data: books } = await spindle.world_books.list({ limit: 1000 })
    let flipped = 0
    for (const book of books) {
      if (book.metadata?.worldforge !== true) continue
      const { data: entries } = await spindle.world_books.entries.list(book.id, { limit: 1000 })
      for (const e of entries) {
        if (!readAwareness(e.extensions) || e.disabled) continue
        await spindle.world_books.entries.update(e.id, { disabled: true })
        flipped++
      }
    }
    if (flipped) spindle.log.info(`[worldforge] migrated ${flipped} entr(ies) to disabled-at-rest`)
  } catch (err) {
    spindle.log.error(`[worldforge] entry migration failed: ${String(err)}`)
  }
}

/* ------------------------------- boot ------------------------------ */
;(async () => {
  await loadConfig()
  await migrateEntriesToDisabledAtRest()
  spindle.log.info('[worldforge] loaded (World Books mode)')
})()
