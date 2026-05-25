declare const spindle: import('lumiverse-spindle-types').SpindleAPI

import { WorldMeta, emptyMeta, metaPath, ensureWorldBook } from './world'
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

<<<<<<< HEAD
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
=======
async function characterForChat(chatId: string): Promise<{ id: string; name: string } | null> {
  const cached = chatChar.get(chatId)
  if (cached) {
    const c = await spindle.characters.get(cached)
    return c ? { id: c.id, name: c.name } : null
  }
  try {
    const chat = await spindle.chats.get(chatId)
    const cid = (chat as { character_id?: string } | null)?.character_id
    if (!cid) return null
    chatChar.set(chatId, cid)
    const c = await spindle.characters.get(cid)
>>>>>>> 0d0f5492af4f7c407b415a3674b10b3332595c29
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

<<<<<<< HEAD
async function runAgentForChat(chatId: string, reply: string, userId?: string) {
  if (!config.enabled || !reply.trim()) return
  const char = await characterForChat(chatId, userId)
=======
async function runAgentForChat(chatId: string, reply: string) {
  if (!config.enabled || !reply.trim()) return
  const char = await characterForChat(chatId)
>>>>>>> 0d0f5492af4f7c407b415a3674b10b3332595c29
  if (!char) return
  if (running.has(char.id)) return

  running.add(char.id)
  try {
    const meta = await loadMeta(char.id)
<<<<<<< HEAD
    await ensureWorldBook(meta, userId) // provision + attach the dedicated book
=======
    await ensureWorldBook(meta) // provision + attach the dedicated book
>>>>>>> 0d0f5492af4f7c407b415a3674b10b3332595c29

    const transcript = await buildTranscript(chatId, reply)
    const before = JSON.stringify(meta.entries)
    const signal = AbortSignal.timeout(config.agentTimeoutMs)

    const result = await runWorldAgent(meta, char.name, transcript, {
      maxRounds: config.maxRounds,
      directive: config.directive,
      signal,
<<<<<<< HEAD
      userId,
=======
>>>>>>> 0d0f5492af4f7c407b415a3674b10b3332595c29
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

<<<<<<< HEAD
spindle.on('GENERATION_ENDED', async (payload, userId) => {
=======
spindle.on('GENERATION_ENDED', async (payload) => {
>>>>>>> 0d0f5492af4f7c407b415a3674b10b3332595c29
  if (!config.enabled || !payload.chatId) return
  const chatId = payload.chatId
  if (payload.error) return dropObserver(chatId)
  const gt = payload.generationType
  if (gt === 'impersonate' || gt === 'quiet') return dropObserver(chatId)
  const obs = observers.get(chatId)
  const reply = (payload.content ?? obs?.content ?? '').trim()
  dropObserver(chatId)
<<<<<<< HEAD
  await runAgentForChat(chatId, reply, userId)
})

spindle.on('GENERATION_STOPPED', async (payload, userId) => {
=======
  await runAgentForChat(chatId, reply)
})

spindle.on('GENERATION_STOPPED', async (payload) => {
>>>>>>> 0d0f5492af4f7c407b415a3674b10b3332595c29
  if (!config.enabled || !payload.chatId) return
  const obs = observers.get(payload.chatId)
  const reply = (payload.content ?? obs?.content ?? '').trim()
  dropObserver(payload.chatId)
<<<<<<< HEAD
  await runAgentForChat(payload.chatId, reply, userId)
=======
  await runAgentForChat(payload.chatId, reply)
>>>>>>> 0d0f5492af4f7c407b415a3674b10b3332595c29
})

/* --------------------------- frontend bridge ----------------------- */

<<<<<<< HEAD
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
=======
async function activeCharacter(payloadCid?: string): Promise<{ id: string; name: string } | null> {
  if (payloadCid) {
    const c = await spindle.characters.get(payloadCid)
    return c ? { id: c.id, name: c.name } : null
  }
  const active = await spindle.chats.getActive()
  if (!active) return null
  return characterForChat(active.id)
}

/** Assemble a panel-friendly snapshot from meta + live entry content. */
async function snapshot(cid: string) {
>>>>>>> 0d0f5492af4f7c407b415a3674b10b3332595c29
  const meta = await loadMeta(cid)
  const entities = []
  for (const [id, e] of Object.entries(meta.entries)) {
    let content = ''
    let keys: string[] = []
    try {
<<<<<<< HEAD
      const entry = await spindle.world_books.entries.get(id, userId)
=======
      const entry = await spindle.world_books.entries.get(id)
>>>>>>> 0d0f5492af4f7c407b415a3674b10b3332595c29
      if (entry) {
        content = entry.content
        keys = entry.key
      }
    } catch {
      /* entry may have been deleted out from under us */
    }
    entities.push({ id, kind: e.kind, name: e.name, onstage: e.onstage, status: e.status, keys, content })
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
<<<<<<< HEAD
      const char = await activeCharacter(payload.characterId, userId)
=======
      const char = await activeCharacter(payload.characterId)
>>>>>>> 0d0f5492af4f7c407b415a3674b10b3332595c29
      if (!char) {
        spindle.sendToFrontend({ type: 'world', characterId: null, snapshot: null }, userId)
        break
      }
<<<<<<< HEAD
      spindle.sendToFrontend({ type: 'world', characterName: char.name, snapshot: await snapshot(char.id, userId) }, userId)
=======
      spindle.sendToFrontend({ type: 'world', characterName: char.name, snapshot: await snapshot(char.id) }, userId)
>>>>>>> 0d0f5492af4f7c407b415a3674b10b3332595c29
      break
    }

    case 'save_entity': {
      // Operator hand-edit of an entry's content/keywords.
<<<<<<< HEAD
      const char = await activeCharacter(payload.characterId, userId)
=======
      const char = await activeCharacter(payload.characterId)
>>>>>>> 0d0f5492af4f7c407b415a3674b10b3332595c29
      if (!char || !payload.entity?.id) break
      const meta = await loadMeta(char.id)
      const e = meta.entries[payload.entity.id]
      if (e) {
        const patch: Record<string, unknown> = {}
        if (typeof payload.entity.content === 'string') patch.content = payload.entity.content
        if (typeof payload.entity.name === 'string') {
          e.name = payload.entity.name
        }
<<<<<<< HEAD
        if (Object.keys(patch).length) await spindle.world_books.entries.update(payload.entity.id, patch, userId)
        await saveMeta(char.id, meta)
      }
      spindle.sendToFrontend({ type: 'world', characterName: char.name, snapshot: await snapshot(char.id, userId) }, userId)
=======
        if (Object.keys(patch).length) await spindle.world_books.entries.update(payload.entity.id, patch)
        await saveMeta(char.id, meta)
      }
      spindle.sendToFrontend({ type: 'world', characterName: char.name, snapshot: await snapshot(char.id) }, userId)
>>>>>>> 0d0f5492af4f7c407b415a3674b10b3332595c29
      break
    }

    case 'delete_entity': {
<<<<<<< HEAD
      const char = await activeCharacter(payload.characterId, userId)
=======
      const char = await activeCharacter(payload.characterId)
>>>>>>> 0d0f5492af4f7c407b415a3674b10b3332595c29
      if (!char || !payload.id) break
      const meta = await loadMeta(char.id)
      if (meta.entries[payload.id]) {
        try {
<<<<<<< HEAD
          await spindle.world_books.entries.delete(payload.id, userId)
=======
          await spindle.world_books.entries.delete(payload.id)
>>>>>>> 0d0f5492af4f7c407b415a3674b10b3332595c29
        } catch {
          /* already gone */
        }
        delete meta.entries[payload.id]
        await saveMeta(char.id, meta)
      }
<<<<<<< HEAD
      spindle.sendToFrontend({ type: 'world', characterName: char.name, snapshot: await snapshot(char.id, userId) }, userId)
=======
      spindle.sendToFrontend({ type: 'world', characterName: char.name, snapshot: await snapshot(char.id) }, userId)
>>>>>>> 0d0f5492af4f7c407b415a3674b10b3332595c29
      break
    }

    case 'reset_world': {
      // Detach + delete our book, wipe meta. Leaves the user's own books alone.
<<<<<<< HEAD
      const char = await activeCharacter(payload.characterId, userId)
=======
      const char = await activeCharacter(payload.characterId)
>>>>>>> 0d0f5492af4f7c407b415a3674b10b3332595c29
      if (!char) break
      const meta = await loadMeta(char.id)
      if (meta.worldBookId) {
        try {
<<<<<<< HEAD
          const c = await spindle.characters.get(char.id, userId)
          const remaining = (c?.world_book_ids ?? []).filter((b) => b !== meta.worldBookId)
          await spindle.characters.update(char.id, { world_book_ids: remaining, extensions: { worldforge: {} } }, userId)
          await spindle.world_books.delete(meta.worldBookId, userId)
=======
          const c = await spindle.characters.get(char.id)
          const remaining = (c?.world_book_ids ?? []).filter((b) => b !== meta.worldBookId)
          await spindle.characters.update(char.id, { world_book_ids: remaining, extensions: { worldforge: {} } })
          await spindle.world_books.delete(meta.worldBookId)
>>>>>>> 0d0f5492af4f7c407b415a3674b10b3332595c29
        } catch {
          /* best effort */
        }
      }
      await saveMeta(char.id, emptyMeta(char.id))
<<<<<<< HEAD
      spindle.sendToFrontend({ type: 'world', characterName: char.name, snapshot: await snapshot(char.id, userId) }, userId)
=======
      spindle.sendToFrontend({ type: 'world', characterName: char.name, snapshot: await snapshot(char.id) }, userId)
>>>>>>> 0d0f5492af4f7c407b415a3674b10b3332595c29
      break
    }
  }
})

function clampInt(v: unknown, min: number, max: number): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

/* ------------------------------- boot ------------------------------ */
;(async () => {
  await loadConfig()
  spindle.log.info('[worldforge] loaded (World Books mode)')
})()
