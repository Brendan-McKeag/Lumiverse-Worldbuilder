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
  opts: { maxRounds: number; directive: string; signal?: AbortSignal; userId?: string },
): Promise<AgentResult> {
  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt(protagonist, opts.directive) },
    {
      role: 'user',
      content: [
        'The latest turn of the scene:',
        '"""',
        transcript,
        '"""',
        '',
        'List the entities, then make the edits this turn warrants. Begin.',
      ].join('\n'),
    },
  ]

  const toolCalls: { tool: string; result: string }[] = []
  let rounds = 0
  let finalNote = ''

  for (; rounds < opts.maxRounds; rounds++) {
    const res = (await spindle.generate.raw({
      type: 'raw',
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
