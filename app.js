// ── Constants ────────────────────────────────────────

const STORAGE_KEY = 'todofantassy_v2';
const PROXY_URL = '/api/gemini';
const GEMINI_DIRECT_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const SLOTS = ['head', 'body', 'legs', 'feet', 'hands', 'leftHand', 'rightHand'];

const xpToNext = (level) => level * 100;

const BASE_SLOT_COOLDOWN_MS = 120 * 60 * 1000;
const STR_COOLDOWN_REDUCTION_MS = 5 * 60 * 1000;
const MIN_SLOT_COOLDOWN_MS = 20 * 60 * 1000;
const MAX_QUEST_SLOTS = 3;

const INT_XP_BONUS = 0.05;

const LUK_CRIT_BASE = 0.05;
const LUK_CRIT_PER = 0.02;
const LUK_CRIT_MAX = 0.80;

// ── Card / Deck ──────────────────────────────────────

const CARD_DEFS = {
  xp1:         { name: '경험치 +1',        label: 'XP +1',     effect: { xp: 1 } },
  xp2:         { name: '경험치 +2',        label: 'XP +2',     effect: { xp: 2 } },
  xp3:         { name: '경험치 +3',        label: 'XP +3',     effect: { xp: 3 } },
  item_normal: { name: '일반 아이템 획득', label: '⚔ 일반',   effect: { drop: 'normal' } },
  item_unique: { name: '유니크 아이템 획득', label: '✨ 유니크', effect: { drop: 'unique' } },
  curse:       { name: '저주 (꽝)',        label: '💀 저주',   effect: {} },
  draw_extra:  { name: '카드 +2 드로우',   label: '🎴 +2 드로우', cast: 'draw2', desc: '뽑을 시 시전' },
  xp_bonus:    { name: '즉시 +1 XP',       label: '⚡ XP+1 즉시', cast: 'xp1', desc: '뽑을 시 시전' },
};

const DRAW_BY_DIFFICULTY = { '하': 1, '중': 2, '상': 3 };

function defaultDeck() {
  return [
    'curse',
    'item_unique',
    'item_normal', 'item_normal', 'item_normal',
    'xp3', 'xp3', 'xp3',
    'xp2', 'xp2', 'xp2', 'xp2', 'xp2',
    'xp1', 'xp1', 'xp1', 'xp1', 'xp1', 'xp1', 'xp1',
  ];
}

// ── State ────────────────────────────────────────────

function defaultState() {
  return {
    character: {
      jobInput: '',
      jobFantasy: '',
      level: 1,
      xp: 0,
      stats: { str: 0, luk: 0, int: 0 },
      deck: defaultDeck(),
      pendingLevelUps: 0,
      inventory: [],
      equipped: { head: null, body: null, legs: null, feet: null, hands: null, leftHand: null, rightHand: null },
      questSlots: { available: MAX_QUEST_SLOTS, lastRecoveredAt: Date.now() },
    },
    quests: [],
  };
}

let state = loadState();

