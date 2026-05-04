"""디자인 디버그용 카드 뷰어.

실제 앱과 동일하게 index.html → style.css → app.js를 로드한 다음,
app.js에 정의된 buildCardEl()을 그대로 호출해서 모든 카드 종류를
한 화면에 조립해 보여준다. 카드/프레임/CSS 무엇을 바꾸든
이 스크립트 한 번 돌리면 즉시 시각 확인 가능.

사용:  .venv/bin/python test_card.py
출력:  test_screenshots/card_debug.png
"""
import asyncio
import subprocess
import time
from pathlib import Path
from playwright.async_api import async_playwright

PORT = 8767
ROOT = Path(__file__).parent
OUT = ROOT / "test_screenshots" / "card_debug.png"


BUILD_SCRIPT = """() => {
    // 게임 UI 모두 제거 — buildCardEl이 만든 카드만 보이도록
    document.querySelector('.parchment-wrapper')?.remove();
    document.querySelectorAll('.modal, .toast').forEach(el => el.remove());
    document.body.style.cssText = `
        margin: 0;
        padding: 24px;
        background: rgba(26, 15, 6, 0.95);
        font-family: 'IM Fell English', Georgia, serif;
        color: #f5e9c9;
        min-height: 100vh;
    `;

    const wrap = document.createElement('div');
    wrap.style.cssText = 'max-width: 820px; margin: 0 auto;';

    const heading = (text) => {
        const h = document.createElement('div');
        h.textContent = text;
        h.style.cssText = `
            font-family: 'Cinzel', serif;
            color: #b8860b;
            text-align: center;
            font-size: 0.95rem;
            letter-spacing: 0.06em;
            margin: 18px 0 10px;
            border-bottom: 1px solid #8b6914;
            padding-bottom: 6px;
        `;
        return h;
    };

    const makeGrid = () => {
        const g = document.createElement('div');
        g.style.cssText = `
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 14px;
        `;
        return g;
    };

    const cell = (cardId, card) => {
        const c = document.createElement('div');
        const tag = document.createElement('div');
        tag.textContent = cardId;
        tag.style.cssText = `
            font-family: monospace;
            font-size: 0.7rem;
            color: #b8860b;
            text-align: center;
            margin-bottom: 4px;
        `;
        c.appendChild(tag);
        c.appendChild(card);
        return c;
    };

    wrap.appendChild(heading('🎴 candidate (revealed) — 보상 카드 픽 모달의 후보 상태'));
    const candGrid = makeGrid();
    let i = 0;
    for (const cardId of Object.keys(CARD_DEFS)) {
        const card = buildCardEl(cardId, true, i++);
        card.classList.remove('dealing');     // deal 등장 애니메이션 스킵
        card.classList.add('revealed');       // 뒷면 flip 완료 상태
        candGrid.appendChild(cell(cardId, card));
    }
    wrap.appendChild(candGrid);

    wrap.appendChild(heading('⚡ cast — 즉시 시전 카드 (draw_extra · xp_bonus)'));
    const castGrid = makeGrid();
    castGrid.style.gridTemplateColumns = 'repeat(4, 1fr)';
    for (const cardId of Object.keys(CARD_DEFS)) {
        if (!CARD_DEFS[cardId].cast) continue;
        const card = buildCardEl(cardId, false, 0);
        card.classList.remove('dealing');
        card.classList.add('revealed');
        castGrid.appendChild(cell(cardId, card));
    }
    wrap.appendChild(castGrid);

    wrap.appendChild(heading('🂠 back — 뽑기 직전 뒷면 상태 (revealed 클래스 없음)'));
    const backGrid = makeGrid();
    for (const cardId of ['curse', 'item_unique', 'xp1', 'draw_extra']) {
        const card = buildCardEl(cardId, true, 0);
        card.classList.remove('dealing');     // 단, revealed는 추가하지 않음
        backGrid.appendChild(cell(cardId, card));
    }
    wrap.appendChild(backGrid);

    document.body.appendChild(wrap);
}"""


async def run():
    OUT.parent.mkdir(exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(
            viewport={"width": 900, "height": 1100},
            device_scale_factor=2,
        )
        page = await ctx.new_page()
        page.on("pageerror", lambda e: print(f"  pageerror: {e}"))

        await page.goto(f"http://localhost:{PORT}/")
        await page.wait_for_load_state("networkidle")

        await page.evaluate(BUILD_SCRIPT)

        # 이미지/폰트 안정화 대기
        await page.wait_for_load_state("networkidle")
        await page.wait_for_timeout(400)

        await page.screenshot(path=str(OUT), full_page=True)
        await browser.close()

    print(f"saved → {OUT.relative_to(ROOT)}")


def main():
    server = subprocess.Popen(
        ["python3", "-m", "http.server", str(PORT)],
        cwd=str(ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(1)
    try:
        asyncio.run(run())
    finally:
        server.terminate()


if __name__ == "__main__":
    main()
