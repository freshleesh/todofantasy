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
  xp1:         { name: '경험치 +100',      label: 'XP +100',   effect: { xp: 100 } },
  xp2:         { name: '경험치 +200',      label: 'XP +200',   effect: { xp: 200 } },
  xp3:         { name: '경험치 +300',      label: 'XP +300',   effect: { xp: 300 } },
  item_normal: { name: '일반 아이템 획득', label: '⚔ 일반',   effect: { drop: 'normal' } },
  item_unique: { name: '유니크 아이템 획득', label: '✨ 유니크', effect: { drop: 'unique' } },
  curse:       { name: '저주 (꽝)',        label: '💀 저주',   effect: {} },
  draw_extra:  { name: '카드 +2 드로우',   label: '🎴 +2 드로우', cast: 'draw2', desc: '뽑을 시 시전' },
  xp_bonus:    { name: '즉시 +100 XP',     label: '⚡ XP+100 즉시', cast: 'xp1', desc: '뽑을 시 시전' },
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
      jobIntro: '',
      reputation: '',
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
let introVisible = false;
let reputationChain = Promise.resolve();
let reputationUpdating = false;

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
    if (!parsed.character.reputation && parsed.character.jobIntro) {
      parsed.character.reputation = parsed.character.jobIntro;
    }
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

