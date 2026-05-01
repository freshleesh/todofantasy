const STORAGE_KEY = 'todofantassy_quests';
const API_KEY = 'AIzaSyCKFZjrX0FlK3WG_KTDFybX8evKj5U45Dw';

let quests = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');

// ── API Key ──────────────────────────────────────────

function getApiKey() {
  return API_KEY;
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
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
  list.innerHTML = '';

  quests.forEach(q => {
    const item = document.createElement('div');
    item.className = `quest-item${q.done ? ' done' : ''}`;
    item.dataset.id = q.id;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'quest-checkbox';
    checkbox.checked = q.done;
    checkbox.title = '완료 처리';

    const content = document.createElement('div');
    content.className = 'quest-content';
    content.innerHTML = `
      <div class="quest-fantasy">${escapeHtml(q.fantasy)}</div>
      <div class="quest-original">원문: ${escapeHtml(q.original)}</div>
    `;

    const delBtn = document.createElement('button');
    delBtn.className = 'quest-delete';
    delBtn.title = '삭제';
    delBtn.textContent = '✕';

    item.append(checkbox, content, delBtn);
    list.appendChild(item);
  });
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
  document.getElementById('addBtn').addEventListener('click', addQuest);
  document.getElementById('todoInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') addQuest();
  });

  // 이벤트 위임: 퀘스트 목록의 체크박스·삭제 버튼
  document.getElementById('questList').addEventListener('change', e => {
    const item = e.target.closest('.quest-item');
    if (item && e.target.classList.contains('quest-checkbox')) {
      toggleDone(Number(item.dataset.id));
    }
  });
  document.getElementById('questList').addEventListener('click', e => {
    const item = e.target.closest('.quest-item');
    if (item && e.target.classList.contains('quest-delete')) {
      deleteQuest(Number(item.dataset.id));
    }
  });

  renderQuests();
})();
