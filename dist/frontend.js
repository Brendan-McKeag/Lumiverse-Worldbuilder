// src/frontend.ts
var KIND_ORDER = ["location", "character", "faction", "lore", "event"];
var KIND_LABEL = {
  location: "Locations",
  character: "Characters",
  faction: "Factions",
  lore: "Lore",
  event: "Events"
};
function setup(ctx) {
  let snap = null;
  let charId = null;
  let selectedId = null;
  const removeStyle = ctx.dom.addStyle(`
    .wf-wrap { display:flex; flex-direction:column; gap:10px; padding:12px; font-size:12.5px; color:var(--lumiverse-text); }
    .wf-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .wf-row.between { justify-content:space-between; }
    .wf-muted { color:var(--lumiverse-text-muted); font-size:11px; }
    .wf-h { font-size:12px; font-weight:600; color:var(--lumiverse-text-muted); margin:6px 0 2px; }
    .wf-card { background:var(--lumiverse-fill); border:1px solid var(--lumiverse-border); border-radius:var(--lumiverse-radius); padding:8px 10px; cursor:pointer; }
    .wf-card:hover { background:var(--lumiverse-fill-subtle); }
    .wf-card.sel { border-color:var(--lumiverse-accent,#6c8cff); }
    .wf-pill { font-size:10px; padding:1px 6px; border-radius:999px; border:1px solid var(--lumiverse-border); }
    .wf-pill.on { color:#4fbf67; border-color:#4fbf67; }
    .wf-pill.off { color:#d9a13b; border-color:#d9a13b; }
    .wf-pill.here { color:var(--lumiverse-accent,#6c8cff); border-color:var(--lumiverse-accent,#6c8cff); }
    .wf-btn { padding:5px 10px; font-size:12px; cursor:pointer; background:var(--lumiverse-fill); color:var(--lumiverse-text); border:1px solid var(--lumiverse-border); border-radius:var(--lumiverse-radius); }
    .wf-btn:hover { background:var(--lumiverse-fill-subtle); }
    .wf-btn.danger { color:#e5534b; }
    .wf-list { display:flex; flex-direction:column; gap:6px; }
    .wf-section { border-top:1px solid var(--lumiverse-border); padding-top:10px; display:flex; flex-direction:column; gap:8px; }
    .wf-input,.wf-ta { width:100%; padding:6px 8px; font-size:12px; background:var(--lumiverse-fill); color:var(--lumiverse-text); border:1px solid var(--lumiverse-border); border-radius:var(--lumiverse-radius); }
    .wf-ta { min-height:90px; resize:vertical; font-family:inherit; }
    .wf-keys { font-size:10px; color:var(--lumiverse-text-muted); }
  `);
  const tab = ctx.ui.registerDrawerTab({
    id: "worldforge",
    title: "WorldForge",
    shortName: "World",
    headerTitle: "WorldForge",
    description: "Inspect the character's living, self-expanding world",
    keywords: ["world", "worldforge", "lore", "locations", "npc", "characters", "world book"],
    iconSvg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18"/></svg>'
  });
  tab.root.innerHTML = `
    <div class="wf-wrap">
      <div class="wf-row between">
        <span class="wf-muted wf-status">Loading\u2026</span>
        <button class="wf-btn wf-refresh">Refresh</button>
      </div>
      <div class="wf-list wf-entities"></div>

      <div class="wf-section wf-detail" style="display:none">
        <h4 class="wf-h">Selected entry</h4>
        <input class="wf-input wf-d-name" />
        <div class="wf-keys wf-d-keys"></div>
        <textarea class="wf-ta wf-d-content" placeholder="Entry content (revealed when keywords match)"></textarea>
        <div class="wf-row">
          <button class="wf-btn wf-d-save">Save</button>
          <button class="wf-btn danger wf-d-del">Delete</button>
        </div>
      </div>

      <div class="wf-section">
        <h4 class="wf-h">Agent activity</h4>
        <div class="wf-muted wf-activity">No activity yet.</div>
      </div>

      <div class="wf-section">
        <h4 class="wf-h">Settings</h4>
        <label class="wf-row"><input type="checkbox" class="wf-en" /> Enabled</label>
        <div><span class="wf-muted">Agent rounds per turn</span><input type="number" class="wf-input wf-rounds" min="1" max="20" /></div>
        <div><span class="wf-muted">Agent directive (optional)</span><textarea class="wf-ta wf-dir" placeholder="e.g. Grim, low-magic tone. Keep two rival NPCs scheming off-screen."></textarea></div>
        <div class="wf-row">
          <button class="wf-btn wf-save-cfg">Save settings</button>
          <button class="wf-btn danger wf-reset">Reset world</button>
        </div>
      </div>
    </div>
  `;
  const q = (s) => tab.root.querySelector(s);
  const status = q(".wf-status");
  const entitiesEl = q(".wf-entities");
  const detail = q(".wf-detail");
  const dName = q(".wf-d-name");
  const dKeys = q(".wf-d-keys");
  const dContent = q(".wf-d-content");
  const activity = q(".wf-activity");
  const enEl = q(".wf-en");
  const roundsEl = q(".wf-rounds");
  const dirEl = q(".wf-dir");
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  function render() {
    if (!snap || snap.entities.length === 0) {
      entitiesEl.innerHTML = '<span class="wf-muted">No world yet. It grows as the story moves \u2014 the agent will create locations, characters, and lore.</span>';
      detail.style.display = "none";
      return;
    }
    const byKind = (k) => snap.entities.filter((e) => e.kind === k);
    let html = "";
    for (const kind of KIND_ORDER) {
      const list = byKind(kind);
      if (!list.length) continue;
      html += `<h4 class="wf-h">${KIND_LABEL[kind]}</h4>`;
      for (const e of list) {
        const pills = [];
        if (e.kind === "character")
          pills.push(e.onstage ? '<span class="wf-pill on">on-stage</span>' : '<span class="wf-pill off">off-stage</span>');
        if (e.kind === "location" && e.name === snap.currentLocation)
          pills.push('<span class="wf-pill here">player here</span>');
        if (e.private)
          pills.push(
            `<span class="wf-pill off" title="Only these characters know this">private \xB7 ${(e.audience ?? []).join(", ") || "no one"}</span>`
          );
        html += `<div class="wf-card ${e.id === selectedId ? "sel" : ""}" data-id="${e.id}">
          <div class="wf-row between"><strong>${esc(e.name)}</strong>${pills.join(" ")}</div>
          <div class="wf-muted">${esc((e.content || "").slice(0, 90))}${e.content.length > 90 ? "\u2026" : ""}</div>
        </div>`;
      }
    }
    entitiesEl.innerHTML = html;
    entitiesEl.querySelectorAll(".wf-card").forEach(
      (el) => el.addEventListener("click", () => select(el.dataset.id))
    );
  }
  function select(id) {
    const e = snap?.entities.find((x) => x.id === id);
    if (!e) return;
    selectedId = id;
    detail.style.display = "flex";
    dName.value = e.name;
    dKeys.textContent = `keywords: ${e.keys.join(", ") || "(none)"}`;
    dContent.value = e.content;
    render();
  }
  const requestWorld = () => {
    const { characterId } = ctx.getActiveChat();
    ctx.sendToBackend({ type: "get_world", characterId });
  };
  ctx.sendToBackend({ type: "get_config" });
  requestWorld();
  tab.onActivate(requestWorld);
  ctx.events.on("CHAT_SWITCHED", () => requestWorld());
  q(".wf-refresh").addEventListener("click", requestWorld);
  q(".wf-d-save").addEventListener("click", () => {
    if (!selectedId) return;
    ctx.sendToBackend({
      type: "save_entity",
      characterId: charId,
      entity: { id: selectedId, name: dName.value, content: dContent.value }
    });
  });
  q(".wf-d-del").addEventListener("click", async () => {
    if (!selectedId) return;
    const { confirmed } = await ctx.ui.showConfirm({
      title: "Delete entry",
      message: "Remove this entity and its World Book entry?",
      variant: "danger",
      confirmLabel: "Delete"
    });
    if (confirmed) {
      ctx.sendToBackend({ type: "delete_entity", characterId: charId, id: selectedId });
      selectedId = null;
      detail.style.display = "none";
    }
  });
  q(".wf-reset").addEventListener("click", async () => {
    const { confirmed } = await ctx.ui.showConfirm({
      title: "Reset world",
      message: "Delete this character's WorldForge book and all tracked entities? Your own world books are untouched.",
      variant: "danger",
      confirmLabel: "Erase"
    });
    if (confirmed) ctx.sendToBackend({ type: "reset_world", characterId: charId });
  });
  q(".wf-save-cfg").addEventListener("click", () => {
    ctx.sendToBackend({
      type: "set_config",
      config: { enabled: enEl.checked, maxRounds: Number(roundsEl.value), directive: dirEl.value }
    });
  });
  const unsub = ctx.onBackendMessage((raw) => {
    const p = raw;
    switch (p?.type) {
      case "world": {
        snap = p.snapshot ?? null;
        charId = snap?.characterId ?? null;
        status.textContent = charId ? snap && snap.entities.length ? `${snap.entities.length} entities \xB7 ${p.characterName ?? ""}` : "World is empty" : "No active character";
        if (selectedId && !snap?.entities.some((e) => e.id === selectedId)) {
          selectedId = null;
          detail.style.display = "none";
        }
        render();
        break;
      }
      case "world_changed": {
        if (p.characterId === charId) {
          activity.textContent = `Last turn: ${p.edits} edits over ${p.rounds} rounds${p.note ? ` \u2014 ${p.note}` : ""}`;
          tab.setBadge("\u2022");
          setTimeout(() => tab.setBadge(null), 4e3);
          requestWorld();
        }
        break;
      }
      case "config": {
        const c = p.config ?? {};
        enEl.checked = c.enabled !== false;
        roundsEl.value = String(c.maxRounds ?? 6);
        dirEl.value = c.directive ?? "";
        break;
      }
    }
  });
  return () => {
    unsub();
    tab.destroy();
    removeStyle();
    ctx.dom.cleanup();
  };
}
export {
  setup
};
