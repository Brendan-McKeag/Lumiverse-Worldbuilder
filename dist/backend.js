// src/world.ts
var WF_EXT = "worldforge";
var PROTAGONIST = "protagonist";
function readAwareness(extensions) {
  const wf = extensions?.[WF_EXT];
  if (!wf || typeof wf.private !== "boolean") return null;
  return {
    kind: wf.kind ?? "lore",
    private: wf.private,
    audience: Array.isArray(wf.audience) ? wf.audience.filter((x) => typeof x === "string") : []
  };
}
function isVisibleTo(aw, activeCharacterId, isProtagonist) {
  if (!aw || !aw.private) return true;
  if (aw.audience.includes(activeCharacterId)) return true;
  if (isProtagonist && aw.audience.includes(PROTAGONIST)) return true;
  return false;
}
var META_PREFIX = "meta/";
var metaPath = (cid) => `${META_PREFIX}${cid}.json`;
function emptyMeta(characterId) {
  const now = Date.now();
  return {
    characterId,
    worldBookId: null,
    entries: {},
    currentLocation: null,
    createdAt: now,
    updatedAt: now
  };
}
var EXT_NS = "worldforge";
async function ensureWorldBook(meta, userId) {
  if (meta.worldBookId) {
    const existing = await spindle.world_books.get(meta.worldBookId, userId);
    if (existing) return meta.worldBookId;
    meta.worldBookId = null;
  }
  const char = await spindle.characters.get(meta.characterId, userId);
  const recorded = char?.extensions?.[EXT_NS]?.worldBookId;
  if (recorded) {
    const book2 = await spindle.world_books.get(recorded, userId);
    if (book2) {
      meta.worldBookId = recorded;
      await attachBook(meta.characterId, recorded, char?.world_book_ids ?? [], userId);
      return recorded;
    }
  }
  const name = char?.name ? `${char.name} \u2014 WorldForge` : "WorldForge World";
  const book = await spindle.world_books.create(
    {
      name,
      description: "Auto-managed living world for this character. Edited by the WorldForge extension.",
      metadata: { worldforge: true }
    },
    userId
  );
  meta.worldBookId = book.id;
  await attachBook(meta.characterId, book.id, char?.world_book_ids ?? [], userId);
  await spindle.characters.update(
    meta.characterId,
    { extensions: { [EXT_NS]: { worldBookId: book.id } } },
    userId
  );
  spindle.log.info(`[worldforge] provisioned world book ${book.id} for character ${meta.characterId}`);
  return book.id;
}
async function attachBook(characterId, bookId, current, userId) {
  if (current.includes(bookId)) return;
  await spindle.characters.update(characterId, { world_book_ids: [...current, bookId] }, userId);
}
function buildKeys(name, aliases = []) {
  const out = /* @__PURE__ */ new Set();
  const push = (s) => {
    const t = s.trim();
    if (t.length >= 2) out.add(t);
  };
  push(name);
  const words = name.split(/\s+/).filter((w) => w.length >= 3 && !/^(the|a|an|of|and)$/i.test(w));
  for (const w of words) push(w);
  for (const a of aliases) push(a);
  return Array.from(out);
}
function entryComment(kind, name) {
  const tag = kind.charAt(0).toUpperCase() + kind.slice(1);
  return `[WF:${tag}] ${name}`;
}

