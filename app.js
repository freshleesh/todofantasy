const STORAGE_KEY = 'todofantassy_quests';
const API_KEY_KEY = 'todofantassy_api_key';

let quests = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');

// ── API Key ──────────────────────────────────────────

function saveApiKey() {
  const key = document.getElementById('apiKeyInput').value.trim();
  if (!key) {
    showToast('API Key를 입력하십시오.');
    return;
  }
  localStorage.setItem(API_KEY_KEY, key);
  document.getElementById('apiKeyInput').value = '';
  showApiStatus('✅ API Key가 봉인되었습니다. (브라우저 로컬 저장소)');
  showToast('API Key 봉인 완료!');
}

function getApiKey() {
  return localStorage.getItem(API_KEY_KEY) || '';
}

function showApiStatus(msg) {
  document.getElementById('apiStatus').textContent = msg;
}

// ── Gemini API ───────────────────────────────────────

const SYSTEM_PROMPT = `당신은 중세 판타지 세계의 고결한 퀘스트 기록관입니다.
사용자가 입력한 현대적인 할 일을 중세 판타지 스타일의 퀘스트 설명으로 변환하세요.
규칙:
- 1~2문장으로 간결하게
- 고어체와 판타지 어휘 사용 (예: "수배", "현자", "왕국", "마법", "용사", "여정")
- 과장되게 웅장하게 표현
- 한국어로 답변
- 퀘스트 설명만 출력하고 다른 설명 없이`;

async function transformToFantasy(task) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('API Key가 없습니다. 먼저 Key를 봉인하십시오.');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: task }] }],
      generationConfig: { maxOutputTokens: 200 },
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API 오류 (${response.status})`);
  }

  const data = await response.json();
  return data.candidates[0].content.parts[0].text.trim();
}

// ── Quest Management ─────────────────────────────────

async function addQuest() {
  const input = document.getElementById('todoInput');
  const task = input.value.trim();
  if (!task) return;

  const btn = document.getElementById('addBtn');
  const btnText = document.getElementById('addBtnText');
  const spinner = document.getElementById('addBtnSpinner');

  btn.disabled = true;
  btnText.textContent = '변환 중...';
  spinner.classList.remove('hidden');

  try {
    const fantasy = await transformToFantasy(task);
    const quest = { id: Date.now(), original: task, fantasy, done: false };
    quests.unshift(quest);
    saveQuests();
    renderQuests();
    input.value = '';
    showToast('새 퀘스트가 기록되었습니다!');
  } catch (e) {
    showToast('오류: ' + e.message);
  } finally {
    btn.disabled = false;
    btnText.textContent = '퀘스트 등록';
    spinner.classList.add('hidden');
  }
}

function toggleDone(id) {
  const q = quests.find(q => q.id === id);
  if (q) { q.done = !q.done; saveQuests(); renderQuests(); }
}

function deleteQuest(id) {
  quests = quests.filter(q => q.id !== id);
  saveQuests();
  renderQuests();
}

function saveQuests() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(quests));
}

// ── Rendering ────────────────────────────────────────

function renderQuests() {
  const list = document.getElementById('questList');
  const empty = document.getElementById('emptyState');

  if (quests.length === 0) {
    list.innerHTML = '';
    list.appendChild(empty);
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  list.innerHTML = quests.map(q => `
    <div class="quest-item ${q.done ? 'done' : ''}" id="quest-${q.id}">
      <input class="quest-checkbox" type="checkbox" ${q.done ? 'checked' : ''}
             onchange="toggleDone(${q.id})" title="완료 처리" />
      <div class="quest-content">
        <div class="quest-fantasy">${escapeHtml(q.fantasy)}</div>
        <div class="quest-original">원문: ${escapeHtml(q.original)}</div>
      </div>
      <button class="quest-delete" onclick="deleteQuest(${q.id})" title="삭제">✕</button>
    </div>
  `).join('');
}

// ── Toast ─────────────────────────────────────────────

let toastTimer;
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3000);
}

// ── Utils ─────────────────────────────────────────────

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Init ──────────────────────────────────────────────

(function init() {
  if (getApiKey()) showApiStatus('✅ API Key가 봉인되어 있습니다.');
  renderQuests();
})();
