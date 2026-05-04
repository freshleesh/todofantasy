// ── Constants ────────────────────────────────────────

const STORAGE_KEY = 'todofantassy_v2';
const GEMINI_URL = '/api/gemini';

const SLOTS = ['head', 'body', 'legs', 'feet', 'hands', 'leftHand', 'rightHand'];

const STAT_POINTS_PER_LEVEL = 5;
const xpToNext = (level) => level * 100;

const XP_BY_DIFFICULTY = { '하': 10, '중': 25, '상': 60 };

const BASE_SLOT_COOLDOWN_MS = 120 * 60 * 1000;
const STR_COOLDOWN_REDUCTION_MS = 5 * 60 * 1000;
const MIN_SLOT_COOLDOWN_MS = 20 * 60 * 1000;
const MAX_QUEST_SLOTS = 3;

const BASE_DROP_RATE = 0.30;
const LUK_DROP_BONUS = 0.02;
const MAX_DROP_RATE = 0.90;
const BASE_UNIQUE_RATE = 0.05;
const LUK_UNIQUE_BONUS = 0.01;
const MAX_UNIQUE_RATE = 0.50;

const INT_XP_BONUS = 0.05;

// ── State ────────────────────────────────────────────

function defaultState() {
  return {
    character: {
      jobInput: '',
      jobFantasy: '',
      level: 1,
      xp: 0,
      stats: { str: 0, luk: 0, int: 0 },
      pendingStatPoints: 0,
      inventory: [],
      equipped: { head: null, body: null, legs: null, feet: null, hands: null, leftHand: null, rightHand: null },
      questSlots: { available: MAX_QUEST_SLOTS, lastRecoveredAt: Date.now() },
    },
    quests: [],
  };
}