// src/tools.ts
var str = (a, k, d = "") => typeof a[k] === "string" ? a[k] : d;
var bool = (a, k) => Boolean(a[k]);
var arr = (a, k) => Array.isArray(a[k]) ? a[k].filter((x) => typeof x === "string") : [];
var KIND_VALUES = ["location", "character", "faction", "lore", "event"];
var TOOL_SCHEMAS = [
  {
    name: "list_entities",
    description: "List every entity WorldForge tracks \u2014 id, kind, name, (for characters) on/off-stage, and for private knowledge its audience (who is privy to it). Call first to orient yourself. CRITICAL: a character only knows entries that are public or whose audience includes them.",
    parameters: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "read_entity",
    description: "Read the full World Book entry for one entity (its content, keywords, privacy, and audience).",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "create_entity",
    description: `Create a new entity as a keyword-activated World Book entry. kind="location" for places, "character" for NPCs/side characters (tracked independently), "faction", "lore", or "event".

KNOWLEDGE BOUNDARY \u2014 this is important: by default an entry is PUBLIC (observable by anyone \u2014 use for places, factions, general lore, and a character's outward/public description). Set private=true for knowledge only some characters hold (what was said in a private conversation, a secret, a plan), and list exactly who is privy in \`audience\`. A private entry is hidden from any character not in its audience, so characters never "remember" things they didn't witness or weren't told. Use the literal "protagonist" token in audience for the player's character.`,
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: KIND_VALUES },
        name: { type: "string" },
        content: { type: "string", description: "The text revealed when this entity is in play." },
        aliases: { type: "array", items: { type: "string" }, description: "Extra activation keywords." },
        onstage: { type: "boolean", description: "Characters only: present with the player now." },
        constant: { type: "boolean", description: "Always active regardless of keywords (use rarely)." },
        private: { type: "boolean", description: "True = gated knowledge only `audience` holds. False/omitted = public." },
        audience: {
          type: "array",
          items: { type: "string" },
          description: 'Character ids privy to this (required when private). Use "protagonist" for the player.'
        }
      },
      required: ["kind", "name", "content"],
      additionalProperties: false
    }
  },
  {
    name: "update_entity",
    description: "Revise an existing entity. Only provided fields change. Use to advance a character's state, rewrite a location, or append events. You can also change privacy/audience here (e.g. widen who knows a fact). Setting `audience` replaces the list; use relay_knowledge to ADD someone who was just told.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        content: { type: "string" },
        aliases: { type: "array", items: { type: "string" } },
        onstage: { type: "boolean" },
        status: { type: "string", description: "One-line status mirror for the operator panel." },
        private: { type: "boolean" },
        audience: { type: "array", items: { type: "string" }, description: "Replaces the audience list." }
      },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "relay_knowledge",
    description: "Record that knowledge propagated: one or more characters were TOLD about a private entry (or witnessed it), so they should now know it too. Adds the given character ids to that entry's audience. Use whenever a character informs another of something off-screen or in dialogue.",
    parameters: {
      type: "object",
      properties: {
        entry_id: { type: "string", description: "The private entry whose knowledge spread." },
        learner_ids: {
          type: "array",
          items: { type: "string" },
          description: 'Character ids who now know it (use "protagonist" for the player).'
        }
      },
      required: ["entry_id", "learner_ids"],
      additionalProperties: false
    }
  },
  {
    name: "delete_entity",
    description: "Delete an entity entirely (its World Book entry is removed). Use sparingly, for genuine mistakes or merges.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "set_player_location",
    description: "Record which location entity the player currently occupies (by entity id).",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "set_character_presence",
    description: "Mark a character on- or off-stage relative to the player. Off-stage characters keep existing and acting in the world out of the player's sight.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, onstage: { type: "boolean" } },
      required: ["id", "onstage"],
      additionalProperties: false
    }
  },
  {
    name: "offscreen_scene",
    description: `Record something that happens OFF-SCREEN, away from the player \u2014 a one-on-one between NPCs, a faction's move, an event elsewhere. This creates a PRIVATE knowledge entry whose audience is exactly the participants: only they will ever know it happened, unless you later relay_knowledge to someone else. The protagonist and uninvolved characters are NOT privy. This is the mechanism that keeps characters from "remembering" scenes they were never part of.`,
    parameters: {
      type: "object",
      properties: {
        participant_ids: {
          type: "array",
          items: { type: "string" },
          description: "Character ids present for the scene \u2014 these become the audience. Omit the protagonist unless they were actually there."
        },
        summary: { type: "string", description: "What happens off-screen." },
        location_name: { type: "string", description: "Optional: where it happens." }
      },
      required: ["summary", "participant_ids"],
      additionalProperties: false
    }
  }
];
var POS_AT_DEPTH = 4;
async function createEntry(meta, kind, name, content, aliases, opts, userId) {
  const bookId = await ensureWorldBook(meta, userId);
  const isPrivate = Boolean(opts.private);
  const audience = isPrivate ? opts.audience ?? [] : [];
  const awareness = { kind, private: isPrivate, audience };
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
      priority: kind === "lore" || kind === "faction" ? 20 : 10,
      extensions: { [WF_EXT]: awareness }
    },
    userId
  );
  meta.entries[entry.id] = {
    kind,
    name,
    onstage: kind === "character" ? Boolean(opts.onstage) : void 0,
    private: isPrivate,
    audience,
    updatedAt: Date.now()
  };
  meta.updatedAt = Date.now();
  return entry.id;
}
async function setAwareness(meta, entryId, patch, userId) {
  const m = meta.entries[entryId];
  if (!m) return;
  const entry = await spindle.world_books.entries.get(entryId, userId);
  const current = entry?.extensions?.[WF_EXT] ?? {
    kind: m.kind,
    private: Boolean(m.private),
    audience: m.audience ?? []
  };
  const next = {
    kind: current.kind,
    private: patch.private ?? current.private,
    audience: patch.audience ?? current.audience
  };
  await spindle.world_books.entries.update(entryId, { extensions: { [WF_EXT]: next } }, userId);
  m.private = next.private;
  m.audience = next.audience;
  m.updatedAt = Date.now();
}
function mergeAudience(existing, add) {
  return Array.from(/* @__PURE__ */ new Set([...existing ?? [], ...add]));
}
async function executeTool(meta, name, args, userId) {
  switch (name) {
    case "list_entities": {
      const rows = Object.entries(meta.entries).map(([id, e]) => {
        const presence = e.kind === "character" ? e.onstage ? " (on-stage)" : " (off-stage)" : "";
        const here = e.kind === "location" && e.name === meta.currentLocation ? " (player here)" : "";
        const know = e.private ? ` [PRIVATE \u2014 known to: ${(e.audience ?? []).join(", ") || "no one yet"}]` : "";
        return `  ${id} \u2014 [${e.kind}] ${e.name}${presence}${here}${know}`;
      });
      return [
        `Player location: ${meta.currentLocation ?? "(unset)"}`,
        "Entities (PRIVATE entries are only seen by characters in their audience):",
        rows.join("\n") || "  (none yet)"
      ].join("\n");
    }
    case "read_entity": {
      const entry = await spindle.world_books.entries.get(str(args, "id"), userId);
      if (!entry) return `No entry ${str(args, "id")}.`;
      const e = meta.entries[entry.id];
      return JSON.stringify(
        {
          id: entry.id,
          kind: e?.kind,
          name: e?.name,
          onstage: e?.onstage,
          private: e?.private ?? false,
          audience: e?.audience ?? [],
          keys: entry.key,
          content: entry.content
        },
        null,
        2
      );
    }
    case "create_entity": {
      const kind = str(args, "kind") || "lore";
      if (!KIND_VALUES.includes(kind)) return `Invalid kind: ${str(args, "kind")}`;
      const nm = str(args, "name");
      const isPrivate = bool(args, "private");
      const audience = arr(args, "audience");
      const id = await createEntry(
        meta,
        kind,
        nm,
        str(args, "content"),
        arr(args, "aliases"),
        { onstage: bool(args, "onstage"), constant: bool(args, "constant"), private: isPrivate, audience },
        userId
      );
      if (kind === "location" && !meta.currentLocation) meta.currentLocation = nm;
      return `Created [${kind}] "${nm}" (${id})${isPrivate ? ` \u2014 PRIVATE, known to: ${audience.join(", ") || "no one yet"}` : ""}.`;
    }
    case "update_entity": {
      const id = str(args, "id");
      const e = meta.entries[id];
      if (!e) return `Untracked entry ${id}.`;
      const patch = {};
      if (typeof args.content === "string") patch.content = str(args, "content");
      if (typeof args.name === "string" || Array.isArray(args.aliases)) {
        const newName = typeof args.name === "string" ? str(args, "name") : e.name;
        patch.key = buildKeys(newName, arr(args, "aliases"));
        patch.comment = entryComment(e.kind, newName);
        e.name = newName;
      }
      if (Object.keys(patch).length) await spindle.world_books.entries.update(id, patch, userId);
      if (typeof args.private === "boolean" || Array.isArray(args.audience)) {
        await setAwareness(
          meta,
          id,
          {
            private: typeof args.private === "boolean" ? bool(args, "private") : void 0,
            audience: Array.isArray(args.audience) ? arr(args, "audience") : void 0
          },
          userId
        );
      }
      if (typeof args.onstage === "boolean" && e.kind === "character") e.onstage = bool(args, "onstage");
      if (typeof args.status === "string") e.status = str(args, "status");
      e.updatedAt = Date.now();
      meta.updatedAt = Date.now();
      return `Updated ${id}.`;
    }
    case "relay_knowledge": {
      const id = str(args, "entry_id");
      const e = meta.entries[id];
      if (!e) return `Untracked entry ${id}.`;
      const learners = arr(args, "learner_ids");
      if (!learners.length) return "No learner ids given.";
      const next = mergeAudience(e.audience, learners);
      await setAwareness(meta, id, { private: true, audience: next }, userId);
      return `Knowledge in ${id} now also known to: ${learners.join(", ")} (full audience: ${next.join(", ")}).`;
    }
    case "delete_entity": {
      const id = str(args, "id");
      if (!meta.entries[id]) return `Untracked entry ${id}.`;
      await spindle.world_books.entries.delete(id, userId);
      const wasLoc = meta.entries[id].kind === "location" && meta.entries[id].name === meta.currentLocation;
      delete meta.entries[id];
      if (wasLoc) meta.currentLocation = null;
      meta.updatedAt = Date.now();
      return `Deleted ${id}.`;
    }
    case "set_player_location": {
      const e = meta.entries[str(args, "id")];
      if (!e || e.kind !== "location") return `No location entity ${str(args, "id")}.`;
      meta.currentLocation = e.name;
      meta.updatedAt = Date.now();
      return `Player is now at ${e.name}.`;
    }
    case "set_character_presence": {
      const e = meta.entries[str(args, "id")];
      if (!e || e.kind !== "character") return `No character entity ${str(args, "id")}.`;
      e.onstage = bool(args, "onstage");
      e.updatedAt = Date.now();
      meta.updatedAt = Date.now();
      return `${e.name} is now ${e.onstage ? "on-stage" : "off-stage"}.`;
    }
    case "offscreen_scene": {
      const summary = str(args, "summary");
      if (!summary) return "No summary provided.";
      const participants = arr(args, "participant_ids").filter((id2) => meta.entries[id2]);
      if (!participants.length)
        return "offscreen_scene needs at least one known participant id (its audience).";
      const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 16).replace("T", " ");
      const where = str(args, "location_name") ? ` @ ${str(args, "location_name")}` : "";
      const names = participants.map((id2) => meta.entries[id2].name).join(", ");
      const keyNames = participants.map((id2) => meta.entries[id2].name);
      const id = await createEntry(
        meta,
        "event",
        `Off-screen: ${names} (${stamp})`,
        `[Off-screen development${where}] ${summary}`,
        keyNames,
        { private: true, audience: participants },
        userId
      );
      meta.updatedAt = Date.now();
      return `Recorded off-screen scene (${id}) known only to: ${names}.`;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

// src/agent.ts
var AGENT_SENTINEL = "<<worldforge_agent>>";
function systemPrompt(protagonist, directive) {
  return [
    AGENT_SENTINEL,
    `You are WorldForge, the silent world-engine for a roleplay whose protagonist is "${protagonist}".`,
    "You are NOT speaking to the player. You evolve the persistent world behind the",
    "scene that just played out by managing keyword-activated World Book entities.",
    "",
    "Reveal terrain like loaded chunks: only generate places, characters, and lore",
    "the story actually reaches toward. When the latest exchange has the player",
    "approaching or asking about somewhere new, CREATE that location entity with a",
    "vivid entry and good activation keywords. The world should feel infinite \u2014",
    "every place hints at further unexplored ones.",
    "",
    "Treat side characters as first-class, independent of the protagonist:",
    "  \u2022 Every notable NPC gets its own character entity with its own keywords.",
    "  \u2022 Advance each relevant character's state, whether or not the player saw them.",
    "  \u2022 Mark who is on-stage vs off-stage. Off-stage characters keep living.",
    "  \u2022 When two NPCs interact away from the player, or a faction makes a move, call",
    "    offscreen_scene with the participants so it persists and shapes later turns.",
    "",
    "KNOWLEDGE BOUNDARIES \u2014 critical for believability. A character must only know",
    "what they personally witnessed or were explicitly told. Enforce this rigorously:",
    "  \u2022 A character entity's main content is its PUBLIC face \u2014 appearance, manner,",
    "    widely-known facts. Never write private secrets or off-screen events into it.",
    "  \u2022 Anything learned in a specific scene is PRIVATE knowledge: record it with",
    "    create_entity(private:true, audience:[ids of those present]) or via",
    "    offscreen_scene (whose audience is exactly its participants).",
    '  \u2022 Use the literal "protagonist" token in an audience when the player character',
    "    is privy. Do NOT add the protagonist to scenes they were absent from.",
    "  \u2022 When a character TELLS another something, call relay_knowledge to add the",
    "    listener to that knowledge's audience \u2014 that is the ONLY way knowledge",
    "    should spread between characters.",
    '  \u2022 If you are tempted to write "X knows Y" where X never witnessed Y and was',
    "    never told, stop \u2014 that is the leak this system exists to prevent.",
    "",
    "Also: update locations the player changed, record durable events, and reorganize",
    "freely (rewrite, delete, replace) as canon evolves. Keep keywords specific enough",
    "that entries activate when relevant but not constantly.",
    "",
    "Be economical: make the edits this turn warrants, then stop. When you have no",
    "more edits, reply with a one-line summary and no tool calls.",
    directive.trim() ? `
OPERATOR DIRECTIVE:
${directive.trim()}` : ""
  ].join("\n");
}
async function runWorldAgent(meta, protagonist, transcript, opts) {
  const messages = [
    { role: "system", content: systemPrompt(protagonist, opts.directive) },
    {
      role: "user",
      content: [
        "The latest turn of the scene:",
        '"""',
        transcript,
        '"""',
        "",
        "List the entities, then make the edits this turn warrants. Begin."
      ].join("\n")
    }
  ];
  const toolCalls = [];
  let rounds = 0;
  let finalNote = "";
  for (; rounds < opts.maxRounds; rounds++) {
    const res = await spindle.generate.quiet({
      type: "quiet",
      messages,
      tools: TOOL_SCHEMAS,
      parameters: { temperature: 0.6 },
      reasoning: { source: "off" },
      signal: opts.signal,
      userId: opts.userId
    });
    const calls = res.tool_calls ?? [];
    if (calls.length === 0) {
      finalNote = (res.content ?? "").trim();
      break;
    }
    messages.push({
      role: "assistant",
      content: calls.map((c) => ({
        type: "tool_use",
        id: c.call_id,
        name: c.name,
        input: c.args
      }))
    });
    const resultParts = [];
    for (const c of calls) {
      let result;
      try {
        result = await executeTool(meta, c.name, c.args, opts.userId);
      } catch (err) {
        result = `Error in ${c.name}: ${String(err)}`;
      }
      toolCalls.push({ tool: c.name, result });
      resultParts.push({
        type: "tool_result",
        tool_use_id: c.call_id,
        content: result
      });
    }
    messages.push({ role: "user", content: resultParts });
  }
  return { rounds, toolCalls, finalNote };
}

// src/backend.ts
var DEFAULT_CONFIG = { enabled: true, maxRounds: 6, directive: "", agentTimeoutMs: 6e4 };
var CONFIG_PATH = "config.json";
var config = { ...DEFAULT_CONFIG };
var chatChar = /* @__PURE__ */ new Map();
var running = /* @__PURE__ */ new Set();
var observers = /* @__PURE__ */ new Map();
async function loadConfig() {
  config = await spindle.storage.getJson(CONFIG_PATH, { fallback: { ...DEFAULT_CONFIG } });
}
async function saveConfig() {
  await spindle.storage.setJson(CONFIG_PATH, config, { indent: 2 });
}
async function loadMeta(cid) {
  return spindle.storage.getJson(metaPath(cid), { fallback: emptyMeta(cid) });
}
async function saveMeta(cid, meta) {
  await spindle.storage.setJson(metaPath(cid), meta, { indent: 2 });
}
async function characterForChat(chatId, userId) {
  const cached = chatChar.get(chatId);
  if (cached) {
    const c = await spindle.characters.get(cached, userId);
    return c ? { id: c.id, name: c.name } : null;
  }
  try {
    const chat = await spindle.chats.get(chatId, userId);
    const cid = chat?.character_id;
    if (!cid) return null;
    chatChar.set(chatId, cid);
    const c = await spindle.characters.get(cid, userId);
    return c ? { id: c.id, name: c.name } : { id: cid, name: "the character" };
  } catch {
    return null;
  }
}
async function buildTranscript(chatId, reply) {
  let lastUser = "";
  try {
    const msgs = await spindle.chat.getMessages(chatId);
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") {
        lastUser = typeof msgs[i].content === "string" ? msgs[i].content : JSON.stringify(msgs[i].content);
        break;
      }
    }
  } catch {
  }
  return [lastUser ? `PLAYER:
${lastUser}` : "", `
CHARACTER:
${reply}`].join("\n").trim();
}
async function runAgentForChat(chatId, reply, userId) {
  if (!config.enabled || !reply.trim()) return;
  const char = await characterForChat(chatId, userId);
  if (!char) return;
  if (running.has(char.id)) return;
  running.add(char.id);
  try {
    const meta = await loadMeta(char.id);
    await ensureWorldBook(meta, userId);
    const transcript = await buildTranscript(chatId, reply);
    const before = JSON.stringify(meta.entries);
    const signal = AbortSignal.timeout(config.agentTimeoutMs);
    const result = await runWorldAgent(meta, char.name, transcript, {
      maxRounds: config.maxRounds,
      directive: config.directive,
      signal,
      userId
    });
    await saveMeta(char.id, meta);
    const changed = JSON.stringify(meta.entries) !== before || result.toolCalls.length > 0;
    spindle.sendToFrontend({
      type: "world_changed",
      characterId: char.id,
      entityCount: Object.keys(meta.entries).length,
      rounds: result.rounds,
      edits: result.toolCalls.length,
      note: result.finalNote
    });
    spindle.log.info(
      `[worldforge] ${char.name}: ${result.toolCalls.length} edits / ${result.rounds} rounds${changed ? "" : " (no-op)"}`
    );
  } catch (err) {
    const msg = err instanceof Error && err.name === "AbortError" ? "agent timed out" : String(err);
    spindle.log.error(`[worldforge] agent failed: ${msg}`);
  } finally {
    running.delete(char.id);
  }
}
function ensureObserver(chatId) {
  if (!observers.has(chatId)) observers.set(chatId, spindle.generate.observe(chatId));
  return observers.get(chatId);
}
function dropObserver(chatId) {
  const o = observers.get(chatId);
  if (o) {
    o.dispose();
    observers.delete(chatId);
  }
}
spindle.on("GENERATION_STARTED", (payload) => {
  if (!config.enabled || !payload.chatId) return;
  ensureObserver(payload.chatId);
});
spindle.on("GENERATION_ENDED", async (payload, userId) => {
  if (!config.enabled || !payload.chatId) return;
  const chatId = payload.chatId;
  if (payload.error) return dropObserver(chatId);
  const gt = payload.generationType;
  if (gt === "impersonate" || gt === "quiet") return dropObserver(chatId);
  const obs = observers.get(chatId);
  const reply = (payload.content ?? obs?.content ?? "").trim();
  dropObserver(chatId);
  await runAgentForChat(chatId, reply, userId);
});
spindle.on("GENERATION_STOPPED", async (payload, userId) => {
  if (!config.enabled || !payload.chatId) return;
  const obs = observers.get(payload.chatId);
  const reply = (payload.content ?? obs?.content ?? "").trim();
  dropObserver(payload.chatId);
  await runAgentForChat(payload.chatId, reply, userId);
});
async function activeCharacter(payloadCid, userId) {
  if (payloadCid) {
    const c = await spindle.characters.get(payloadCid, userId);
    return c ? { id: c.id, name: c.name } : null;
  }
  const active = await spindle.chats.getActive(userId);
  if (!active) return null;
  return characterForChat(active.id, userId);
}
async function snapshot(cid, userId) {
  const meta = await loadMeta(cid);
  const entities = [];
  for (const [id, e] of Object.entries(meta.entries)) {
    let content = "";
    let keys = [];
    try {
      const entry = await spindle.world_books.entries.get(id, userId);
      if (entry) {
        content = entry.content;
        keys = entry.key;
      }
    } catch {
    }
    entities.push({ id, kind: e.kind, name: e.name, onstage: e.onstage, status: e.status, private: Boolean(e.private), audience: e.audience ?? [], keys, content });
  }
  return {
    characterId: cid,
    worldBookId: meta.worldBookId,
    currentLocation: meta.currentLocation,
    entities
  };
}
spindle.onFrontendMessage(async (payload, userId) => {
  switch (payload?.type) {
    case "get_config":
      spindle.sendToFrontend({ type: "config", config }, userId);
      break;
    case "set_config":
      config = {
        enabled: Boolean(payload.config?.enabled ?? config.enabled),
        maxRounds: clampInt(payload.config?.maxRounds ?? config.maxRounds, 1, 20),
        directive: String(payload.config?.directive ?? config.directive),
        agentTimeoutMs: clampInt(payload.config?.agentTimeoutMs ?? config.agentTimeoutMs, 5e3, 3e5)
      };
      await saveConfig();
      spindle.sendToFrontend({ type: "config", config }, userId);
      break;
    case "get_world": {
      const char = await activeCharacter(payload.characterId, userId);
      if (!char) {
        spindle.sendToFrontend({ type: "world", characterId: null, snapshot: null }, userId);
        break;
      }
      spindle.sendToFrontend({ type: "world", characterName: char.name, snapshot: await snapshot(char.id, userId) }, userId);
      break;
    }
    case "save_entity": {
      const char = await activeCharacter(payload.characterId, userId);
      if (!char || !payload.entity?.id) break;
      const meta = await loadMeta(char.id);
      const e = meta.entries[payload.entity.id];
      if (e) {
        const patch = {};
        if (typeof payload.entity.content === "string") patch.content = payload.entity.content;
        if (typeof payload.entity.name === "string") {
          e.name = payload.entity.name;
        }
        if (Object.keys(patch).length) await spindle.world_books.entries.update(payload.entity.id, patch, userId);
        await saveMeta(char.id, meta);
      }
      spindle.sendToFrontend({ type: "world", characterName: char.name, snapshot: await snapshot(char.id, userId) }, userId);
      break;
    }
    case "delete_entity": {
      const char = await activeCharacter(payload.characterId, userId);
      if (!char || !payload.id) break;
      const meta = await loadMeta(char.id);
      if (meta.entries[payload.id]) {
        try {
          await spindle.world_books.entries.delete(payload.id, userId);
        } catch {
        }
        delete meta.entries[payload.id];
        await saveMeta(char.id, meta);
      }
      spindle.sendToFrontend({ type: "world", characterName: char.name, snapshot: await snapshot(char.id, userId) }, userId);
      break;
    }
    case "reset_world": {
      const char = await activeCharacter(payload.characterId, userId);
      if (!char) break;
      const meta = await loadMeta(char.id);
      if (meta.worldBookId) {
        try {
          const c = await spindle.characters.get(char.id, userId);
          const remaining = (c?.world_book_ids ?? []).filter((b) => b !== meta.worldBookId);
          await spindle.characters.update(char.id, { world_book_ids: remaining, extensions: { worldforge: {} } }, userId);
          await spindle.world_books.delete(meta.worldBookId, userId);
        } catch {
        }
      }
      await saveMeta(char.id, emptyMeta(char.id));
      spindle.sendToFrontend({ type: "world", characterName: char.name, snapshot: await snapshot(char.id, userId) }, userId);
      break;
    }
  }
});
function clampInt(v, min, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
spindle.registerWorldInfoInterceptor(async (ctx) => {
  if (!config.enabled) return;
  const active = ctx.characterId;
  if (!active) return;
  const isProtagonist = true;
  const disabled = [];
  for (const entry of ctx.entries) {
    const aw = readAwareness(entry.extensions);
    if (!aw || !aw.private) continue;
    if (!isVisibleTo(aw, active, isProtagonist)) {
      disabled.push(entry.id);
    }
  }
  if (disabled.length) {
    spindle.log.info(`[worldforge] knowledge gate: hid ${disabled.length} private entr(ies) from ${active}`);
  }
  return { disabled };
}, 50);
(async () => {
  await loadConfig();
  spindle.log.info("[worldforge] loaded (World Books mode)");
})();
