"""카드 일러스트 후처리:
1. 배경 픽셀(이미지 모서리에서 자동 검출)을 투명하게
2. 512x512로 리사이즈
3. WebP로 저장 (고품질)
4. 원본 PNG 삭제 — WebP가 곧 production asset이고 PNG는 중간 산출물

사용:
  python3 scripts/process-card-art.py                # asset/cards/의 모든 PNG
  python3 scripts/process-card-art.py xp1.png xp2.png  # 일부만
"""
import sys
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "asset" / "cards"

# 순백 배경 기준 — 흰색에 가까운 픽셀만 투명, 그 외는 보존
TOL_LOW = 10    # 거리 이하: 완전 투명 (= 거의 #fff)
TOL_HIGH = 35   # 거리 이상: 완전 불투명
TARGET = 512


def detect_bg(arr: np.ndarray) -> np.ndarray:
    """이미지 4 모서리 16x16 패치 평균으로 배경색 추정."""
    s = 16
    corners = np.concatenate([
        arr[:s, :s].reshape(-1, 3),
        arr[:s, -s:].reshape(-1, 3),
        arr[-s:, :s].reshape(-1, 3),
        arr[-s:, -s:].reshape(-1, 3),
    ], axis=0)
    return corners.mean(axis=0)


def process(src: Path) -> tuple[Path, int, int]:
    img = Image.open(src).convert("RGB")
    arr = np.asarray(img, dtype=np.float32)
    bg = detect_bg(arr)

    dist = np.linalg.norm(arr - bg, axis=2)
    alpha = np.clip((dist - TOL_LOW) / (TOL_HIGH - TOL_LOW), 0.0, 1.0) * 255.0
    alpha = alpha.astype(np.uint8)

    rgba = np.dstack([arr.astype(np.uint8), alpha])
    out = Image.fromarray(rgba, "RGBA")
    out = out.resize((TARGET, TARGET), Image.LANCZOS)

    dst = src.with_suffix(".webp")
    out.save(dst, "WEBP", quality=88, method=6)

    in_kb = src.stat().st_size // 1024
    out_kb = dst.stat().st_size // 1024
    src.unlink()  # WebP 정상 저장 후 원본 PNG 삭제
    return dst, in_kb, out_kb


def main():
    if len(sys.argv) > 1:
        targets = [SRC / name for name in sys.argv[1:]]
        for t in targets:
            if not t.exists():
                print(f"없음: {t}")
                sys.exit(1)
    else:
        targets = sorted(SRC.glob("*.png"))

    if not targets:
        print(f"처리할 PNG 없음 ({SRC})")
        return

    total_in = total_out = 0
    for src in targets:
        dst, in_kb, out_kb = process(src)
        total_in += in_kb
        total_out += out_kb
        print(f"  {src.name:>20} ({in_kb:>5} KB) → {dst.name:>20} ({out_kb:>5} KB)  [원본 삭제]")
    if total_in > 0:
        print(f"\n총합: {total_in} KB → {total_out} KB ({100 - total_out * 100 // total_in}% 감소)")


if __name__ == "__main__":
    main()