// 카드 픽/덱 선택의 임시 컨텍스트 (localStorage에 저장 X)
let currentRewardCtx = null;
let deckSelectAction = null;

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return defaultState();
  try {
    const parsed = JSON.parse(raw);
    const def = defaultState();
    parsed.character = { ...def.character, ...parsed.character };
    parsed.character.stats = { ...def.character.stats, ...parsed.character.stats };
    parsed.character.equipped = { ...def.character.equipped, ...parsed.character.equipped };
    parsed.character.questSlots = { ...def.character.questSlots, ...parsed.character.questSlots };
    if (!Array.isArray(parsed.character.deck) || parsed.character.deck.length === 0) {
      parsed.character.deck = defaultDeck();
    }
    parsed.character.pendingLevelUps ||= 0;
    delete parsed.character.pendingStatPoints;
    parsed.quests ||= [];
    return parsed;
  } catch {
    return defaultState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ── Game Math ────────────────────────────────────────

function totalStats() {
  const total = { ...state.character.stats };
  for (const slot of SLOTS) {
    const item = state.character.equipped[slot];
    if (!item) continue;
    total.str += item.stats.str || 0;
    total.luk += item.stats.luk || 0;
    total.int += item.stats.int || 0;
  }
  return total;
}

function slotCooldownMs() {
  const { str } = totalStats();
  return Math.max(MIN_SLOT_COOLDOWN_MS, BASE_SLOT_COOLDOWN_MS - str * STR_COOLDOWN_REDUCTION_MS);
}

function recoverQuestSlots() {
  const qs = state.character.questSlots;
  if (qs.available >= MAX_QUEST_SLOTS) {
    qs.lastRecoveredAt = Date.now();
    return;
  }
  const cd = slotCooldownMs();
  const elapsed = Date.now() - qs.lastRecoveredAt;
  const recovered = Math.floor(elapsed / cd);
  if (recovered <= 0) return;
  const toAdd = Math.min(MAX_QUEST_SLOTS - qs.available, recovered);
  qs.available += toAdd;
  qs.lastRecoveredAt += toAdd * cd;
  if (qs.available >= MAX_QUEST_SLOTS) qs.lastRecoveredAt = Date.now();
}

function consumeQuestSlot() {
  recoverQuestSlots();
  const qs = state.character.questSlots;
  if (qs.available <= 0) return false;
  if (qs.available === MAX_QUEST_SLOTS) qs.lastRecoveredAt = Date.now();
  qs.available -= 1;
  return true;
}

function rollCrit() {
  const { luk } = totalStats();
  const chance = Math.min(LUK_CRIT_MAX, LUK_CRIT_BASE + luk * LUK_CRIT_PER);
  return Math.random() < chance;
}

function gainXp(baseXp) {
  const { int } = totalStats();
  const gained = Math.round(baseXp * (1 + int * INT_XP_BONUS));
  const c = state.character;
  c.xp += gained;
  while (c.xp >= xpToNext(c.level)) {
    c.xp -= xpToNext(c.level);
    c.level += 1;
    c.pendingLevelUps += 1;
  }
  return gained;
}

// ── Reward Deck ──────────────────────────────────────

function drawReward(difficulty) {
  const baseN = DRAW_BY_DIFFICULTY[difficulty] || 1;
  const pool = [...state.character.deck];
  const drawn = [];
  let toDraw = baseN;
  while (toDraw > 0 && pool.length > 0) {
    const idx = Math.floor(Math.random() * pool.length);
    const cardId = pool.splice(idx, 1)[0];
    drawn.push(cardId);
    toDraw -= 1;
    if (CARD_DEFS[cardId].cast === 'draw2') toDraw += 2;
  }
  return drawn;
}

function partitionDrawn(drawn) {
  const cast = [];
  const candidates = [];
  for (const c of drawn) {
    (CARD_DEFS[c].cast ? cast : candidates).push(c);
  }
  return { cast, candidates };
}

async function applyChosenCard(cardId, questFantasy, crit) {
  const def = CARD_DEFS[cardId];
  const eff = def.effect || {};
  const mult = crit ? 2 : 1;
  if (eff.xp) {
    const gained = gainXp(eff.xp * mult);
    showToast(`경험치 +${gained}${crit ? ' (치명타!)' : ''}`);
  } else if (eff.drop) {
    const isUnique = eff.drop === 'unique';
    for (let i = 0; i < mult; i++) {
      const slot = SLOTS[Math.floor(Math.random() * SLOTS.length)];
      try {
        const item = await generateEquipment(slot, isUnique, questFantasy);
        state.character.inventory.unshift(item);
        showToast(`${isUnique ? '✨ 유니크 ' : ''}장비 획득 — ${item.name}`);
      } catch (e) {
        showToast('보물 생성 실패: ' + e.message);
      }
    }
  } else {
    showToast('💀 저주 — 보상이 없다');
  }
}

// ── Gemini API ───────────────────────────────────────

async function callGemini(systemPrompt, userText, jsonMode = false) {
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      maxOutputTokens: 1500,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  if (jsonMode) body.generationConfig.responseMimeType = 'application/json';

  const url = window.GEMINI_KEY
    ? `${GEMINI_DIRECT_URL}?key=${window.GEMINI_KEY}`
    : PROXY_URL;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message
      || (typeof err?.error === 'string' && err.error)
      || `API 오류 (${res.status})`;
    throw new Error(msg);
  }
  const data = await res.json();
  return data.candidates[0].content.parts[0].text.trim();
}

