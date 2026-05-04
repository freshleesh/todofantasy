"""
Todo Fantassy 로컬 통합 테스트.
- python3 -m http.server를 백그라운드로 띄우고
- Playwright로 페이지 로드
- Gemini API는 page.route()로 모킹
- 온보딩 → 퀘스트 등록 → 완료 → 카드 픽 → 장착 → 레벨업 → 덱 선택 시나리오 검증
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
    "title": "마트의 미궁",
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
                # local-config.js 404는 무시 (gitignored, 로컬 전용)
                if "local-config.js" in msg.text:
                    return
                errors.append(f"console.error: {msg.text}")

        page.on("console", on_console)
        await page.route("**/api/gemini", mock_gemini)
        # 직접 호출 모드(window.GEMINI_KEY 설정 시) 대비
        await page.route("**/generativelanguage.googleapis.com/**", mock_gemini)

        # 결정적 random — 0.6
        await page.add_init_script("Math.random = () => 0.6;")

        # 1. 온보딩
        await page.goto(f"http://localhost:{PORT}/")
        await page.evaluate("localStorage.clear(); location.reload();")
        await page.wait_for_selector("#onboarding:not(.hidden)")
        await page.screenshot(path=str(SHOTS / "01_onboarding.png"))

        await page.fill("#jobInput", "로봇공학자")
        await page.click("#jobSubmitBtn")
        await page.wait_for_selector("#game:not(.hidden)")
        job = (await page.text_content("#charJob")).strip()
        assert job == JOB_FANTASY, f"job mismatch: {job!r}"
        await page.screenshot(path=str(SHOTS / "02_post_onboarding.png"))

        # 2. 통제된 덱 주입 — 카드 픽이 결정적이도록
        # 난이도 중(2장 드로우), 덱 2장이라 두 장 다 뽑힘
        await page.evaluate(
            "state.character.deck = ['xp1', 'item_normal']; saveState(); renderAll();"
        )

        # 3. 퀘스트 등록
        await page.fill("#todoInput", "마트에서 장 보기")
        await page.click("#addBtn")
        await page.wait_for_selector(".quest-item")
        title = await page.text_content(".quest-title")
        assert "마트의 미궁" in title, f"title: {title!r}"
        slot_count = (await page.text_content("#slotCount")).strip()
        assert slot_count == "2 / 3", f"slot count: {slot_count!r}"
        await page.screenshot(path=str(SHOTS / "03_quest_added.png"), full_page=True)

        # 펼치기 동작 확인
        await page.locator(".quest-title").first.click()
        await page.wait_for_selector(".quest-item.expanded")
        fantasy = await page.text_content(".quest-fantasy")
        assert "마트의 끝없는" in fantasy, f"fantasy: {fantasy!r}"
        await page.locator(".quest-title").first.click()  # 다시 접기

        # 4. 완료 → 카드 픽 모달
        await page.click(".quest-checkbox")
        await page.wait_for_selector("#cardPickModal:not(.hidden)")
        candidate_count = await page.locator("#cardPickList .card.candidate").count()
        assert candidate_count == 2, f"candidates: {candidate_count}"
        await page.screenshot(path=str(SHOTS / "04_card_pick.png"), full_page=True)

        # item_normal 카드 클릭 (있으면)
        item_card = page.locator("#cardPickList .card.candidate[data-id='item_normal']")
        item_count = await item_card.count()
        if item_count > 0:
            await item_card.first.click()
        else:
            # fallback: 첫 후보 클릭
            await page.locator("#cardPickList .card.candidate").first.click()

        # 카드 픽 모달 닫힘 확인
        await page.wait_for_selector("#cardPickModal", state="hidden")

        # 5. item_normal을 골랐다면 인벤토리에 장비 생김
        if item_count > 0:
            await page.wait_for_selector(".inv-item", timeout=5000)
            item_name = await page.text_content(".inv-item-name")
            assert "은빛 룬" in item_name, f"item: {item_name!r}"
            await page.screenshot(path=str(SHOTS / "05_item_dropped.png"), full_page=True)

            # 장착
            await page.click(".inv-equip")
            await page.wait_for_selector(".equip-slot.filled")
            equipped = await page.text_content(".equip-slot.filled .equip-slot-name")
            assert "은빛 룬" in equipped, f"equipped: {equipped!r}"
            await page.screenshot(path=str(SHOTS / "06_equipped.png"), full_page=True)

        # 6. 레벨업 모달 — 강제로 트리거
        await page.evaluate(
            "state.character.pendingLevelUps = 1; saveState(); renderAll();"
        )
        await page.click("#pendingPoints")
        await page.wait_for_selector("#levelupModal:not(.hidden)")
        remaining = await page.text_content("#levelupRemaining")
        assert remaining.strip() == "1", f"remaining: {remaining!r}"
        await page.screenshot(path=str(SHOTS / "07_levelup_modal.png"), full_page=True)

        # 'add_xp_bonus' 선택 → 덱에 추가, 모달 닫힘
        deck_before = await page.evaluate("state.character.deck.length")
        await page.click("[data-levelup='add_xp_bonus']")
        await page.wait_for_selector("#levelupModal", state="hidden")
        deck_after = await page.evaluate("state.character.deck.length")
        assert deck_after == deck_before + 1, f"deck size: {deck_before} → {deck_after}"
        has_bonus = await page.evaluate("state.character.deck.includes('xp_bonus')")
        assert has_bonus, "xp_bonus card not added to deck"
        pending_after = await page.evaluate("state.character.pendingLevelUps")
        assert pending_after == 0, f"pendingLevelUps: {pending_after}"
        await page.screenshot(path=str(SHOTS / "08_after_levelup.png"), full_page=True)

        # 7. 레벨업 — 덱에서 카드 제거 플로우
        await page.evaluate(
            "state.character.pendingLevelUps = 1; saveState(); renderAll();"
        )
        await page.click("#pendingPoints")
        await page.wait_for_selector("#levelupModal:not(.hidden)")
        await page.click("[data-levelup='remove']")
        await page.wait_for_selector("#deckSelectModal:not(.hidden)")
        await page.screenshot(path=str(SHOTS / "09_deck_select.png"), full_page=True)

        # xp_bonus 카드 제거 (방금 추가한 거)
        await page.click("#deckSelectList .card.candidate[data-id='xp_bonus']")
        await page.wait_for_selector("#deckSelectModal", state="hidden")
        has_bonus_after = await page.evaluate("state.character.deck.includes('xp_bonus')")
        assert not has_bonus_after, "xp_bonus should be removed"

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
