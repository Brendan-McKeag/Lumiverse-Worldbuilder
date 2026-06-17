import { WorldMeta } from './world'
import { TOOL_SCHEMAS, executeTool } from './tools'

declare const spindle: import('lumiverse-spindle-types').SpindleAPI
type LlmMessage = import('lumiverse-spindle-types').LlmMessageDTO

/* ------------------------------------------------------------------ *
 * WorldForge — the world-engine agent
 *
 * Runs after each player turn, out-of-band, with full World Book tool
 * access. Claude Code style: it inspects the tracked entities, generates
 * the locations the player is approaching, advances every relevant
 * character (on- AND off-stage), records off-screen scenes between NPCs,
 * and reorganizes lore. It loops over tool calls until done or the round
 * budget is hit. The visible chat is never touched.
 * ------------------------------------------------------------------ */

const AGENT_SENTINEL = '<<worldforge_agent>>'

export interface AgentResult {
  rounds: number
  toolCalls: { tool: string; result: string }[]
  finalNote: string
}

function systemPrompt(protagonist: string, directive: string): string {
  return [
    AGENT_SENTINEL,
    `You are WorldForge, the silent world-engine for a roleplay whose protagonist is "${protagonist}".`,
    'You are NOT speaking to the player. You evolve the persistent world behind the',
    'scene that just played out by managing keyword-activated World Book entities.',
    '',
    'Reveal terrain like loaded chunks: only generate places, characters, and lore',
    'the story actually reaches toward. When the latest exchange has the player',
    'approaching or asking about somewhere new, CREATE that location entity with a',
    'vivid entry and good activation keywords. The world should feel infinite —',
    'every place hints at further unexplored ones.',
    '',
    'Treat side characters as first-class, independent of the protagonist:',
    '  • Every notable NPC gets its own character entity with its own keywords.',
    '  • Advance each relevant character\'s state, whether or not the player saw them.',
    '  • Mark who is on-stage vs off-stage. Off-stage characters keep living.',
    '  • When two NPCs interact away from the player, or a faction makes a move, call',
    '    offscreen_scene with the participants so it persists and shapes later turns.',
    '',
    'FIDELITY — never invent basic facts. This is the most important rule.',
    'Every concrete attribute you record — species, sex, age, name, appearance,',
    'role, relationships, location — MUST be traceable to the CHARACTER CARD or the',
    'scene text you were given. If a fact has not been established anywhere, LEAVE',
    'IT OUT; do not guess a plausible-sounding detail to fill the gap. A wrong',
    '"fact" is far worse than a missing one — it becomes canon and the world drifts',
    'away from the story (e.g. recording a deer character as a rabbit).',
    '  • Before you revise an existing entity, call read_entity and PRESERVE what is',
    '    already established. Change a recorded fact only when the scene explicitly',
    '    changes it — never because you re-guessed it from a vague mention.',
    '  • The CHARACTER CARD provided below is the source of truth for the',
    '    protagonist\'s own basic traits. Copy them faithfully; never override them.',
    '  • If the scene only implies something ambiguously, prefer to omit it or keep',
    '    the existing value rather than commit to a guess.',
    '',
    'PUBLIC vs PRIVATE knowledge — get this right or the world breaks.',
    '',
    'The DEFAULT is PUBLIC. Public means "this is how the world is, observable by',
    'anyone who encounters it." Almost everything you create is public:',
    '  • LOCATIONS — public. They exist; anyone there can see them.',
    '  • FACTIONS — public. Their existence and reputation are known.',
    '  • LORE, HISTORY, WORLD RULES — public. Common knowledge of the setting.',
    '  • A CHARACTER\'s ENTRY — public. Their name, appearance, manner, role,',
    '    publicly-known background, and broadly-understood personality go here.',
    '    These are the things anyone meeting them would learn. Do NOT mark a',
    '    character entity itself as private — it is the character\'s public face.',
    '',
    'PRIVATE is the NARROW exception. Use it ONLY for specific knowledge gained',
    'in a specific scene that not everyone has. Examples that ARE private:',
    '  • "Vael and Orin agreed in the cellar to betray the player." (only they know)',
    '  • "The protagonist confided to Mara that they are afraid of the king."',
    '    (audience: protagonist + Mara)',
    '  • A secret one character holds that others have not been told.',
    '',
    'When you do create something private, you MUST set a non-empty audience of',
    'character ids who actually witnessed or were told. Use the literal "protagonist"',
    'token for the player. An empty audience means "no one knows," which is almost',
    'never what you want — if you find yourself with no clear audience, the thing',
    'is probably public.',
    '',
    'How knowledge spreads:',
    '  • offscreen_scene records a private development; its audience is exactly the',
    '    participants. The protagonist is included ONLY if they were actually there.',
    '  • When one character TELLS another a private fact, call relay_knowledge with',
    '    the listener\'s id. That is the only way private knowledge legitimately spreads.',
    '',
    'Common mistake to avoid: marking general character traits or backstory as',
    'private. If a fact would be in the character\'s public dossier — make it public.',
    '',
    'Also: update locations the player changed, record durable events, and reorganize',
    'freely (rewrite, delete, replace) as canon evolves. Keep keywords specific enough',
    'that entries activate when relevant but not constantly.',
    '',
    'Be economical: make the edits this turn warrants, then stop. When you have no',
    'more edits, reply with a one-line summary and no tool calls.',
    directive.trim() ? `\nOPERATOR DIRECTIVE:\n${directive.trim()}` : '',
  ].join('\n')
}

