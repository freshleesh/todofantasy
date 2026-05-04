"""
실제 Gemini API 키 검증 — local-config.js를 로드한 상태로 페이지를 띄우고
직업 변환 + 퀘스트 변환을 실제 Gemini로 호출. 모킹 없음.
"""
import asyncio
import subprocess
import time
from pathlib import Path
from playwright.async_api import async_playwright

PORT = 8766
ROOT = Path(__file__).parent
SHOTS = ROOT / "test_screenshots"


async def run():
    SHOTS.mkdir(exist_ok=True)
    errors: list[str] = []
    real_calls: list[dict] = []

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 720, "height": 1100})

        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

        def on_console(msg):
            if msg.type == "error" and "local-config.js" not in msg.text:
                errors.append(f"console.error: {msg.text}")

        page.on("console", on_console)

        # 실제 Gemini 호출 추적 (모킹은 없음)
        def on_request(req):
            if "generativelanguage.googleapis.com" in req.url:
                real_calls.append({"url": req.url[:80], "method": req.method})

        page.on("request", on_request)

        await page.goto(f"http://localhost:{PORT}/")
        await page.evaluate("localStorage.clear(); location.reload();")
        await page.wait_for_selector("#onboarding:not(.hidden)")

        # GEMINI_KEY 로드 확인
        has_key = await page.evaluate("typeof window.GEMINI_KEY === 'string' && window.GEMINI_KEY.length > 0")
        assert has_key, "window.GEMINI_KEY가 로드되지 않음 (local-config.js 누락?)"
        print("✓ window.GEMINI_KEY 로드됨")

        # 1. 온보딩 — 실제 Gemini
        await page.fill("#jobInput", "백엔드 엔지니어")
        await page.click("#jobSubmitBtn")
        await page.wait_for_selector("#game:not(.hidden)", timeout=20000)
        job = (await page.text_content("#charJob")).strip()
        assert len(job) > 0 and len(job) < 60, f"job 비정상: {job!r}"
        print(f"✓ 직업 변환: 백엔드 엔지니어 → {job}")

        # 2. 퀘스트 변환 — 실제 Gemini
        await page.fill("#todoInput", "버그 수정하기")
        await page.click("#addBtn")
        await page.wait_for_selector(".quest-item", timeout=20000)
        title = (await page.text_content(".quest-title")).strip()
        await page.locator(".quest-title").first.click()
        await page.wait_for_selector(".quest-item.expanded")
        fantasy = (await page.text_content(".quest-fantasy")).strip()
        difficulty = await page.evaluate("state.quests[0].difficulty")
        assert difficulty in ("상", "중", "하"), f"difficulty: {difficulty!r}"
        print(f"✓ 퀘스트 변환: 버그 수정하기")
        print(f"   제목: {title}")
        print(f"   본문 ({len(fantasy)}자):")
        for line in fantasy.split('\n'):
            print(f"     {line}")
        print(f"   난이도: {difficulty}")

        await page.screenshot(path=str(SHOTS / "real_key_quest.png"), full_page=True)

        # 호출 검증
        assert len(real_calls) >= 2, f"Gemini 호출 수: {len(real_calls)} (직업+퀘스트 = 2 이상이어야 함)"
        print(f"✓ Gemini 직접 호출 {len(real_calls)}건 (프록시 거치지 않음)")

        await browser.close()

    if errors:
        print("\n--- JS errors ---")
        for e in errors:
            print(" ", e)
        raise SystemExit(1)
    print("\n✓ 실제 키로 end-to-end 동작 확인 완료")


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