function geminiUrl(model) {
  if (window.GEMINI_KEY) {
    return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${window.GEMINI_KEY}`;
  }
  return PROXY_URL;
}

async function callGemini(systemPrompt, userText, jsonMode = false) {
  const TEXT_MODEL = 'gemini-2.5-flash';
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      maxOutputTokens: 1500,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  if (jsonMode) body.generationConfig.responseMimeType = 'application/json';
  if (!window.GEMINI_KEY) body.model = TEXT_MODEL; // 프록시 라우팅용

  const res = await fetch(geminiUrl(TEXT_MODEL), {
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

// 이미지 생성 — base64 PNG 반환
async function callGeminiImage(prompt) {
  const IMAGE_MODEL = 'gemini-2.5-flash-image';
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'] },
  };
  if (!window.GEMINI_KEY) body.model = IMAGE_MODEL;

  const res = await fetch(geminiUrl(IMAGE_MODEL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `이미지 API 오류 (${res.status})`);
  }
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find(p => p.inlineData || p.inline_data);
  if (!imgPart) throw new Error('이미지 데이터 없음');
  return (imgPart.inlineData || imgPart.inline_data).data;
}

// 누끼 + 256x256 리사이즈 + WebP — 카드 처리 파이프라인의 브라우저 버전
async function processItemImage(base64Png) {
  const TARGET = 256;
  const TOL_LOW = 10;
  const TOL_HIGH = 35;

  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('이미지 로드 실패'));
    i.src = `data:image/png;base64,${base64Png}`;
  });

  const canvas = document.createElement('canvas');
  canvas.width = TARGET;
  canvas.height = TARGET;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, TARGET, TARGET);

  const data = ctx.getImageData(0, 0, TARGET, TARGET);
  const px = data.data;

  // 4 모서리 16x16 패치로 배경색 추정
  const S = 16;
  let r = 0, g = 0, b = 0, n = 0;
  const sample = (x0, y0) => {
    for (let y = y0; y < y0 + S; y++) {
      for (let x = x0; x < x0 + S; x++) {
        const i = (y * TARGET + x) * 4;
        r += px[i]; g += px[i + 1]; b += px[i + 2];
        n++;
      }
    }
  };
  sample(0, 0); sample(TARGET - S, 0); sample(0, TARGET - S); sample(TARGET - S, TARGET - S);
  const bgR = r / n, bgG = g / n, bgB = b / n;

  // 배경과의 거리 → alpha
  for (let i = 0; i < px.length; i += 4) {
    const dr = px[i] - bgR, dg = px[i + 1] - bgG, db = px[i + 2] - bgB;
    const d = Math.sqrt(dr * dr + dg * dg + db * db);
    let a = (d - TOL_LOW) / (TOL_HIGH - TOL_LOW);
    a = Math.max(0, Math.min(1, a)) * 255;
    px[i + 3] = a;
  }
  ctx.putImageData(data, 0, 0);

  // WebP data URL
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) return reject(new Error('toBlob 실패'));
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('encode 실패'));
      reader.readAsDataURL(blob);
    }, 'image/webp', 0.85);
  });
}

async function generateJob(input) {
  const text = await callGemini(JOB_TRANSFORM_PROMPT, input, false);
  return text.replace(/^["']|["']$/g, '');
}

async function transformQuest(task) {
  const text = await callGemini(
    buildQuestPrompt(state.character.jobFantasy, state.character.reputation),
    task,
    true,
  );
  const parsed = JSON.parse(text);
  if (!parsed.title || !parsed.fantasy || !['상', '중', '하'].includes(parsed.difficulty)) {
    throw new Error('변환 결과 형식 오류');
  }
  return parsed;
}

async function generateQuestCompletion(jobFantasy, reputation, questTitle, questFantasy) {
  return await callGemini(
    buildQuestCompletionPrompt(jobFantasy, reputation, questTitle, questFantasy),
    '완수담을 들려주십시오.',
    false,
  );
}

async function generateReputation(currentRep, jobFantasy, questTitle, questFantasy, completionNarrative) {
  return await callGemini(
    buildReputationPrompt(currentRep, jobFantasy, questTitle, questFantasy, completionNarrative),
    '평판을 갱신해주십시오.',
    false,
  );
}

async function generateJobIntro(jobFantasy, jobInput) {
  return await callGemini(buildJobIntroPrompt(jobFantasy, jobInput), '소개를 들려주십시오.', false);
}

async function generateEquipment(slot, isUnique, questFantasy) {
  const text = await callGemini(
    buildEquipmentPrompt(state.character.jobFantasy, questFantasy, slot, isUnique),
    '장비를 생성해주세요.',
    true,
  );
  const parsed = JSON.parse(text);
  const name = parsed.name || '이름 없는 보물';

  // 이미지 생성은 실패해도 장비 자체는 살림 (image: null)
  let image = null;
  try {
    const b64 = await callGeminiImage(buildEquipmentImagePrompt(name, slot, isUnique));
    image = await processItemImage(b64);
  } catch (e) {
    console.warn('장비 이미지 생성 실패:', e.message);
  }

  return {
    id: Date.now() + Math.random(),
    name,
    slot,
    stats: {
      str: parsed.stats?.str || 0,
      luk: parsed.stats?.luk || 0,
      int: parsed.stats?.int || 0,
    },
    uniqueEffect: parsed.unique_effect || '',
    rarity: isUnique ? 'unique' : 'normal',
    image,
  };
}

// ── Reputation ───────────────────────────────────────

const pendingCompletionIds = new Set();
const pendingCompletionModals = [];

function isAnyRewardModalOpen() {
  return ['cardPickModal', 'levelupModal', 'deckSelectModal']
    .some(id => !document.getElementById(id).classList.contains('hidden'));
}

function tryShowCompletionModal() {
  if (pendingCompletionModals.length === 0) return;
  if (isAnyRewardModalOpen()) return;
  const modal = document.getElementById('completionModal');
  if (!modal.classList.contains('hidden')) return;
  const { title, text } = pendingCompletionModals.shift();
  document.getElementById('completionQuestTitle').textContent = title;
  document.getElementById('completionText').textContent = text;
  modal.classList.remove('hidden');
}

function closeCompletionModal() {
  document.getElementById('completionModal').classList.add('hidden');
  setTimeout(tryShowCompletionModal, 50);
}

function scheduleReputationUpdate(quest) {
  const c = state.character;
  const baseRep = c.reputation || c.jobIntro;
  if (!baseRep) return;
  const jobFantasy = c.jobFantasy;
  const questId = quest.id;
  const title = quest.title || quest.fantasy.split(/[.\n]/)[0];
  const fantasy = quest.fantasy;

  pendingCompletionIds.add(questId);
  renderQuests();

  reputationChain = reputationChain.then(async () => {
    reputationUpdating = true;
    renderReputation();
    let completion = null;
    try {
      // Step 1: 이 퀘스트가 어떻게 완료됐는지 완수담 생성
      completion = await generateQuestCompletion(jobFantasy, state.character.reputation || baseRep, title, fantasy);
      if (completion && completion.length > 5) {
        const q = state.quests.find(q2 => q2.id === questId);
        if (q) {
          q.completion = completion;
          saveState();
          renderQuests();
          pendingCompletionModals.push({ title: q.title || '퀘스트 완수', text: completion });
          tryShowCompletionModal();
        }
      }
    } catch (e) {
      // 완수담 실패 — 평판 갱신은 계속 시도하되 완수담 없이
    } finally {
      pendingCompletionIds.delete(questId);
      renderQuests();
    }

    try {
      // Step 2: 기존 평판 + 완수담을 융합해 평판 갱신
      const newRep = await generateReputation(
        state.character.reputation || baseRep,
        jobFantasy,
        title,
        fantasy,
        completion || '(완수담 없음)',
      );
      if (newRep && newRep.length > 20) {
        state.character.reputation = newRep;
        saveState();
      }
    } catch (e) {
      // 평판 갱신 실패는 조용히 — 이전 평판 유지
    } finally {
      reputationUpdating = false;
      renderReputation();
    }
  });
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

  scheduleReputationUpdate(q);

  const crit = rollCrit();
  if (crit) showToast('🎯 치명타! 이번 보상 ×2');

  const drawn = drawReward(q.difficulty);
  const { cast, candidates } = partitionDrawn(drawn);

  // 즉시 시전 효과 적용 (크리 시 ×2)
  let castXp = 0;
  for (const c of cast) {
    if (CARD_DEFS[c].cast === 'xp1') castXp += CARD_DEFS.xp1.effect.xp;
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
    else tryShowCompletionModal();
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

const DEAL_DURATION_MS = 450;
const FLIP_STAGGER_MS = 220;

function renderCardPickModal() {
  if (!currentRewardCtx) return;
  const { candidates, cast, crit } = currentRewardCtx;
  const hintEl = document.getElementById('cardPickHint');
  const critPrefix = crit ? '🎯 <b>치명타!</b> 이번 보상 ×2 — ' : '';
  hintEl.innerHTML = critPrefix + '카드를 뽑는 중...';
  const list = document.getElementById('cardPickList');
  list.innerHTML = '';

  const dealt = [];
  let i = 0;

  if (cast.length > 0) {
    const head = document.createElement('div');
    head.className = 'card-section-heading';
    head.textContent = '⚡ 즉시 발동' + (crit ? ' (×2)' : '');
    list.appendChild(head);
    for (const cardId of cast) {
      const el = buildCardEl(cardId, false, i++);
      list.appendChild(el);
      dealt.push(el);
    }
  }

  const head2 = document.createElement('div');
  head2.className = 'card-section-heading';
  head2.textContent = `🎴 한 장 선택 (${candidates.length}장)` + (crit ? ' — ×2 적용' : '');
  list.appendChild(head2);
  for (const cardId of candidates) {
    const el = buildCardEl(cardId, true, i++);
    list.appendChild(el);
    dealt.push(el);
  }

  dealt.forEach((el, idx) => {
    setTimeout(() => el.classList.add('revealed'), DEAL_DURATION_MS + idx * FLIP_STAGGER_MS);
  });
  setTimeout(() => {
    if (!currentRewardCtx) return;
    hintEl.innerHTML = critPrefix + '한 장을 선택하시오';
  }, DEAL_DURATION_MS + dealt.length * FLIP_STAGGER_MS + 60);
}

function buildCardEl(cardId, clickable, dealIndex = 0) {
  const def = CARD_DEFS[cardId];
  const el = document.createElement(clickable ? 'button' : 'div');
  el.className = `card card-${cardId} dealing` + (clickable ? ' candidate' : ' cast');
  el.dataset.id = cardId;
  el.style.setProperty('--deal-i', dealIndex);
  el.innerHTML = `
    <div class="card-back-overlay">⚜</div>
    <div class="card-art">
      <img src="asset/cards/${cardId}.webp" alt="" />
      <img class="card-frame" src="asset/frames/frame-ornate.svg" alt="" />
    </div>
    <div class="card-text">
      <div class="card-label">${escapeHtml(def.label)}</div>
      <div class="card-name">${escapeHtml(def.name)}</div>
      ${def.desc ? `<div class="card-desc">${escapeHtml(def.desc)}</div>` : ''}
    </div>
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
  else tryShowCompletionModal();
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
    showToast('덱에 "즉시 +100 XP" 추가');
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
    tryShowCompletionModal();
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
      <div class="card-art">
        <img src="asset/cards/${cardId}.webp" alt="" />
        <img class="card-frame" src="asset/frames/frame-ornate.svg" alt="" />
      </div>
      <div class="card-text">
        <div class="card-label">${escapeHtml(def.label)}</div>
        <div class="card-name">${escapeHtml(def.name)}</div>
        <div class="card-count">×${counts[cardId]}</div>
      </div>
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
    setBtnBusy(btn, '세계의 서를 펼치는 중...');
    const jobIntro = await generateJobIntro(jobFantasy, jobInput);
    state.character.jobInput = jobInput;
    state.character.jobFantasy = jobFantasy;
    state.character.jobIntro = jobIntro;
    state.character.reputation = jobIntro;
    state.character.questSlots.lastRecoveredAt = Date.now();
    saveState();
    showJobIntro();
  } catch (e) {
    showToast('오류: ' + e.message);
  } finally {
    setBtnBusy(btn, '운명을 받아들이다', false);
  }
}

