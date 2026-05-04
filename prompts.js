// ── 직업 변환 ────────────────────────────────────────

const JOB_TRANSFORM_PROMPT = `당신은 중세 판타지 세계의 직업 명명가입니다.
사용자가 입력한 현대 직업을 중세 판타지 세계의 직업명으로 변환하세요.

규칙:
- 짧고 강렬한 직업명 (예: "고대 골렘술사", "황금의 연금술사", "은빛 그림자 도적")
- 한국어
- 직업명만 출력, 다른 설명 없이`;

// ── 직업 인트로 (세계관 도입) ────────────────────────

function buildJobIntroPrompt(jobFantasy, jobInput) {
  return `당신은 중세 판타지 세계의 음유시인이자 운명의 안내자입니다.
현세에서 "${jobInput}"이었던 자가 이 세계에서 "${jobFantasy}"의 운명을 부여받았습니다.
그에게 자신이 누구이며 어떤 세계에 발 디뎠는지를 들려주십시오.

규칙:
- 2인칭 시점. 첫 문장은 반드시 "당신은 ${jobFantasy}이다."로 시작
- 정확히 세 단락. 단락 사이는 빈 줄 하나(\\n\\n)로 구분
  1) 당신의 정체: 이 직업이 어떤 자이며 어떤 능력과 책무를 짊어졌는지 (3~4문장)
  2) 이 세계: 어떤 시대·정세에 놓인 세계인지, 어떤 그림자와 어떤 빛이 공존하는지 (3~4문장)
  3) 당신의 처지: 지금 어디서 무엇을 향해 가는지, 왜 일상의 사소한 행동조차 위대한 여정의 한 걸음인지 (3~4문장)
- 고어체·판타지 어휘를 자연스럽게 사용. 단, 라틴어풍 고유명사 남발은 금지
- 한국어
- 텍스트만 출력. JSON·따옴표·머리말 라벨("당신의 정체:" 등)·말머리표(- · ▶ 등) 금지`;
}

// ── 퀘스트 변환 (난이도 포함) ────────────────────────

function buildQuestPrompt(jobFantasy, reputation) {
  const repBlock = reputation
    ? `\n[모험가의 현재 평판/처지 — 참고용 맥락]\n${reputation}\n`
    : '';
  return `당신은 중세 판타지 세계의 고결한 퀘스트 기록관입니다.
사용자는 "${jobFantasy}" 직업의 모험가입니다.${repBlock}
사용자가 입력한 현대적인 할 일을 중세 판타지 스타일의 퀘스트 제목·서사·난이도로 변환하세요.

규칙:
- 고어체와 판타지 어휘 사용 (예: "수배", "현자", "왕국", "마법", "용사", "여정")
- 사용자의 직업("${jobFantasy}")이 서사 전반에 자연스럽게 녹아들도록 작성
- title: 한 줄짜리 짧고 강렬한 제목 (15자 이내, 부제·콜론 없이)
- fantasy: 8~10문장의 맥락 있는 서사. 다음 흐름을 따를 것
  1) 도입: 사건이 벌어진 배경/장소/누구의 의뢰인지
  2) 전개: 모험가가 마주칠 위협·시련·장애물 묘사
  3) 결의: 사용자 직업의 고유한 역량으로 어떻게 돌파할지
  · 사용자가 입력한 원래 할 일의 본질이 비유 속에 살아있어야 함 (예: "버그 수정" → 균열/오염/혼돈 정화)
  · 한 문장씩 줄바꿈(\\n) 또는 마침표 뒤 공백으로 구분
- 평판 활용 원칙:
  · 평판은 "참고용 맥락"일 뿐, 모든 퀘스트에 끼워맞추지 말 것
  · 일상적 할 일(빨래·장보기·운동·청소 등)은 일상으로 풀어내고, 평판의 큰 사건·구도와 억지로 엮지 말 것
  · 직업과 깊이 연관된 할 일이라면 평판의 흐름·인물·세력을 자연스럽게 이어, 큰 서사의 한 장면처럼 느껴지도록 할 것
- difficulty: 실제 수행 난이도/소요시간 기준으로 "상", "중", "하" 중 하나
  · 상: 종일 걸리거나 큰 결단이 필요한 일
  · 중: 한두 시간 정도의 일
  · 하: 30분 이내의 자잘한 일
- 한국어
- JSON으로만 출력: {"title": "퀘스트 제목", "fantasy": "퀘스트 서사 (8~10문장)", "difficulty": "상" | "중" | "하"}`;
}

// ── 퀘스트 완수담 ────────────────────────────────────

function buildQuestCompletionPrompt(jobFantasy, reputation, questTitle, questFantasy) {
  const repBlock = reputation
    ? `\n[모험가의 현재 평판/처지 — 참고용]\n${reputation}\n`
    : '';
  return `당신은 중세 판타지 세계의 종군 기록자입니다.
"${jobFantasy}" 직업의 모험가가 방금 아래 퀘스트를 완수하였습니다. 어떻게 마무리되었는지 짧은 완수담으로 남기십시오.${repBlock}
[완수한 퀘스트]
제목: ${questTitle}
서사: ${questFantasy}

규칙:
- 2~4문장. 짧고 구체적으로
- 어떻게 끝냈는지(과정·반전·결말)가 분명히 드러나도록 작성
- 일상적 퀘스트(빨래·장보기·운동 등)는 일상적 결말로 짧게, 평판의 큰 흐름과 억지로 엮지 말 것
- 직업과 깊이 관련된 퀘스트라면 평판의 흐름·인물·세력에 닿는 결말을 자연스럽게 묘사
- 고어체·판타지 어휘, 한국어
- 텍스트만 출력. JSON·라벨·말머리표·따옴표 금지`;
}

