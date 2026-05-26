import {
  WorldMeta,
  EntityKind,
  buildKeys,
  entryComment,
  ensureWorldBook,
  EntryAwareness,
  WF_EXT,
} from './world'

declare const spindle: import('lumiverse-spindle-types').SpindleAPI

/* ------------------------------------------------------------------ *
 * WorldForge — agent tools (World Books backed)
 *
 * The agent edits the character's living world by managing keyword-
 * activated World Book entries: locations, characters/NPCs, factions,
 * lore, and events. Characters are first-class — each gets its own entry
 * and tracked presence, so side characters persist and advance even when
 * the protagonist isn't in the scene.
 *
 * Executors are async (they call the world_books API) and keep the private
 * meta index in sync. Each returns a short string fed back as a tool_result.
 * ------------------------------------------------------------------ */

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

type Args = Record<string, unknown>
const str = (a: Args, k: string, d = '') => (typeof a[k] === 'string' ? (a[k] as string) : d)
const bool = (a: Args, k: string) => Boolean(a[k])
const arr = (a: Args, k: string) => (Array.isArray(a[k]) ? (a[k] as unknown[]).filter((x) => typeof x === 'string') as string[] : [])

const KIND_VALUES: EntityKind[] = ['location', 'character', 'faction', 'lore', 'event']

/* ----------------------------- schemas ----------------------------- */

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'list_entities',
    description:
      'List every entity WorldForge tracks — id, kind, name, (for characters) on/off-stage, and for private knowledge its audience (who is privy to it). Call first to orient yourself. CRITICAL: a character only knows entries that are public or whose audience includes them.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_entity',
    description: 'Read the full World Book entry for one entity (its content, keywords, privacy, and audience).',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_entity',
    description:
      'Create a new entity as a keyword-activated World Book entry. kind="location" for places, "character" for NPCs/side characters (tracked independently), "faction", "lore", or "event".\n\nKNOWLEDGE BOUNDARY — this is important: by default an entry is PUBLIC (observable by anyone — use for places, factions, general lore, and a character\'s outward/public description). Set private=true for knowledge only some characters hold (what was said in a private conversation, a secret, a plan), and list exactly who is privy in `audience`. A private entry is hidden from any character not in its audience, so characters never "remember" things they didn\'t witness or weren\'t told. Use the literal "protagonist" token in audience for the player\'s character.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: KIND_VALUES },
        name: { type: 'string' },
        content: { type: 'string', description: 'The text revealed when this entity is in play.' },
        aliases: { type: 'array', items: { type: 'string' }, description: 'Extra activation keywords.' },
        onstage: { type: 'boolean', description: 'Characters only: present with the player now.' },
        constant: { type: 'boolean', description: 'Always active regardless of keywords (use rarely).' },
        private: { type: 'boolean', description: 'True = gated knowledge only `audience` holds. False/omitted = public.' },
        audience: {
          type: 'array',
          items: { type: 'string' },
          description: 'Character ids privy to this (required when private). Use "protagonist" for the player.',
        },
      },
      required: ['kind', 'name', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_entity',
    description:
      'Revise an existing entity. Only provided fields change. Use to advance a character\'s state, rewrite a location, or append events. You can also change privacy/audience here (e.g. widen who knows a fact). Setting `audience` replaces the list; use relay_knowledge to ADD someone who was just told.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        content: { type: 'string' },
        aliases: { type: 'array', items: { type: 'string' } },
        onstage: { type: 'boolean' },
        status: { type: 'string', description: 'One-line status mirror for the operator panel.' },
        private: { type: 'boolean' },
        audience: { type: 'array', items: { type: 'string' }, description: 'Replaces the audience list.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'relay_knowledge',
    description:
      'Record that knowledge propagated: one or more characters were TOLD about a private entry (or witnessed it), so they should now know it too. Adds the given character ids to that entry\'s audience. Use whenever a character informs another of something off-screen or in dialogue.',
    parameters: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'The private entry whose knowledge spread.' },
        learner_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Character ids who now know it (use "protagonist" for the player).',
        },
      },
      required: ['entry_id', 'learner_ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_entity',
    description: 'Delete an entity entirely (its World Book entry is removed). Use sparingly, for genuine mistakes or merges.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_player_location',
    description: 'Record which location entity the player currently occupies (by entity id).',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_character_presence',
    description:
      'Mark a character on- or off-stage relative to the player. Off-stage characters keep existing and acting in the world out of the player\'s sight.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, onstage: { type: 'boolean' } },
      required: ['id', 'onstage'],
      additionalProperties: false,
    },
  },
  {
    name: 'offscreen_scene',
    description:
      'Record something that happens OFF-SCREEN, away from the player — a one-on-one between NPCs, a faction\'s move, an event elsewhere. This creates a PRIVATE knowledge entry whose audience is exactly the participants: only they will ever know it happened, unless you later relay_knowledge to someone else. The protagonist and uninvolved characters are NOT privy. This is the mechanism that keeps characters from "remembering" scenes they were never part of.',
    parameters: {
      type: 'object',
      properties: {
        participant_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Character ids present for the scene — these become the audience. Omit the protagonist unless they were actually there.',
        },
        summary: { type: 'string', description: 'What happens off-screen.' },
        location_name: { type: 'string', description: 'Optional: where it happens.' },
      },
      required: ['summary', 'participant_ids'],
      additionalProperties: false,
    },
  },
]