async function generateJob(input) {
  const text = await callGemini(JOB_TRANSFORM_PROMPT, input, false);
  return text.replace(/^["']|["']$/g, '');
}

async function transformQuest(task) {
  const text = await callGemini(buildQuestPrompt(state.character.jobFantasy), task, true);
  const parsed = JSON.parse(text);
  if (!parsed.title || !parsed.fantasy || !['상', '중', '하'].includes(parsed.difficulty)) {
    throw new Error('변환 결과 형식 오류');
  }
  return parsed;
}

async function generateEquipment(slot, isUnique, questFantasy) {
  const text = await callGemini(
    buildEquipmentPrompt(state.character.jobFantasy, questFantasy, slot, isUnique),
    '장비를 생성해주세요.',
    true,
  );
  const parsed = JSON.parse(text);
  return {
    id: Date.now() + Math.random(),
    name: parsed.name || '이름 없는 보물',
    slot,
    stats: {
      str: parsed.stats?.str || 0,
      luk: parsed.stats?.luk || 0,
      int: parsed.stats?.int || 0,
    },
    uniqueEffect: parsed.unique_effect || '',
    rarity: isUnique ? 'unique' : 'normal',
  };
}

// ── Quest Actions ────────────────────────────────────

async function addQuest() {
  const input = document.getElementById('todoInput');
  const task = input.value.trim();
  if (!task) return;

  recoverQuestSlots();
  if (state.character.questSlots.available <= 0) {
    showToast('퀘스트 슬롯이 모두 소진되었습니다');
    return;
  }

  const btn = document.getElementById('addBtn');
  setBtnBusy(btn, '변환 중...');

  try {
    const { title, fantasy, difficulty } = await transformQuest(task);
    if (!consumeQuestSlot()) {
      showToast('퀘스트 슬롯이 모두 소진되었습니다');
      return;
    }
    state.quests.unshift({
      id: Date.now(),
      original: task,
      title,
      fantasy,
      difficulty,
      done: false,
    });
    saveState();
    renderAll();
    input.value = '';
    showToast(`새 퀘스트 기록 — 난이도 [${difficulty}]`);
  } catch (e) {
    showToast('오류: ' + e.message);
  } finally {
    setBtnBusy(btn, '퀘스트 등록', false);
  }
}

async function completeQuest(id) {
  const q = state.quests.find(q => q.id === id);
  if (!q || q.done) return;
  q.done = true;
  saveState();
  renderAll();

  const crit = rollCrit();
  if (crit) showToast('🎯 치명타! 이번 보상 ×2');

  const drawn = drawReward(q.difficulty);
  const { cast, candidates } = partitionDrawn(drawn);

  // 즉시 시전 효과 적용 (크리 시 ×2)
  let castXp = 0;
  for (const c of cast) {
    if (CARD_DEFS[c].cast === 'xp1') castXp += 1;
  }
  if (castXp > 0) gainXp(castXp * (crit ? 2 : 1));
  saveState();
  renderAll();

  if (candidates.length > 0) {
    openCardPickModal(q.fantasy, candidates, cast, crit);
  } else {
    if (cast.length > 0) showToast(`즉시 효과 ${cast.length}건 적용`);
    else showToast('뽑은 카드가 없다');
    if (state.character.pendingLevelUps > 0) openLevelupModal();
  }
}

function uncompleteQuest(id) {
  const q = state.quests.find(q => q.id === id);
  if (!q || !q.done) return;
  q.done = false;
  saveState();
  renderAll();
}

function deleteQuest(id) {
  state.quests = state.quests.filter(q => q.id !== id);
  saveState();
  renderAll();
}

// ── Equipment Actions ────────────────────────────────

function equipItem(itemId) {
  const idx = state.character.inventory.findIndex(i => i.id === itemId);
  if (idx < 0) return;
  const item = state.character.inventory[idx];
  const prev = state.character.equipped[item.slot];
  state.character.equipped[item.slot] = item;
  state.character.inventory.splice(idx, 1);
  if (prev) state.character.inventory.unshift(prev);
  saveState();
  renderAll();
}

function unequipSlot(slot) {
  const item = state.character.equipped[slot];
  if (!item) return;
  state.character.equipped[slot] = null;
  state.character.inventory.unshift(item);
  saveState();
  renderAll();
}

function discardItem(itemId) {
  state.character.inventory = state.character.inventory.filter(i => i.id !== itemId);
  saveState();
  renderAll();
}

// ── Card Pick Modal ──────────────────────────────────

function openCardPickModal(questFantasy, candidates, cast, crit) {
  currentRewardCtx = { questFantasy, candidates, cast, crit };
  document.getElementById('cardPickModal').classList.remove('hidden');
  renderCardPickModal();
}

function closeCardPickModal() {
  document.getElementById('cardPickModal').classList.add('hidden');
  currentRewardCtx = null;
}

function renderCardPickModal() {
  if (!currentRewardCtx) return;
  const { candidates, cast, crit } = currentRewardCtx;
  document.getElementById('cardPickHint').innerHTML =
    (crit ? '🎯 <b>치명타!</b> 이번 보상 ×2 — ' : '') + '한 장을 선택하시오';
  const list = document.getElementById('cardPickList');
  list.innerHTML = '';

  if (cast.length > 0) {
    const head = document.createElement('div');
    head.className = 'card-section-heading';
    head.textContent = '⚡ 즉시 발동' + (crit ? ' (×2)' : '');
    list.appendChild(head);
    for (const cardId of cast) {
      list.appendChild(buildCardEl(cardId, false));
    }
  }

  const head2 = document.createElement('div');
  head2.className = 'card-section-heading';
  head2.textContent = `🎴 한 장 선택 (${candidates.length}장)` + (crit ? ' — ×2 적용' : '');
  list.appendChild(head2);
  for (const cardId of candidates) {
    list.appendChild(buildCardEl(cardId, true));
  }
}

function buildCardEl(cardId, clickable) {
  const def = CARD_DEFS[cardId];
  const el = document.createElement(clickable ? 'button' : 'div');
  el.className = `card card-${cardId}` + (clickable ? ' candidate' : ' cast');
  el.dataset.id = cardId;
  el.innerHTML = `
    <div class="card-label">${escapeHtml(def.label)}</div>
    <div class="card-name">${escapeHtml(def.name)}</div>
    ${def.desc ? `<div class="card-desc">${escapeHtml(def.desc)}</div>` : ''}
  `;
  return el;
}

async function pickRewardCard(cardId) {
  if (!currentRewardCtx) return;
  const ctx = currentRewardCtx;
  closeCardPickModal();
  await applyChosenCard(cardId, ctx.questFantasy, ctx.crit);
  saveState();
  renderAll();
  if (state.character.pendingLevelUps > 0) openLevelupModal();
}

// ── Levelup Modal ────────────────────────────────────

function openLevelupModal() {
  if (state.character.pendingLevelUps <= 0) return;
  document.getElementById('levelupModal').classList.remove('hidden');
  renderLevelupModal();
}

function closeLevelupModal() {
  document.getElementById('levelupModal').classList.add('hidden');
}

function renderLevelupModal() {
  document.getElementById('levelupRemaining').textContent = state.character.pendingLevelUps;
}

function pickLevelupOption(optionId) {
  if (optionId === 'remove' || optionId === 'copy') {
    closeLevelupModal();
    openDeckSelectModal(optionId);
    return;
  }
  if (optionId === 'add_draw_extra') {
    state.character.deck.push('draw_extra');
    showToast('덱에 "카드 +2 드로우" 추가');
  } else if (optionId === 'add_xp_bonus') {
    state.character.deck.push('xp_bonus');
    showToast('덱에 "즉시 +1 XP" 추가');
  }
  finishLevelupChoice();
}

function finishLevelupChoice() {
  state.character.pendingLevelUps -= 1;
  saveState();
  renderAll();
  if (state.character.pendingLevelUps > 0) {
    openLevelupModal();
  } else {
    closeLevelupModal();
  }
}

// ── Deck Select Modal ────────────────────────────────

function openDeckSelectModal(action) {
  deckSelectAction = action;
  document.getElementById('deckSelectModal').classList.remove('hidden');
  renderDeckSelectModal();
}

function closeDeckSelectModal() {
  document.getElementById('deckSelectModal').classList.add('hidden');
  deckSelectAction = null;
}

function renderDeckSelectModal() {
  document.getElementById('deckSelectTitle').textContent =
    deckSelectAction === 'remove' ? '🗑 제거할 카드 선택' : '📑 복사할 카드 선택';

  const counts = {};
  for (const c of state.character.deck) counts[c] = (counts[c] || 0) + 1;

  const order = ['xp1', 'xp2', 'xp3', 'item_normal', 'item_unique', 'curse', 'draw_extra', 'xp_bonus'];
  const list = document.getElementById('deckSelectList');
  list.innerHTML = '';
  for (const cardId of order) {
    if (!counts[cardId]) continue;
    const def = CARD_DEFS[cardId];
    const el = document.createElement('button');
    el.className = `card card-${cardId} candidate`;
    el.dataset.id = cardId;
    el.innerHTML = `
      <div class="card-label">${escapeHtml(def.label)}</div>
      <div class="card-name">${escapeHtml(def.name)}</div>
      <div class="card-count">×${counts[cardId]}</div>
    `;
    list.appendChild(el);
  }
}

function pickDeckCard(cardId) {
  const action = deckSelectAction;
  const deck = state.character.deck;
  if (action === 'remove') {
    const idx = deck.indexOf(cardId);
    if (idx >= 0) deck.splice(idx, 1);
    showToast(`덱에서 제거: ${CARD_DEFS[cardId].name}`);
  } else if (action === 'copy') {
    deck.push(cardId);
    showToast(`덱에 추가: ${CARD_DEFS[cardId].name}`);
  }
  closeDeckSelectModal();
  finishLevelupChoice();
}

function cancelDeckSelect() {
  closeDeckSelectModal();
  openLevelupModal();
}

// ── Onboarding ───────────────────────────────────────

async function submitOnboarding() {
  const input = document.getElementById('jobInput');
  const jobInput = input.value.trim();
  if (!jobInput) return;

  const btn = document.getElementById('jobSubmitBtn');
  setBtnBusy(btn, '운명 점지 중...');

  try {
    const jobFantasy = await generateJob(jobInput);
    state.character.jobInput = jobInput;
    state.character.jobFantasy = jobFantasy;
    state.character.questSlots.lastRecoveredAt = Date.now();
    saveState();
    renderAll();
    showToast(`그대는 이제 "${jobFantasy}"이다`);
  } catch (e) {
    showToast('오류: ' + e.message);
  } finally {
    setBtnBusy(btn, '운명을 받아들이다', false);
  }
}

// ── Rendering ────────────────────────────────────────

function renderAll() {
  const onboarded = !!state.character.jobFantasy;
  document.getElementById('onboarding').classList.toggle('hidden', onboarded);
  document.getElementById('game').classList.toggle('hidden', !onboarded);
  if (!onboarded) return;

  recoverQuestSlots();
  renderCharacterPanel();
  renderEquipment();
  renderInventory();
  renderQuests();
  renderDeckSummary();
}

function renderCharacterPanel() {
  const c = state.character;
  const total = totalStats();
  document.getElementById('charJob').textContent = c.jobFantasy;
  document.getElementById('charLevel').textContent = c.level;

  const need = xpToNext(c.level);
  document.getElementById('xpText').textContent = `${c.xp} / ${need}`;
  document.getElementById('xpFill').style.width = `${Math.min(100, (c.xp / need) * 100)}%`;

  const renderStat = (key, label) => {
    const base = c.stats[key];
    const equip = total[key] - base;
    const span = document.getElementById(`stat-${key}`);
    span.innerHTML = `${label} <b>${total[key]}</b>` + (equip > 0 ? ` <em>(${base}+${equip})</em>` : '');
  };
  renderStat('str', '힘');
  renderStat('luk', '운');
  renderStat('int', '지능');

  const pending = document.getElementById('pendingPoints');
  if (c.pendingLevelUps > 0) {
    pending.classList.remove('hidden');
    pending.textContent = `레벨업 선택 +${c.pendingLevelUps}`;
  } else {
    pending.classList.add('hidden');
  }

  document.getElementById('slotCount').textContent = `${c.questSlots.available} / ${MAX_QUEST_SLOTS}`;
  const next = document.getElementById('slotNext');
  if (c.questSlots.available >= MAX_QUEST_SLOTS) {
    next.textContent = '가득 참';
  } else {
    const remain = c.questSlots.lastRecoveredAt + slotCooldownMs() - Date.now();
    next.textContent = `다음 회복: ${formatDuration(Math.max(0, remain))}`;
  }
}

function renderDeckSummary() {
  const root = document.getElementById('deckSummary');
  if (!root) return;
  const counts = {};
  for (const c of state.character.deck) counts[c] = (counts[c] || 0) + 1;
  const order = ['xp1', 'xp2', 'xp3', 'item_normal', 'item_unique', 'curse', 'draw_extra', 'xp_bonus'];
  root.innerHTML = `<span class="deck-summary-total">총 ${state.character.deck.length}장</span>` +
    order.filter(id => counts[id]).map(id =>
      `<span class="deck-summary-chip" title="${escapeHtml(CARD_DEFS[id].name)}">${escapeHtml(CARD_DEFS[id].label)} ×${counts[id]}</span>`
    ).join('');
}

function renderEquipment() {
  const root = document.getElementById('equipmentSlots');
  root.innerHTML = '';
  for (const slot of SLOTS) {
    const item = state.character.equipped[slot];
    const el = document.createElement('div');
    el.className = 'equip-slot' + (item ? ' filled' : '');
    el.innerHTML = `
      <div class="equip-slot-label">${SLOT_NAMES_KO[slot]}</div>
      ${item
        ? `<div class="equip-slot-item ${item.rarity}">
             <div class="equip-slot-name">${escapeHtml(item.name)}</div>
             <div class="equip-slot-stats">${formatStats(item.stats)}</div>
             ${item.uniqueEffect ? `<div class="equip-slot-effect">${escapeHtml(item.uniqueEffect)}</div>` : ''}
             <button class="equip-unequip" data-slot="${slot}">해제</button>
           </div>`
        : `<div class="equip-slot-empty">— 비어있음 —</div>`
      }
    `;
    root.appendChild(el);
  }
}

function renderInventory() {
  const root = document.getElementById('inventoryList');
  root.innerHTML = '';
  if (state.character.inventory.length === 0) {
    root.innerHTML = '<p class="empty-state">— 인벤토리가 비어있습니다 —</p>';
    return;
  }
  for (const item of state.character.inventory) {
    const el = document.createElement('div');
    el.className = `inv-item ${item.rarity}`;
    el.innerHTML = `
      <div class="inv-item-header">
        <span class="inv-item-slot">[${SLOT_NAMES_KO[item.slot]}]</span>
        <span class="inv-item-name">${escapeHtml(item.name)}</span>
      </div>
      <div class="inv-item-stats">${formatStats(item.stats)}</div>
      ${item.uniqueEffect ? `<div class="inv-item-effect">${escapeHtml(item.uniqueEffect)}</div>` : ''}
      <div class="inv-item-actions">
        <button class="inv-equip" data-id="${item.id}">장착</button>
        <button class="inv-discard" data-id="${item.id}">버리기</button>
      </div>
    `;
    root.appendChild(el);
  }
}

function renderQuests() {
  const list = document.getElementById('questList');
  list.innerHTML = '';
  if (state.quests.length === 0) {
    list.innerHTML = '<p class="empty-state">아직 등록된 퀘스트가 없습니다.<br/>그대의 첫 번째 임무를 고하십시오.</p>';
    return;
  }
  for (const q of state.quests) {
    const item = document.createElement('div');
    item.className = `quest-item${q.done ? ' done' : ''} diff-${q.difficulty}`;
    item.dataset.id = q.id;
    const title = q.title || q.fantasy;
    item.innerHTML = `
      <input type="checkbox" class="quest-checkbox" ${q.done ? 'checked' : ''} title="완료 처리" />
      <div class="quest-content">
        <div class="quest-title">
          <span class="quest-diff">[${q.difficulty}]</span>
          ${escapeHtml(title)}
        </div>
        <div class="quest-fantasy">${escapeHtml(q.fantasy)}</div>
        <div class="quest-original">원문: ${escapeHtml(q.original)}</div>
      </div>
      <button class="quest-delete" title="삭제">✕</button>
    `;
    list.appendChild(item);
  }
}

// ── Helpers ──────────────────────────────────────────

function formatStats(stats) {
  const parts = [];
  if (stats.str) parts.push(`힘 +${stats.str}`);
  if (stats.luk) parts.push(`운 +${stats.luk}`);
  if (stats.int) parts.push(`지능 +${stats.int}`);
  return parts.length ? parts.join(' · ') : '— 효과 없음 —';
}

function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분 ${s}초`;
  return `${s}초`;
}

function setBtnBusy(btn, text, busy = true) {
  btn.disabled = busy;
  const textEl = btn.querySelector('.btn-text');
  const spinner = btn.querySelector('.spinner');
  if (textEl) textEl.textContent = text;
  if (spinner) spinner.classList.toggle('hidden', !busy);
}

let toastTimer;
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3000);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Init ─────────────────────────────────────────────

(function init() {
  document.getElementById('jobSubmitBtn').addEventListener('click', submitOnboarding);
  document.getElementById('jobInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitOnboarding();
  });

  document.getElementById('addBtn').addEventListener('click', addQuest);
  document.getElementById('todoInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') addQuest();
  });

  const questList = document.getElementById('questList');
  questList.addEventListener('change', e => {
    const item = e.target.closest('.quest-item');
    if (!item || !e.target.classList.contains('quest-checkbox')) return;
    const id = Number(item.dataset.id);
    if (e.target.checked) completeQuest(id);
    else uncompleteQuest(id);
  });
  questList.addEventListener('click', e => {
    const item = e.target.closest('.quest-item');
    if (!item) return;
    if (e.target.classList.contains('quest-delete')) {
      deleteQuest(Number(item.dataset.id));
    } else if (e.target.classList.contains('quest-content') || e.target.closest('.quest-content')) {
      item.classList.toggle('expanded');
    }
  });

  document.getElementById('inventoryList').addEventListener('click', e => {
    const id = Number(e.target.dataset.id);
    if (e.target.classList.contains('inv-equip')) equipItem(id);
    else if (e.target.classList.contains('inv-discard')) discardItem(id);
  });
  document.getElementById('equipmentSlots').addEventListener('click', e => {
    if (e.target.classList.contains('equip-unequip')) unequipSlot(e.target.dataset.slot);
  });

  // 카드 픽 모달
  document.getElementById('cardPickList').addEventListener('click', e => {
    const card = e.target.closest('.card.candidate');
    if (!card) return;
    pickRewardCard(card.dataset.id);
  });

  // 레벨업 모달
  document.getElementById('pendingPoints').addEventListener('click', openLevelupModal);
  document.querySelectorAll('[data-levelup]').forEach(b => {
    b.addEventListener('click', () => pickLevelupOption(b.dataset.levelup));
  });

  // 덱 선택 모달
  document.getElementById('deckSelectList').addEventListener('click', e => {
    const card = e.target.closest('.card.candidate');
    if (!card) return;
    pickDeckCard(card.dataset.id);
  });
  document.getElementById('deckSelectClose').addEventListener('click', cancelDeckSelect);

  document.getElementById('resetBtn').addEventListener('click', () => {
    if (confirm('모든 데이터를 초기화하고 처음부터 시작합니다. 진행하시겠습니까?')) {
      localStorage.removeItem(STORAGE_KEY);
      location.reload();
    }
  });

  setInterval(() => {
    if (!state.character.jobFantasy) return;
    recoverQuestSlots();
    renderCharacterPanel();
  }, 1000);

  renderAll();
})();
