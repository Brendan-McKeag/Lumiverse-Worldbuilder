import {
  WorldMeta,
  EntityKind,
  buildKeys,
  entryComment,
  ensureWorldBook,
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
      'List every entity WorldForge tracks for this character — id, kind, name, and (for characters) whether they are currently on-stage with the player. Call first to orient yourself before editing.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_entity',
    description: 'Read the full World Book entry for one entity (its content, keywords, status).',
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
      'Create a new entity as a keyword-activated World Book entry. Use kind="location" for places (reveal new ones as the player approaches), kind="character" for NPCs/side characters (each tracked independently), "faction", "lore", or "event". Provide aliases for extra activation keywords. For characters, set onstage=true only if they are present with the player right now.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: KIND_VALUES },
        name: { type: 'string' },
        content: { type: 'string', description: 'The text revealed when this entity is in play.' },
        aliases: { type: 'array', items: { type: 'string' }, description: 'Extra activation keywords.' },
        onstage: { type: 'boolean', description: 'Characters only: present with the player now.' },
        constant: { type: 'boolean', description: 'Always active regardless of keywords (use rarely, e.g. core world rules).' },
      },
      required: ['kind', 'name', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_entity',
    description:
      'Revise an existing entity. Only provided fields change. Use to advance a character\'s state, rewrite a location after it changes, or append events. You have full latitude to rewrite as the world evolves.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        content: { type: 'string' },
        aliases: { type: 'array', items: { type: 'string' } },
        onstage: { type: 'boolean' },
        status: { type: 'string', description: 'One-line status mirror for the operator panel.' },
      },
      required: ['id'],
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
      'Record something that happens OFF-SCREEN, away from the player — e.g. a one-on-one between two NPCs, a faction\'s move, an event elsewhere. Provide the participating entity ids and a description of what unfolds. WorldForge appends the development to each participant\'s entry (and an event log entry) so the world stays alive between the player\'s scenes. The player is NOT told about this directly.',
    parameters: {
      type: 'object',
      properties: {
        participant_ids: { type: 'array', items: { type: 'string' }, description: 'Entity ids involved (characters/factions/locations).' },
        summary: { type: 'string', description: 'What happens off-screen.' },
        location_name: { type: 'string', description: 'Optional: where it happens.' },
      },
      required: ['summary'],
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
  opts: { onstage?: boolean; constant?: boolean },
): Promise<string> {
  const bookId = await ensureWorldBook(meta)
  const entry = await spindle.world_books.entries.create(bookId, {
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
  })
  meta.entries[entry.id] = {
    kind,
    name,
    onstage: kind === 'character' ? Boolean(opts.onstage) : undefined,
    updatedAt: Date.now(),
  }
  meta.updatedAt = Date.now()
  return entry.id
}

export async function executeTool(meta: WorldMeta, name: string, args: Args): Promise<string> {
  switch (name) {
    case 'list_entities': {
      const rows = Object.entries(meta.entries).map(([id, e]) => {
        const presence =
          e.kind === 'character' ? (e.onstage ? ' (on-stage)' : ' (off-stage)') : ''
        const here = e.kind === 'location' && e.name === meta.currentLocation ? ' (player here)' : ''
        return `  ${id} — [${e.kind}] ${e.name}${presence}${here}`
      })
      return [
        `Player location: ${meta.currentLocation ?? '(unset)'}`,
        'Entities:',
        rows.join('\n') || '  (none yet)',
      ].join('\n')
    }

    case 'read_entity': {
      const entry = await spindle.world_books.entries.get(str(args, 'id'))
      if (!entry) return `No entry ${str(args, 'id')}.`
      const e = meta.entries[entry.id]
      return JSON.stringify(
        {
          id: entry.id,
          kind: e?.kind,
          name: e?.name,
          onstage: e?.onstage,
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
      const id = await createEntry(meta, kind, nm, str(args, 'content'), arr(args, 'aliases'), {
        onstage: bool(args, 'onstage'),
        constant: bool(args, 'constant'),
      })
      if (kind === 'location' && !meta.currentLocation) meta.currentLocation = nm
      return `Created [${kind}] "${nm}" (${id}).`
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
      if (Object.keys(patch).length) await spindle.world_books.entries.update(id, patch)
      if (typeof args.onstage === 'boolean' && e.kind === 'character') e.onstage = bool(args, 'onstage')
      if (typeof args.status === 'string') e.status = str(args, 'status')
      e.updatedAt = Date.now()
      meta.updatedAt = Date.now()
      return `Updated ${id}.`
    }

    case 'delete_entity': {
      const id = str(args, 'id')
      if (!meta.entries[id]) return `Untracked entry ${id}.`
      await spindle.world_books.entries.delete(id)
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
      const ids = arr(args, 'participant_ids').filter((id) => meta.entries[id])
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
      const note = `\n\n[Off-screen, ${stamp}${str(args, 'location_name') ? ` @ ${str(args, 'location_name')}` : ''}] ${summary}`

      // Append the development to each participant's entry so it persists.
      for (const id of ids) {
        const entry = await spindle.world_books.entries.get(id)
        if (!entry) continue
        await spindle.world_books.entries.update(id, { content: `${entry.content}${note}` })
        meta.entries[id].updatedAt = Date.now()
      }

      // Also keep a rolling event-log entry (constant, low priority) as a ledger.
      const logId = Object.keys(meta.entries).find(
        (k) => meta.entries[k].kind === 'event' && meta.entries[k].name === 'Off-screen developments',
      )
      if (logId) {
        const entry = await spindle.world_books.entries.get(logId)
        if (entry) await spindle.world_books.entries.update(logId, { content: `${entry.content}${note}` })
      } else {
        await createEntry(
          meta,
          'event',
          'Off-screen developments',
          `A running ledger of what unfolds away from the player.${note}`,
          ['meanwhile', 'elsewhere'],
          { constant: false },
        )
      }
      meta.updatedAt = Date.now()
      return `Recorded off-screen scene involving ${ids.length} tracked participant(s).`
    }

    default:
      return `Unknown tool: ${name}`
  }
}