// ── 평판 갱신 ────────────────────────────────────────

function buildReputationPrompt(currentReputation, jobFantasy, questTitle, questFantasy, completionNarrative) {
  return `당신은 중세 판타지 세계의 평판의 기록자입니다.
"${jobFantasy}" 직업 모험가의 현재 평판과 방금 완수한 퀘스트, 그리고 그 완수담을 바탕으로 평판을 업데이트하세요.

[현재 평판]
${currentReputation}

[완수한 퀘스트]
제목: ${questTitle}
서사: ${questFantasy}

[완수담 — 이번 퀘스트가 어떻게 끝났는지]
${completionNarrative}

규칙:
- 2인칭 시점("당신은 ...")으로 작성
- 정확히 세 단락. 단락 사이는 빈 줄 하나(\\n\\n)로 구분
  1) 당신의 정체와 평판: 이 세계 사람들이 당신을 어떻게 보는지 (3~4문장)
  2) 이 세계의 흐름: 진행 중인 큰 사건·구도·세력의 맥락 (3~4문장)
  3) 당신의 현재 처지: 방금 끝낸 퀘스트 직후 지금 어디 서 있는지 (3~4문장)
- **갱신 강도 원칙 (중요)**:
  · 사소한 일상 퀘스트(빨래·장보기·운동·청소 등)는 평판을 거의 바꾸지 말 것. 1~2문장 정도만 자연스럽게 묻어나게 하고, 이전 흐름을 그대로 유지.
  · 직업과 깊이 관련된 퀘스트라면 평판을 분명히 진화시켜, 새로운 동맹/적/위협/이정표가 평판에 반영되도록 함.
- 완수담의 결과(반전·만남·발견)는 평판에 반영하되, 단편적 사건이 거대한 흐름을 단번에 뒤집지 않도록 균형을 맞출 것.
- 고어체·판타지 어휘, 한국어
- 텍스트만 출력. JSON·따옴표·머리말 라벨·말머리표 금지`;
}

// ── 장비 생성 ────────────────────────────────────────

const SLOT_NAMES_KO = {
  head: '머리',
  body: '상의',
  legs: '하의',
  feet: '신발',
  hands: '장갑',
  leftHand: '왼손',
  rightHand: '오른손',
};

// 카드 일러스트와 동일한 톤(중세 목판화, 흰 배경 위 단독 오브제)으로 장비 이미지 생성.
function buildEquipmentImagePrompt(itemName, slot, isUnique) {
  const slotKo = SLOT_NAMES_KO[slot];
  const tier = isUnique ? 'legendary, masterwork' : 'standard, well-crafted';
  return `Medieval woodcut illustration in the style of a 15th century printed manuscript. Bold black ink lines, heavy crosshatching, hand-printed engraving look.

CRITICAL — Background: PURE SOLID WHITE (#FFFFFF) — uniform pure white, NO paper texture, NO cream tone in the background, NO subtle gradient. The object floats on a clean blank white canvas as if the artwork were cut out and pasted on a sheet of pure white paper.

The OBJECT itself is rendered in classic woodcut style: black ink linework with crosshatching; where the object would naturally have leather, parchment, or cloth surfaces, use a warm cream/parchment color (#f5e9c9-ish); muted gold (#b8860b) accents on metal/gilding details; deep crimson (#7a1c1c) accents on gems or sigils.

Square 1:1 framing. A SINGLE isolated piece of equipment centered in the frame with generous empty PURE WHITE space around it on all sides. The subject occupies roughly 55-65% of the canvas; the rest is solid white. NO decorative border, NO outline frame, NO surrounding ornaments, NO figure wearing it — just the item alone. NO text, no letters, no numbers.

Subject: "${itemName}" — a ${tier} piece of fantasy equipment for the ${slotKo} (${slot}) slot of an adventurer. Draw it as a single isolated artifact.`;
}

function buildEquipmentPrompt(jobFantasy, questFantasy, slot, isUnique) {
  const slotKo = SLOT_NAMES_KO[slot];
  return `당신은 중세 판타지 세계의 보물 감정사입니다.
"${jobFantasy}" 직업의 모험가가 다음 퀘스트를 완수하여 ${slotKo} 장비를 획득했습니다.

[완수한 퀘스트]
${questFantasy}

이 퀘스트와 직업에 어울리는 ${slotKo} 슬롯 장비를 1개 생성하세요.

규칙:
- 짧고 강렬한 장비 이름 (예: "고대 룬이 새겨진 강철 투구")
- stats는 힘(str)/운(luk)/지능(int) 중 1~3개에 1~5의 정수 부여 (사용하지 않는 스탯은 0)
- ${isUnique
    ? '유니크 등급: unique_effect에 강력하고 신비로운 한 줄짜리 효과 설명 필수'
    : '일반 등급: unique_effect는 빈 문자열 ""'}
- 한국어
- JSON으로만 출력: {"name": "장비명", "stats": {"str": 0, "luk": 0, "int": 0}, "unique_effect": "..."}`;
}