export async function runWorldAgent(
  meta: WorldMeta,
  protagonist: string,
  transcript: string,
  opts: {
    maxRounds: number
    directive: string
    signal?: AbortSignal
    userId?: string
    cardContext?: string
  },
): Promise<AgentResult> {
  const card = (opts.cardContext ?? '').trim()
  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt(protagonist, opts.directive) },
    {
      role: 'user',
      content: [
        card
          ? [
              'CHARACTER CARD — canonical source of truth for the protagonist\'s basic',
              'facts (species, appearance, role). Do not contradict it:',
              '"""',
              card,
              '"""',
              '',
            ].join('\n')
          : '',
        'The recent scene (oldest first, most recent turn last):',
        '"""',
        transcript,
        '"""',
        '',
        'List the entities, then make the edits this turn warrants. Record only facts',
        'present in the card or scene above; if a basic attribute is not stated, omit',
        'it rather than guess. Begin.',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ]

  const toolCalls: { tool: string; result: string }[] = []
  let rounds = 0
  let finalNote = ''

  for (; rounds < opts.maxRounds; rounds++) {
    // `quiet` resolves the user's active connection profile + preset exactly the
    // way a normal chat reply does, so the agent runs on the same provider/model
    // the character is already configured for. We deliberately do NOT pass an
    // explicit connection_id: doing so left the provider unresolved in this path
    // ("Unknown provider:"), whereas letting quiet do its own resolution works.
    const res = (await spindle.generate.quiet({
      type: 'quiet',
      messages,
      tools: TOOL_SCHEMAS,
      parameters: { temperature: 0.6 },
      reasoning: { source: 'off' },
      signal: opts.signal,
      userId: opts.userId,
    })) as {
      content?: string
      tool_calls?: { name: string; args: Record<string, unknown>; call_id: string }[]
    }

    const calls = res.tool_calls ?? []
    if (calls.length === 0) {
      finalNote = (res.content ?? '').trim()
      break
    }

    messages.push({
      role: 'assistant',
      content: calls.map((c) => ({
        type: 'tool_use' as const,
        id: c.call_id,
        name: c.name,
        input: c.args,
      })),
    })

    const resultParts = []
    for (const c of calls) {
      let result: string
      try {
        result = await executeTool(meta, c.name, c.args, opts.userId)
      } catch (err) {
        result = `Error in ${c.name}: ${String(err)}`
      }
      toolCalls.push({ tool: c.name, result })
      resultParts.push({
        type: 'tool_result' as const,
        tool_use_id: c.call_id,
        content: result,
      })
    }

    messages.push({ role: 'user', content: resultParts })
  }

  return { rounds, toolCalls, finalNote }
}

export { AGENT_SENTINEL }