/* ---------------------------- executors ---------------------------- */

const POS_AT_DEPTH = 4

async function createEntry(
  meta: WorldMeta,
  kind: EntityKind,
  name: string,
  content: string,
  aliases: string[],
  opts: { onstage?: boolean; constant?: boolean; private?: boolean; audience?: string[] },
  userId?: string,
): Promise<string> {
  const bookId = await ensureWorldBook(meta, userId)
  // Public by default for observable kinds (locations, factions, lore, the
  // public face of a character). Private knowledge must be opted in with an
  // explicit audience so it can be gated per-character.
  const isPrivate = Boolean(opts.private)
  const audience = isPrivate ? opts.audience ?? [] : []
  const awareness: EntryAwareness = { kind, private: isPrivate, audience }

  const entry = await spindle.world_books.entries.create(
    bookId,
    {
      key: buildKeys(name, aliases),
      content,
      comment: entryComment(kind, name),
      position: POS_AT_DEPTH,
      depth: 4,
      constant: Boolean(opts.constant),
      selective: false,
      disabled: false,
      order_value: 100,
      priority: kind === 'lore' || kind === 'faction' ? 20 : 10,
      extensions: { [WF_EXT]: awareness },
    },
    userId,
  )
  meta.entries[entry.id] = {
    kind,
    name,
    onstage: kind === 'character' ? Boolean(opts.onstage) : undefined,
    private: isPrivate,
    audience,
    updatedAt: Date.now(),
  }
  meta.updatedAt = Date.now()
  return entry.id
}

/** Read + rewrite an entry's awareness metadata, keeping meta in sync. */
async function setAwareness(
  meta: WorldMeta,
  entryId: string,
  patch: { private?: boolean; audience?: string[] },
  userId?: string,
): Promise<void> {
  const m = meta.entries[entryId]
  if (!m) return
  const entry = await spindle.world_books.entries.get(entryId, userId)
  const current = (entry?.extensions?.[WF_EXT] as EntryAwareness | undefined) ?? {
    kind: m.kind,
    private: Boolean(m.private),
    audience: m.audience ?? [],
  }
  const next: EntryAwareness = {
    kind: current.kind,
    private: patch.private ?? current.private,
    audience: patch.audience ?? current.audience,
  }
  await spindle.world_books.entries.update(entryId, { extensions: { [WF_EXT]: next } }, userId)
  m.private = next.private
  m.audience = next.audience
  m.updatedAt = Date.now()
}

/** Merge ids into an entry's audience (dedup). */
function mergeAudience(existing: string[] | undefined, add: string[]): string[] {
  return Array.from(new Set([...(existing ?? []), ...add]))
}

