"""실제 Gemini 호출로 아이템 드랍 + 이미지 생성 흐름을 검증.
generateEquipment()를 직접 호출 (텍스트 1콜 + 이미지 1콜).
모킹 없음. local-config.js의 GEMINI_KEY 필요. 비용 ~$0.08/회.

출력:  test_screenshots/real_drop_inventory.png  (실제 생성된 이미지가 인벤토리에)
"""
import asyncio
import subprocess
import time
from pathlib import Path
from playwright.async_api import async_playwright

PORT = 8768
ROOT = Path(__file__).parent
SHOTS = ROOT / "test_screenshots"


async def run():
    SHOTS.mkdir(exist_ok=True)
    errors = []

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 720, "height": 1100})
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("console", lambda msg: msg.type == "error"
                and "local-config.js" not in msg.text
                and errors.append(f"console.error: {msg.text}"))

        await page.goto(f"http://localhost:{PORT}/")
        await page.evaluate("localStorage.clear(); location.reload();")
        await page.wait_for_selector("#onboarding:not(.hidden)")

        has_key = await page.evaluate("typeof window.GEMINI_KEY === 'string' && window.GEMINI_KEY.length > 0")
        assert has_key, "window.GEMINI_KEY 없음 (local-config.js 누락)"
        print("✓ window.GEMINI_KEY 로드됨")

        # 온보딩 우회 — 게임 화면 보이게만 만듦. 실제 Gemini 콜은 generateEquipment 한 번만.
        await page.evaluate("""
            state.character.jobFantasy = '고대 골렘술사';
            state.character.jobInput = '로봇공학자';
            state.character.reputation = '당신은 묵묵한 골렘술사로 통한다.';
            saveState();
            renderAll();
        """)
        await page.wait_for_selector("#game:not(.hidden)")
        print("✓ 온보딩 우회")

        print("→ 실제 Gemini로 유니크 장비 + 이미지 생성 (텍스트 ~5s + 이미지 ~15s)...")
        result = await page.evaluate(
            """async () => {
                const item = await generateEquipment(
                    'head', true, '균열을 봉인하는 시련을 마치고 보물을 얻었다.'
                );
                state.character.inventory.unshift(item);
                saveState();
                renderAll();
                return {
                    name: item.name,
                    rarity: item.rarity,
                    stats: item.stats,
                    uniqueEffect: item.uniqueEffect,
                    hasImage: !!item.image,
                    imageBytes: item.image ? item.image.length : 0,
                    imagePrefix: item.image ? item.image.slice(0, 30) : null,
                };
            }""",
        )
        print(f"  name:        {result['name']}")
        print(f"  rarity:      {result['rarity']}")
        print(f"  stats:       {result['stats']}")
        print(f"  uniqueEffect:{result['uniqueEffect']}")
        print(f"  hasImage:    {result['hasImage']}")
        print(f"  imageBytes:  {result['imageBytes']}")
        print(f"  imagePrefix: {result['imagePrefix']}")
        assert result["hasImage"], "이미지 생성 실패"
        assert result["imagePrefix"].startswith("data:image/webp"), \
            f"WebP가 아님: {result['imagePrefix']}"

        await page.screenshot(path=str(SHOTS / "real_drop_inventory.png"), full_page=True)
        print(f"✓ 인벤토리 스크린샷 → test_screenshots/real_drop_inventory.png")

        # 장착 → 장비 슬롯에도 이미지 표시되는지 확인 (추가 API 콜 없음)
        await page.click(".inv-equip")
        await page.wait_for_selector(".equip-slot.filled .equip-slot-image")
        await page.screenshot(path=str(SHOTS / "real_drop_equipped.png"), full_page=True)
        print(f"✓ 장착 스크린샷 → test_screenshots/real_drop_equipped.png")

        await browser.close()

    if errors:
        print("\n--- JS errors ---")
        for e in errors:
            print(" ", e)
        raise SystemExit(1)
    print("\n✓ 실제 키로 장비 드랍 + 이미지 생성 동작 확인")


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
