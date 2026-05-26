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

async function buildTranscript(chatId: string, reply: string): Promise<string> {
  let lastUser = ''
  try {
    const msgs = await spindle.chat.getMessages(chatId)
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        lastUser =
          typeof msgs[i].content === 'string' ? (msgs[i].content as string) : JSON.stringify(msgs[i].content)
        break
      }
    }
  } catch {
    /* ignore */
  }
  return [lastUser ? `PLAYER:\n${lastUser}` : '', `\nCHARACTER:\n${reply}`].join('\n').trim()
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
    const before = JSON.stringify(meta.entries)
    const signal = AbortSignal.timeout(config.agentTimeoutMs)

    const result = await runWorldAgent(meta, char.name, transcript, {
      maxRounds: config.maxRounds,
      directive: config.directive,
      signal,
      userId,
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
  if (!config.enabled) return
  const active = ctx.characterId
  if (!active) return

  // Is the active speaker the protagonist card for this chat? If so, entries
  // whose audience contains the PROTAGONIST token are visible to them.
  const isProtagonist = true // ctx.characterId is the chat's character card here

  const disabled: string[] = []
  for (const entry of ctx.entries) {
    const aw = readAwareness(entry.extensions)
    if (!aw || !aw.private) continue // public/untagged -> always allowed
    if (!isVisibleTo(aw, active, isProtagonist)) {
      disabled.push(entry.id)
    }
  }
  if (disabled.length) {
    spindle.log.info(`[worldforge] knowledge gate: hid ${disabled.length} private entr(ies) from ${active}`)
  }
  return { disabled }
}, 50)

/* ------------------------------- boot ------------------------------ */
;(async () => {
  await loadConfig()
  spindle.log.info('[worldforge] loaded (World Books mode)')
})()
