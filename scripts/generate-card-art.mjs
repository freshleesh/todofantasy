// 일회용 카드 일러스트 생성 스크립트.
// 사용:  node scripts/generate-card-art.mjs                 # 전체 생성
//       node scripts/generate-card-art.mjs item_unique curse  # 일부만
//
// GEMINI_API_KEY 환경변수 또는 local-config.js의 window.GEMINI_KEY를 사용.
// 결과물은 asset/cards/<cardId>.png 로 떨어짐.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'asset', 'cards');

const MODEL = 'gemini-2.5-flash-image';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const STYLE_PREFIX = `Medieval woodcut illustration in the style of a 15th century printed manuscript. \
Bold black ink lines, heavy crosshatching, hand-printed engraving look. \
\
CRITICAL — Background: PURE SOLID WHITE (#FFFFFF) — uniform pure white, \
NO paper texture, NO cream tone in the background, NO subtle gradient, \
NO parchment or aged effect outside the object itself. \
The object floats on a clean blank white canvas as if the artwork were \
cut out and pasted on a sheet of pure white paper. \
\
The OBJECT itself is rendered in classic woodcut style: \
black ink linework with crosshatching; where the object would naturally have \
paper or parchment surface (book pages, scrolls, etc.), use a warm cream/parchment \
color (#f5e9c9-ish); muted gold (#b8860b) accents on metal/gilding details; \
deep crimson (#7a1c1c) accents on gems, seals, or symbolic elements. \
\
Square 1:1 framing. A SINGLE isolated subject centered in the frame with \
generous empty PURE WHITE space around it on all sides. \
The subject occupies roughly 55-65% of the canvas; the rest is solid white. \
NO decorative border, NO outline frame, NO rectangular boundary, \
NO surrounding vines, leaves, stars, sun-rays, or ornaments — just the icon alone. \
NO text, no letters, no numbers. Subject:`;

const PROMPTS = {
  item_unique:
    `${STYLE_PREFIX} a single grand legendary longsword standing vertically, blade pointing up. \
The hilt is supremely ornate: multiple crimson gems set into the cross-guard, \
intricate gold filigree curling around the grip, and a crown-shaped pommel topped with a small star. \
The blade is engraved with mythic runes running its full length, from base to tip, in gold ink. \
Decorative spirals and acanthus curls integrated into both ends of the cross-guard. \
The most masterwork weapon imaginable — a king's heirloom. \
Just the sword alone on parchment, no surrounding rays, no halo, no background ornaments. \
All ornament is on the sword itself, densely worked.`,

  item_normal:
    `${STYLE_PREFIX} a plain crossed sword and round shield, \
honest soldier's gear. Modest and sturdy, no glow, no jewels. \
Simple woodcut iconography of common adventuring equipment.`,

  curse:
    `${STYLE_PREFIX} a grinning human skull facing forward with a single raven perched atop its crown. \
Dripping ink shadows beneath. Ominous, gothic, memento mori. \
Dark and heavy crosshatching. No crimson — only black ink on parchment.`,

  xp1:
    `${STYLE_PREFIX} a small humble leather-bound book lying CLOSED at the center. \
The book itself has a plain unadorned cover — NO runes carved on the cover. \
Floating in the air ABOVE the closed book is ONE single small angular rune symbol, \
clearly suspended and glowing, surrounded by a visible soft halo of light \
with short radiating light-rays (like the glowing tome but with just one tiny rune). \
The book is closed and quiet, but a single magical rune hovers above it shining. \
Beginner's reward of knowledge — minimal but the glow effect must be clearly visible.`,

  xp2:
    `${STYLE_PREFIX} a leather-bound book partly open at the center, \
with TWO OR THREE small runes floating in an arc above the open pages. \
A moderate gentle glow rises from the pages, not too bright. \
Modest magical reward — clearly more than the closed book, clearly less than the grand tome.`,

  xp3:
    `${STYLE_PREFIX} an open thick leather-bound tome at the center, \
golden light radiating from its pages in many beams, \
several runes floating above it in an arc. \
A grand glowing reward of arcane knowledge.`,

  draw_extra:
    `${STYLE_PREFIX} a fan of three blank tarot-style cards spreading from a single point, \
held as if by an invisible hand. \
Subtle gold sparkles around the fan. Symbol of drawing more.`,

  xp_bonus:
    `${STYLE_PREFIX} a single lightning bolt striking through a five-pointed star at the center, \
muted gold accents on the star, radiating energy lines. \
Symbol of an instant burst of power.`,
};

async function loadApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const cfg = await fs.readFile(path.join(ROOT, 'local-config.js'), 'utf-8');
  const m = cfg.match(/GEMINI_KEY\s*=\s*['"]([^'"]+)['"]/);
  if (!m) throw new Error('API 키를 찾을 수 없음 (GEMINI_API_KEY 또는 local-config.js)');
  return m[1];
}

async function generateOne(cardId, prompt, apiKey) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'] },
  };

  const res = await fetch(`${ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API 오류 (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find(p => p.inlineData || p.inline_data);
  if (!imgPart) {
    throw new Error(`이미지 데이터 없음: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const inline = imgPart.inlineData || imgPart.inline_data;
  const buf = Buffer.from(inline.data, 'base64');

  const outPath = path.join(OUT_DIR, `${cardId}.png`);
  await fs.writeFile(outPath, buf);
  return outPath;
}

async function main() {
  const argv = process.argv.slice(2);
  const targets = argv.length > 0 ? argv : Object.keys(PROMPTS);

  for (const t of targets) {
    if (!PROMPTS[t]) {
      console.error(`알 수 없는 카드 ID: ${t}`);
      process.exit(1);
    }
  }

  const apiKey = await loadApiKey();
  await fs.mkdir(OUT_DIR, { recursive: true });

  const succeeded = [];
  for (const cardId of targets) {
    process.stdout.write(`[${cardId}] 생성 중... `);
    const t0 = Date.now();
    try {
      const out = await generateOne(cardId, PROMPTS[cardId], apiKey);
      console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s → ${path.relative(ROOT, out)}`);
      succeeded.push(out);
    } catch (e) {
      console.log(`실패: ${e.message}`);
    }
  }

  if (succeeded.length === 0) return;

  // 누끼 + 리사이즈 + WebP + 원본 PNG 삭제 (process-card-art.py가 처리)
  console.log('\n[process] 누끼 + WebP 변환 + 원본 삭제...');
  const r = spawnSync('python3', [path.join(ROOT, 'scripts', 'process-card-art.py'),
                                  ...succeeded.map(p => path.basename(p))],
    { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('process-card-art.py 실패');
    process.exit(r.status || 1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