function showJobIntro() {
  introVisible = true;
  document.getElementById('onboarding').classList.add('hidden');
  document.getElementById('game').classList.add('hidden');
  document.getElementById('jobIntro').classList.remove('hidden');
  document.getElementById('introJobName').textContent = state.character.jobFantasy;
  document.getElementById('introText').textContent = state.character.jobIntro;
}

function startJourney() {
  introVisible = false;
  document.getElementById('jobIntro').classList.add('hidden');
  renderAll();
  showToast(`그대의 여정이 시작되었다 — "${state.character.jobFantasy}"`);
}

// ── Rendering ────────────────────────────────────────

function renderAll() {
  if (introVisible) return;
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
  renderReputation();
}

function renderReputation() {
  const body = document.getElementById('reputationBody');
  const status = document.getElementById('reputationStatus');
  if (!body || !status) return;
  const rep = state.character.reputation;
  body.textContent = rep || '— 아직 평판이 없다 —';
  status.textContent = reputationUpdating ? '갱신 중…' : '';
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
    span.innerHTML = `${label} <b>${total[key]}</b>`
      + (equip > 0 ? ` <em>(${base}+${equip})</em>` : '')
      + `<span class="stat-tooltip">${buildStatTooltip(key, total[key])}</span>`;
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
  const countEl = document.getElementById('deckViewCount');
  if (!countEl) return;
  countEl.textContent = `${state.character.deck.length}장`;
}

