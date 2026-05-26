declare const spindle: import('lumiverse-spindle-types').SpindleAPI

/* ------------------------------------------------------------------ *
 * WorldForge — model layer (World Books backed)
 *
 * A character's world is a dedicated World Book that WorldForge owns and
 * keeps attached to that character card. Every place, character/NPC,
 * faction, and piece of lore is a keyword-activated WORLD BOOK ENTRY, so
 * Lumiverse's native World Info pipeline reveals the right "chunks" as the
 * player mentions or approaches them — no manual prompt injection needed.
 *
 * The character card is the protagonist, but NPC entries are first-class:
 * each side character has its own entry, keywords, and tracked state that
 * advances even in scenes the protagonist never witnesses (off-screen
 * one-on-ones between NPCs).
 *
 * Per-character bookkeeping that doesn't belong in the prompt (which entry
 * is which kind, who is on/off screen, where the player is) lives in this
 * extension's private storage, keyed by characterId.
 * ------------------------------------------------------------------ */

export type EntityKind = 'location' | 'character' | 'faction' | 'lore' | 'event'

/* ------------------------------------------------------------------ *
 * Knowledge boundaries (the "characters only know what they witnessed"
 * guarantee). Each entry carries WorldForge metadata in its `extensions`
 * field describing whether it is private knowledge and, if so, exactly
 * which character ids are privy to it (the "audience"). A world-info
 * interceptor reads this before activation and disables any private entry
 * whose audience excludes the character currently in the scene — so a
 * character can never surface knowledge it never witnessed or was told.
 * ------------------------------------------------------------------ */

export const WF_EXT = 'worldforge'

/** What rides along in entry.extensions.worldforge */
export interface EntryAwareness {
  kind: EntityKind
  /**
   * true  -> private knowledge, gated by `audience`
   * false -> public/observable; anyone may see it (locations, general lore,
   *          a character's public-facing description)
   */
  private: boolean
  /**
   * Character ids privy to this knowledge. Empty + private === no one knows
   * it yet (GM-only). The protagonist is referenced by the literal
   * 'protagonist' token so it survives not knowing the card's own id.
   */
  audience: string[]
}

export const PROTAGONIST = 'protagonist'

export function readAwareness(extensions: Record<string, unknown> | undefined): EntryAwareness | null {
  const wf = extensions?.[WF_EXT] as Partial<EntryAwareness> | undefined
  if (!wf || typeof wf.private !== 'boolean') return null
  return {
    kind: (wf.kind as EntityKind) ?? 'lore',
    private: wf.private,
    audience: Array.isArray(wf.audience) ? wf.audience.filter((x) => typeof x === 'string') : [],
  }
}

/**
 * Decide whether `characterId` (the active speaker) is allowed to see an
 * entry. Public entries are always visible. Private entries are visible only
 * if the character is in the audience. The protagonist token matches when the
 * active speaker IS the protagonist card.
 */
export function isVisibleTo(
  aw: EntryAwareness | null,
  activeCharacterId: string,
  isProtagonist: boolean,
): boolean {
  if (!aw || !aw.private) return true // public / untagged -> visible
  if (aw.audience.includes(activeCharacterId)) return true
  if (isProtagonist && aw.audience.includes(PROTAGONIST)) return true
  return false
}

/** WorldForge's private index of the entries it manages for one character. */
export interface WorldMeta {
  characterId: string
  worldBookId: string | null
  /** entryId -> our classification + light tracking. */
  entries: Record<
    string,
    {
      kind: EntityKind
      name: string
      /** For characters: are they currently present with the player? */
      onstage?: boolean
      /** Free-form one-line status mirror for the panel (authoritative text lives in the entry). */
      status?: string
      /** Mirror of the entry's audience for the panel + agent context. */
      audience?: string[]
      private?: boolean
      updatedAt: number
    }
  >
  /** Name of the location entry the player currently occupies. */
  currentLocation: string | null
  createdAt: number
  updatedAt: number
}

export const META_PREFIX = 'meta/'
export const metaPath = (cid: string) => `${META_PREFIX}${cid}.json`

export function emptyMeta(characterId: string): WorldMeta {
  const now = Date.now()
  return {
    characterId,
    worldBookId: null,
    entries: {},
    currentLocation: null,
    createdAt: now,
    updatedAt: now,
  }
}

/* ----------------------- book provisioning ------------------------- */
/*
 * Ensure the character has a WorldForge-owned world book, attached to the
 * card. We NEVER write into books we didn't create, so the user's hand-
 * authored lorebooks are safe. The owned book id is recorded both in our
 * meta and in character.extensions.worldforge for resilience.
 */

const EXT_NS = 'worldforge'

export async function ensureWorldBook(meta: WorldMeta, userId?: string): Promise<string> {
  if (meta.worldBookId) {
    // Verify it still exists; if the user deleted it, re-provision.
    const existing = await spindle.world_books.get(meta.worldBookId, userId)
    if (existing) return meta.worldBookId
    meta.worldBookId = null
  }

  // Try to recover a previously-created book id from the character card.
  const char = await spindle.characters.get(meta.characterId, userId)
  const recorded = (char?.extensions?.[EXT_NS] as { worldBookId?: string } | undefined)?.worldBookId
  if (recorded) {
    const book = await spindle.world_books.get(recorded, userId)
    if (book) {
      meta.worldBookId = recorded
      await attachBook(meta.characterId, recorded, char?.world_book_ids ?? [], userId)
      return recorded
    }
  }

  // Create a fresh dedicated book.
  const name = char?.name ? `${char.name} — WorldForge` : 'WorldForge World'
  const book = await spindle.world_books.create(
    {
      name,
      description: 'Auto-managed living world for this character. Edited by the WorldForge extension.',
      metadata: { worldforge: true },
    },
    userId,
  )
  meta.worldBookId = book.id

  await attachBook(meta.characterId, book.id, char?.world_book_ids ?? [], userId)
  // Record on the card so we can recover the book across reinstalls.
  await spindle.characters.update(
    meta.characterId,
    { extensions: { [EXT_NS]: { worldBookId: book.id } } },
    userId,
  )

  spindle.log.info(`[worldforge] provisioned world book ${book.id} for character ${meta.characterId}`)
  return book.id
}

/** Attach without clobbering the user's other attached books. */
async function attachBook(
  characterId: string,
  bookId: string,
  current: string[],
  userId?: string,
): Promise<void> {
  if (current.includes(bookId)) return
  await spindle.characters.update(characterId, { world_book_ids: [...current, bookId] }, userId)
}

/* --------------------------- keyword helpers ----------------------- */

/** Build a reasonable keyword set from a name + extra aliases. */
export function buildKeys(name: string, aliases: string[] = []): string[] {
  const out = new Set<string>()
  const push = (s: string) => {
    const t = s.trim()
    if (t.length >= 2) out.add(t)
  }
  push(name)
  // Individual significant words from the name (e.g. "The Iron Keep" -> "Iron Keep", "Iron", "Keep").
  const words = name.split(/\s+/).filter((w) => w.length >= 3 && !/^(the|a|an|of|and)$/i.test(w))
  for (const w of words) push(w)
  for (const a of aliases) push(a)
  return Array.from(out)
}

/** Standard label/comment so entries are recognizable in the WI UI. */
export function entryComment(kind: EntityKind, name: string): string {
  const tag = kind.charAt(0).toUpperCase() + kind.slice(1)
  return `[WF:${tag}] ${name}`
}