let state = loadState();

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return defaultState();
  try {
    const parsed = JSON.parse(raw);
    // 누락 필드 보강
    const def = defaultState();
    parsed.character = { ...def.character, ...parsed.character };
    parsed.character.stats = { ...def.character.stats, ...parsed.character.stats };
    parsed.character.equipped = { ...def.character.equipped, ...parsed.character.equipped };
    parsed.character.questSlots = { ...def.character.questSlots, ...parsed.character.questSlots };
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

function gainXp(baseXp) {
  const { int } = totalStats();
  const gained = Math.round(baseXp * (1 + int * INT_XP_BONUS));
  const c = state.character;
  c.xp += gained;
  let levelsGained = 0;
  while (c.xp >= xpToNext(c.level)) {
    c.xp -= xpToNext(c.level);
    c.level += 1;
    c.pendingStatPoints += STAT_POINTS_PER_LEVEL;
    levelsGained += 1;
  }
  return { gained, levelsGained };
}

function rollDrop() {
  const { luk } = totalStats();
  const dropRate = Math.min(MAX_DROP_RATE, BASE_DROP_RATE + luk * LUK_DROP_BONUS);
  if (Math.random() >= dropRate) return null;
  const uniqueRate = Math.min(MAX_UNIQUE_RATE, BASE_UNIQUE_RATE + luk * LUK_UNIQUE_BONUS);
  const isUnique = Math.random() < uniqueRate;
  const slot = SLOTS[Math.floor(Math.random() * SLOTS.length)];
  return { slot, isUnique };
}

// ── Gemini API ───────────────────────────────────────

async function callGemini(systemPrompt, userText, jsonMode = false) {
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { maxOutputTokens: 400 },
  };
  if (jsonMode) body.generationConfig.responseMimeType = 'application/json';

  const res = await fetch(GEMINI_URL, {
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

  const baseXp = XP_BY_DIFFICULTY[q.difficulty] || 0;
  const { gained, levelsGained } = gainXp(baseXp);
  saveState();
  renderAll();
  showToast(`퀘스트 완수 — XP +${gained}`);

  // 드롭 굴림
  const drop = rollDrop();
  if (drop) {
    try {
      const item = await generateEquipment(drop.slot, drop.isUnique, q.fantasy);
      state.character.inventory.unshift(item);
      saveState();
      renderAll();
      showToast(`${drop.isUnique ? '✨ 유니크 ' : ''}장비 획득 — ${item.name}`);
    } catch (e) {
      showToast('보물 생성 실패: ' + e.message);
    }
  }

  if (levelsGained > 0) {
    showToast(`🎉 레벨 ${state.character.level} 달성! 분배 가능 +${STAT_POINTS_PER_LEVEL * levelsGained}`);
    openStatModal();
  }
}

function uncompleteQuest(id) {
  // XP/드롭은 회수하지 않음 — 단순 표시 토글
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

// ── Stat Distribution ────────────────────────────────

function openStatModal() {
  if (state.character.pendingStatPoints <= 0) return;
  document.getElementById('statModal').classList.remove('hidden');
  renderStatModal();
}

function closeStatModal() {
  document.getElementById('statModal').classList.add('hidden');
}

function allocateStat(key) {
  if (state.character.pendingStatPoints <= 0) return;
  state.character.stats[key] += 1;
  state.character.pendingStatPoints -= 1;
  saveState();
  renderStatModal();
  renderCharacterPanel();
  if (state.character.pendingStatPoints === 0) {
    setTimeout(closeStatModal, 400);
  }
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
  if (c.pendingStatPoints > 0) {
    pending.classList.remove('hidden');
    pending.textContent = `분배 가능 +${c.pendingStatPoints}`;
  } else {
    pending.classList.add('hidden');
  }

  // 퀘스트 슬롯
  document.getElementById('slotCount').textContent = `${c.questSlots.available} / ${MAX_QUEST_SLOTS}`;
  const next = document.getElementById('slotNext');
  if (c.questSlots.available >= MAX_QUEST_SLOTS) {
    next.textContent = '가득 참';
  } else {
    const remain = c.questSlots.lastRecoveredAt + slotCooldownMs() - Date.now();
    next.textContent = `다음 회복: ${formatDuration(Math.max(0, remain))}`;
  }
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

function renderStatModal() {
  document.getElementById('statModalRemaining').textContent = state.character.pendingStatPoints;
  document.getElementById('statModalStr').textContent = state.character.stats.str;
  document.getElementById('statModalLuk').textContent = state.character.stats.luk;
  document.getElementById('statModalInt').textContent = state.character.stats.int;
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
  // 온보딩
  document.getElementById('jobSubmitBtn').addEventListener('click', submitOnboarding);
  document.getElementById('jobInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitOnboarding();
  });

  // 퀘스트 등록
  document.getElementById('addBtn').addEventListener('click', addQuest);
  document.getElementById('todoInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') addQuest();
  });

  // 퀘스트 목록 이벤트 위임
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

  // 인벤토리 / 장비
  document.getElementById('inventoryList').addEventListener('click', e => {
    const id = Number(e.target.dataset.id);
    if (e.target.classList.contains('inv-equip')) equipItem(id);
    else if (e.target.classList.contains('inv-discard')) discardItem(id);
  });
  document.getElementById('equipmentSlots').addEventListener('click', e => {
    if (e.target.classList.contains('equip-unequip')) unequipSlot(e.target.dataset.slot);
  });

  // 스탯 분배
  document.getElementById('pendingPoints').addEventListener('click', openStatModal);
  document.querySelectorAll('[data-alloc]').forEach(b => {
    b.addEventListener('click', () => allocateStat(b.dataset.alloc));
  });
  document.getElementById('statModalClose').addEventListener('click', closeStatModal);

  // 슬롯 회복 카운트다운: 매초 표시 갱신
  setInterval(() => {
    if (!state.character.jobFantasy) return;
    recoverQuestSlots();
    renderCharacterPanel();
  }, 1000);

  renderAll();
})();