const DECK_VIEW_ORDER = ['xp1', 'xp2', 'xp3', 'item_normal', 'item_unique', 'curse', 'draw_extra', 'xp_bonus'];

function openDeckViewModal() {
  document.getElementById('deckViewModal').classList.remove('hidden');
  renderDeckViewModal();
}

function closeDeckViewModal() {
  document.getElementById('deckViewModal').classList.add('hidden');
}

function renderDeckViewModal() {
  const counts = {};
  for (const c of state.character.deck) counts[c] = (counts[c] || 0) + 1;
  document.getElementById('deckViewHint').textContent = `총 ${state.character.deck.length}장`;
  const list = document.getElementById('deckViewList');
  list.innerHTML = '';
  for (const cardId of DECK_VIEW_ORDER) {
    if (!counts[cardId]) continue;
    const def = CARD_DEFS[cardId];
    const el = document.createElement('div');
    el.className = `card card-${cardId}`;
    el.innerHTML = `
      <div class="card-art">
        <img src="asset/cards/${cardId}.webp" alt="" />
        <img class="card-frame" src="asset/frames/frame-ornate.svg" alt="" />
      </div>
      <div class="card-text">
        <div class="card-label">${escapeHtml(def.label)}</div>
        <div class="card-name">${escapeHtml(def.name)}</div>
        <div class="card-count">×${counts[cardId]}</div>
      </div>
    `;
    list.appendChild(el);
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
             ${item.image ? `<img class="equip-slot-image" src="${item.image}" alt="" />` : ''}
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
      ${item.image
        ? `<img class="inv-item-image" src="${item.image}" alt="" />`
        : '<div class="inv-item-image placeholder"></div>'}
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
    const pending = pendingCompletionIds.has(q.id);
    let completionHtml = '';
    if (q.completion) {
      completionHtml = `<div class="quest-completion">📜 ${escapeHtml(q.completion)}</div>`;
    } else if (pending) {
      completionHtml = `<div class="quest-completion pending">📜 완수의 기록을 새기는 중<span class="dots">…</span></div>`;
    }
    item.innerHTML = `
      <input type="checkbox" class="quest-checkbox" ${q.done ? 'checked' : ''} title="완료 처리" />
      <div class="quest-content">
        <div class="quest-title">
          <span class="quest-diff">[${q.difficulty}]</span>
          ${escapeHtml(title)}
        </div>
        ${completionHtml}
        <div class="quest-fantasy">${escapeHtml(q.fantasy)}</div>
        <div class="quest-original">원문: ${escapeHtml(q.original)}</div>
      </div>
      <button class="quest-delete" title="삭제">✕</button>
    `;
    list.appendChild(item);
  }
}