export async function executeTool(meta: WorldMeta, name: string, args: Args, userId?: string): Promise<string> {
  switch (name) {
    case 'list_entities': {
      const rows = Object.entries(meta.entries).map(([id, e]) => {
        const presence =
          e.kind === 'character' ? (e.onstage ? ' (on-stage)' : ' (off-stage)') : ''
        const here = e.kind === 'location' && e.name === meta.currentLocation ? ' (player here)' : ''
        const know = e.private
          ? ` [PRIVATE — known to: ${(e.audience ?? []).join(', ') || 'no one yet'}]`
          : ''
        return `  ${id} — [${e.kind}] ${e.name}${presence}${here}${know}`
      })
      return [
        `Player location: ${meta.currentLocation ?? '(unset)'}`,
        'Entities (PRIVATE entries are only seen by characters in their audience):',
        rows.join('\n') || '  (none yet)',
      ].join('\n')
    }

    case 'read_entity': {
      const entry = await spindle.world_books.entries.get(str(args, 'id'), userId)
      if (!entry) return `No entry ${str(args, 'id')}.`
      const e = meta.entries[entry.id]
      return JSON.stringify(
        {
          id: entry.id,
          kind: e?.kind,
          name: e?.name,
          onstage: e?.onstage,
          private: e?.private ?? false,
          audience: e?.audience ?? [],
          keys: entry.key,
          content: entry.content,
        },
        null,
        2,
      )
    }

    case 'create_entity': {
      const kind = (str(args, 'kind') as EntityKind) || 'lore'
      if (!KIND_VALUES.includes(kind)) return `Invalid kind: ${str(args, 'kind')}`
      const nm = str(args, 'name')
      const isPrivate = bool(args, 'private')
      const audience = arr(args, 'audience')
      const id = await createEntry(
        meta,
        kind,
        nm,
        str(args, 'content'),
        arr(args, 'aliases'),
        { onstage: bool(args, 'onstage'), constant: bool(args, 'constant'), private: isPrivate, audience },
        userId,
      )
      if (kind === 'location' && !meta.currentLocation) meta.currentLocation = nm
      return `Created [${kind}] "${nm}" (${id})${
        isPrivate ? ` — PRIVATE, known to: ${audience.join(', ') || 'no one yet'}` : ''
      }.`
    }

    case 'update_entity': {
      const id = str(args, 'id')
      const e = meta.entries[id]
      if (!e) return `Untracked entry ${id}.`
      const patch: Record<string, unknown> = {}
      if (typeof args.content === 'string') patch.content = str(args, 'content')
      if (typeof args.name === 'string' || Array.isArray(args.aliases)) {
        const newName = typeof args.name === 'string' ? str(args, 'name') : e.name
        patch.key = buildKeys(newName, arr(args, 'aliases'))
        patch.comment = entryComment(e.kind, newName)
        e.name = newName
      }
      if (Object.keys(patch).length) await spindle.world_books.entries.update(id, patch, userId)
      if (typeof args.private === 'boolean' || Array.isArray(args.audience)) {
        await setAwareness(
          meta,
          id,
          {
            private: typeof args.private === 'boolean' ? bool(args, 'private') : undefined,
            audience: Array.isArray(args.audience) ? arr(args, 'audience') : undefined,
          },
          userId,
        )
      }
      if (typeof args.onstage === 'boolean' && e.kind === 'character') e.onstage = bool(args, 'onstage')
      if (typeof args.status === 'string') e.status = str(args, 'status')
      e.updatedAt = Date.now()
      meta.updatedAt = Date.now()
      return `Updated ${id}.`
    }

    case 'relay_knowledge': {
      const id = str(args, 'entry_id')
      const e = meta.entries[id]
      if (!e) return `Untracked entry ${id}.`
      const learners = arr(args, 'learner_ids')
      if (!learners.length) return 'No learner ids given.'
      const next = mergeAudience(e.audience, learners)
      // If it wasn't private before, relaying makes it tracked knowledge now.
      await setAwareness(meta, id, { private: true, audience: next }, userId)
      return `Knowledge in ${id} now also known to: ${learners.join(', ')} (full audience: ${next.join(', ')}).`
    }

    case 'delete_entity': {
      const id = str(args, 'id')
      if (!meta.entries[id]) return `Untracked entry ${id}.`
      await spindle.world_books.entries.delete(id, userId)
      const wasLoc = meta.entries[id].kind === 'location' && meta.entries[id].name === meta.currentLocation
      delete meta.entries[id]
      if (wasLoc) meta.currentLocation = null
      meta.updatedAt = Date.now()
      return `Deleted ${id}.`
    }

    case 'set_player_location': {
      const e = meta.entries[str(args, 'id')]
      if (!e || e.kind !== 'location') return `No location entity ${str(args, 'id')}.`
      meta.currentLocation = e.name
      meta.updatedAt = Date.now()
      return `Player is now at ${e.name}.`
    }

    case 'set_character_presence': {
      const e = meta.entries[str(args, 'id')]
      if (!e || e.kind !== 'character') return `No character entity ${str(args, 'id')}.`
      e.onstage = bool(args, 'onstage')
      e.updatedAt = Date.now()
      meta.updatedAt = Date.now()
      return `${e.name} is now ${e.onstage ? 'on-stage' : 'off-stage'}.`
    }

    case 'offscreen_scene': {
      const summary = str(args, 'summary')
      if (!summary) return 'No summary provided.'
      const participants = arr(args, 'participant_ids').filter((id) => meta.entries[id])
      if (!participants.length)
        return 'offscreen_scene needs at least one known participant id (its audience).'
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
      const where = str(args, 'location_name') ? ` @ ${str(args, 'location_name')}` : ''
      const names = participants.map((id) => meta.entries[id].name).join(', ')

      // The development is PRIVATE knowledge gated to the participants only.
      // It is a standalone event entry whose audience is exactly the people who
      // were there — so the world-info interceptor will never surface it to the
      // protagonist or any uninvolved character. Keywords are the participants'
      // names so it activates only when one of THEM is the active character.
      const keyNames = participants.map((id) => meta.entries[id].name)
      const id = await createEntry(
        meta,
        'event',
        `Off-screen: ${names} (${stamp})`,
        `[Off-screen development${where}] ${summary}`,
        keyNames,
        { private: true, audience: participants },
        userId,
      )

      // Optionally reflect a terse, NON-private note that "time passed" only on
      // the participants' own entries is NOT done here, because that would leak
      // through their public description. Persisted knowledge lives solely in
      // the gated event entry above.
      meta.updatedAt = Date.now()
      return `Recorded off-screen scene (${id}) known only to: ${names}.`
    }

    default:
      return `Unknown tool: ${name}`
  }
}
