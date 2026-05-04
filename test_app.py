"""
Todo Fantassy 로컬 통합 테스트.
- python3 -m http.server를 백그라운드로 띄우고
- Playwright로 페이지 로드
- Gemini API는 page.route()로 모킹
- 온보딩 → 퀘스트 등록 → 완료 → 드롭 → 장착 → 레벨업 → 스탯 분배 시나리오 검증
- 각 단계 스크린샷을 test_screenshots/에 저장
"""
import asyncio
import json
import subprocess
import time
from pathlib import Path
from playwright.async_api import async_playwright

PORT = 8765
ROOT = Path(__file__).parent
SHOTS = ROOT / "test_screenshots"

# ── Mock 응답 ──────────────────────────────────────────
JOB_FANTASY = "고대 골렘술사"
QUEST_JSON = {
    "fantasy": "마트의 끝없는 미궁에서 일용할 양식을 구하는 위대한 여정에 나서라.",
    "difficulty": "중",
}
EQUIP_JSON = {
    "name": "은빛 룬이 새겨진 강철 투구",
    "stats": {"str": 2, "luk": 1, "int": 0},
    "unique_effect": "",
}


def gemini_envelope(text: str) -> dict:
    return {"candidates": [{"content": {"parts": [{"text": text}]}}]}


async def mock_gemini(route, request):
    body = request.post_data or ""
    if "직업 명명가" in body:
        text = JOB_FANTASY
    elif "퀘스트 기록관" in body:
        text = json.dumps(QUEST_JSON, ensure_ascii=False)
    elif "보물 감정사" in body:
        text = json.dumps(EQUIP_JSON, ensure_ascii=False)
    else:
        text = "?"
    await route.fulfill(
        status=200,
        content_type="application/json",
        body=json.dumps(gemini_envelope(text)),
    )


async def run():
    SHOTS.mkdir(exist_ok=True)
    errors: list[str] = []

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        context = await browser.new_context(viewport={"width": 720, "height": 1100})
        page = await context.new_page()

        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

        def on_console(msg):
            if msg.type == "error":
                errors.append(f"console.error: {msg.text}")

        page.on("console", on_console)
        await page.route("**/api/gemini", mock_gemini)

        # 결정적 random — drop 발생, unique 미발생 (luk 50일 때)
        await page.add_init_script("Math.random = () => 0.6;")

        # 1. 온보딩
        await page.goto(f"http://localhost:{PORT}/")
        # 깨끗한 시작
        await page.evaluate("localStorage.clear(); location.reload();")
        await page.wait_for_selector("#onboarding:not(.hidden)")
        await page.screenshot(path=str(SHOTS / "01_onboarding.png"))

        await page.fill("#jobInput", "로봇공학자")
        await page.click("#jobSubmitBtn")
        await page.wait_for_selector("#game:not(.hidden)")
        job = (await page.text_content("#charJob")).strip()
        assert job == JOB_FANTASY, f"job mismatch: {job!r}"
        await page.screenshot(path=str(SHOTS / "02_post_onboarding.png"))

        # 2. 퀘스트 등록
        # 드롭이 무조건 일어나도록 LUK 미리 셋업
        await page.evaluate("state.character.stats.luk = 50; saveState(); renderAll();")

        await page.fill("#todoInput", "마트에서 장 보기")
        await page.click("#addBtn")
        await page.wait_for_selector(".quest-item")
        fantasy = await page.text_content(".quest-fantasy")
        assert "마트의 끝없는" in fantasy, f"fantasy mismatch: {fantasy!r}"
        slot_count = (await page.text_content("#slotCount")).strip()
        assert slot_count == "2 / 3", f"slot count: {slot_count!r}"
        await page.screenshot(path=str(SHOTS / "03_quest_added.png"))

        # 3. 완료 → XP & 드롭
        await page.click(".quest-checkbox")
        await page.wait_for_selector(".inv-item")
        item_name = await page.text_content(".inv-item-name")
        assert "은빛 룬" in item_name, f"item: {item_name!r}"
        xp_text = await page.text_content("#xpText")
        # 중 = 25 XP, INT 0 → 25
        assert xp_text.strip().startswith("25"), f"xp: {xp_text!r}"
        await page.screenshot(path=str(SHOTS / "04_quest_done_with_drop.png"))

        # 4. 장착
        await page.click(".inv-equip")
        await page.wait_for_selector(".equip-slot.filled")
        equipped = await page.text_content(".equip-slot.filled .equip-slot-name")
        assert "은빛 룬" in equipped, f"equipped: {equipped!r}"
        # 장착 후 STR 0+2=2 (장비 효과)
        str_text = await page.text_content("#stat-str")
        assert "2" in str_text, f"str: {str_text!r}"
        await page.screenshot(path=str(SHOTS / "05_equipped.png"))

        # 5. 레벨업 강제 → 모달 → 스탯 분배
        await page.evaluate("state.character.xp = 99; saveState(); renderAll();")
        await page.fill("#todoInput", "운동하기")
        await page.click("#addBtn")
        # 새 퀘스트가 첫 항목 (unshift)
        await page.locator(".quest-item:not(.done) .quest-checkbox").first.click()
        await page.wait_for_selector("#statModal:not(.hidden)")
        remaining = await page.text_content("#statModalRemaining")
        assert remaining.strip() == "5", f"remaining: {remaining!r}"
        await page.screenshot(path=str(SHOTS / "06_level_up_modal.png"))

        # 5포인트 분배 → 자동 닫힘 (setTimeout 400ms)
        for stat in ["str", "luk", "int", "str", "int"]:
            await page.click(f"[data-alloc='{stat}']")
        await page.wait_for_function(
            "document.getElementById('statModal').classList.contains('hidden')"
        )
        final_stats = await page.evaluate("({ ...state.character.stats })")
        # 시작 LUK 50 + 분배 1
        assert final_stats == {"str": 2, "luk": 51, "int": 2}, f"stats: {final_stats!r}"
        level = await page.text_content("#charLevel")
        assert level.strip() == "2", f"level: {level!r}"
        await page.screenshot(path=str(SHOTS / "07_after_alloc.png"))

        # 6. 인벤토리에서 버리기
        # 두 번째 드롭이 추가됐을 것. 버리기 버튼 클릭
        inv_count_before = await page.locator(".inv-item").count()
        if inv_count_before > 0:
            await page.locator(".inv-discard").first.click()
            inv_count_after = await page.locator(".inv-item").count()
            assert inv_count_after == inv_count_before - 1
        await page.screenshot(path=str(SHOTS / "08_final.png"))

        await browser.close()

    if errors:
        print("\n--- JS errors ---")
        for e in errors:
            print(" ", e)
        raise SystemExit(1)
    print("\n✓ 모든 테스트 통과. 스크린샷:", SHOTS)


def main():
    server = subprocess.Popen(
        ["python3", "-m", "http.server", str(PORT)],
        cwd=str(ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(0.8)
    try:
        asyncio.run(run())
    finally:
        server.terminate()
        server.wait(timeout=5)


if __name__ == "__main__":
    main()