// ── Helpers ──────────────────────────────────────────

function buildStatTooltip(key, val) {
  if (key === 'str') {
    const cooldownMin = Math.max(MIN_SLOT_COOLDOWN_MS, BASE_SLOT_COOLDOWN_MS - val * STR_COOLDOWN_REDUCTION_MS) / 60000;
    return `<b>힘</b> — 퀘스트 슬롯 회복 주기 단축<br>`
         + `포인트당 -5분 (최소 20분)<br>`
         + `현재: 회복 주기 <b>${cooldownMin}분</b>`;
  }
  if (key === 'luk') {
    const critPct = Math.min(LUK_CRIT_MAX, LUK_CRIT_BASE + val * LUK_CRIT_PER) * 100;
    return `<b>운</b> — 치명타 확률 (보상 ×2)<br>`
         + `기본 5% + 포인트당 2% (최대 80%)<br>`
         + `현재: 치명타 <b>${critPct.toFixed(0)}%</b>`;
  }
  if (key === 'int') {
    const bonusPct = Math.round(val * INT_XP_BONUS * 100);
    return `<b>지능</b> — 획득 경험치 보너스<br>`
         + `포인트당 +5%<br>`
         + `현재: XP 보너스 <b>+${bonusPct}%</b>`;
  }
  return '';
}

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
  if (h > 0) return `${h}시간 ${m}분 ${s}초`;
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

  document.getElementById('introStartBtn').addEventListener('click', startJourney);

  document.getElementById('reputationToggle').addEventListener('click', () => {
    document.getElementById('reputationBlock').classList.toggle('collapsed');
  });

  document.getElementById('completionCloseBtn').addEventListener('click', closeCompletionModal);

  document.getElementById('deckViewBtn').addEventListener('click', openDeckViewModal);
  document.getElementById('deckViewCloseBtn').addEventListener('click', closeDeckViewModal);

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
    if (document.querySelector('#cardPickList .card:not(.revealed)')) return;
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
    if (!state.character.jobFantasy || introVisible) return;
    recoverQuestSlots();
    renderCharacterPanel();
  }, 1000);

  renderAll();
})();
