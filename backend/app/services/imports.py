"""链接 / 截图 / 粘贴文本导入（mindtrip/06 §9）+ 拍照识地（P2-2）。

真实管线：抓取或 OCR → LLM 抽地点 → 地理编码 → **候选确认面板**。没有 key 时每一步
都要**显式失败**并给出下一步（手动搜索），不允许假装识别成功、也不允许落库原图。
"""

from __future__ import annotations

import base64
import html
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Iterable

import httpx

from app.config import Settings
from app.schemas.plan import Trip
from app.schemas.places import ImportItem, ImportResult
from app.services.places import PlaceService

TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"[ \t\r\f\v]+")
#: 中文地点常见后缀（用于在网页正文里挑候选名，宁可少挑不要乱挑）
PLACE_SUFFIX = (
    "寺|祠|宫|馆|园|园地|公园|街|巷|里|路|桥|湖|山|塔|门|村|镇|岛|湾|滩|谷|岭|峰|洞|泉|"
    "城|楼|阁|堂|院|坊|店|餐厅|饭馆|咖啡|菜场|市场|广场|车站|机场|码头|码头|书院|花园"
)
QUOTE_RE = re.compile(r"[「『“\"《【]([^」』”\"》】\n]{2,18})[」』”\"》】]")
LIST_RE = re.compile(r"^\s*(?:[-*•·]|\d+[.、)）])\s*(.{2,28})$", re.MULTILINE)
SUFFIX_RE = re.compile(rf"[\u4e00-\u9fa5A-Za-z0-9（）()·\-]{{2,12}}(?:{PLACE_SUFFIX})")
TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.S | re.I)
MAX_ITEMS = 12
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_IMAGES = 10


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _text_of_html(raw: str) -> str:
    raw = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", raw or "")
    return html.unescape(TAG_RE.sub(" ", raw))


def _candidate_names(text: str, limit: int = MAX_ITEMS) -> list[str]:
    """从正文里抽地点名。顺序：引号 / 列表项 / 后缀匹配。"""
    seen: list[str] = []
    lowered: set[str] = set()

    def add(name: str) -> None:
        name = re.sub(r"\s+", "", name or "").strip("·-—_ ")
        if len(name) < 2 or len(name) > 20:
            return
        if name in lowered:
            return
        if name in {"今天", "明天", "这里", "附近", "推荐", "注意", "交通", "住宿"}:
            return
        lowered.add(name)
        seen.append(name)

    for match in QUOTE_RE.finditer(text):
        add(match.group(1))
    if len(seen) < limit:
        for match in LIST_RE.finditer(text):
            add(match.group(1))
    if len(seen) < limit:
        for match in SUFFIX_RE.finditer(text):
            add(match.group(0))
    return seen[:limit]


_NAME_SUFFIXES = (
    "风景区", "景区", "村落", "村", "古镇", "镇", "公园", "博物馆", "纪念馆",
    "寺", "宫", "塔", "湖", "山", "街", "巷", "站", "机场", "码头", "店",
)


def _normalize_name(name: str) -> str:
    value = (name or "").strip()
    for suffix in _NAME_SUFFIXES:
        if value.endswith(suffix) and len(value) > len(suffix) + 1:
            value = value[: -len(suffix)]
            break
    return value


def _name_similar(a: str, b: str) -> bool:
    """去重第二级：name+city 相似度（§9）。去掉「风景区/村/店」这类后缀再比。"""
    left, right = _normalize_name(a), _normalize_name(b)
    if not left or not right:
        return False
    if left == right:
        return True
    if min(len(left), len(right)) >= 3 and (left in right or right in left):
        return True
    return False


def _existing_index(trip: Trip | None) -> tuple[list[str], set[str]]:
    names: list[str] = []
    ids: set[str] = set()
    if trip is None:
        return names, ids
    for day in trip.days:
        for stop in day.stops:
            full = stop.poi.name or ""
            parts = [part.strip() for part in full.split(" · ") if part.strip()]
            city = (stop.poi.city or "").strip()
            for index, name in enumerate([full, *parts]):
                if not name or name in names:
                    continue
                # parts[0] 常常是城市前缀（「乌鲁木齐 · 新疆国际大巴扎」），
                # 把它当地点名会让所有含城市名的候选都误判为「已在行程」。
                if index == 1 and city and (name in city or city in name):
                    continue
                names.append(name)
            if stop.poi.amap_poi_id:
                ids.add(stop.poi.amap_poi_id)
    return names, ids


async def _fetch_page(url: str, settings: Settings) -> tuple[str, str | None]:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
        ),
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True, trust_env=settings.http_trust_env) as client:
        resp = await client.get(url, headers=headers)
        resp.raise_for_status()
        raw = resp.text
    title_match = TITLE_RE.search(raw)
    title = html.unescape(TITLE_RE.sub(r"\1", title_match.group(0))) if title_match else None
    title = title.strip() if title else None
    return _text_of_html(raw), title


async def import_link(
    *,
    url: str | None,
    text: str | None,
    trip: Trip | None,
    places: PlaceService,
    settings: Settings,
    city: str | None = None,
) -> ImportResult:
    job_id = "imp_" + uuid.uuid4().hex[:10]
    failures: list[str] = []
    title: str | None = None
    body = (text or "").strip()

    if url:
        try:
            fetched, title = await _fetch_page(url, settings)
            body = f"{title or ''}\n{fetched}" if title else fetched
        except Exception as exc:  # noqa: BLE001 - 抓取失败要显式报给用户
            return ImportResult(
                job_id=job_id,
                kind="link",
                source_url=url,
                items=[],
                failures=[f"链接打不开：{exc}"],
                message="链接打不开。可以复制正文粘贴进来，或直接手动搜索地点。",
                fetched_at=_now(),
            )

    if not body:
        return ImportResult(
            job_id=job_id,
            kind="text",
            items=[],
            failures=["没有可解析的正文"],
            message="没有内容可解析：贴一段正文，或先打开链接再复制。",
            fetched_at=_now(),
        )

    names = _candidate_names(body)
    if not names:
        return ImportResult(
            job_id=job_id,
            kind="link" if url else "text",
            source_url=url,
            title=title,
            items=[],
            failures=["没识别到地点"],
            message="没识别到地点。可以手动搜索地点，或贴一段带地名的正文。",
            fetched_at=_now(),
        )

    known_names, known_ids = _existing_index(trip)
    target_city = city or (trip.days[0].stops[0].poi.city if trip and trip.days and trip.days[0].stops else None)
    items: list[ImportItem] = []
    for name in names:
        located = await places.locate(name, target_city)
        if located is None:
            items.append(ImportItem(name=name, city=target_city, located=False))
            failures.append(f"「{name}」定位失败")
            continue
        amap_id, lng, lat, address, resolved, resolved_city = located
        item_city = resolved_city or target_city
        if amap_id and amap_id in known_ids:
            day = _day_of(trip, amap_id=amap_id)
            items.append(
                ImportItem(
                    poi_id=resolved if not amap_id else amap_id,
                    name=resolved or name,
                    city=item_city,
                    address=address,
                    lat=lat,
                    lng=lng,
                    located=True,
                    duplicate=True,
                    in_trip_day=day,
                    amap_poi_id=amap_id,
                )
            )
            continue
        similar = next((known for known in known_names if _name_similar(resolved or name, known)), None)
        if similar is not None:
            items.append(
                ImportItem(
                    poi_id=resolved if not amap_id else amap_id,
                    name=resolved or name,
                    city=item_city,
                    address=address,
                    lat=lat,
                    lng=lng,
                    located=True,
                    duplicate=True,
                    in_trip_day=_day_of(trip, name=similar),
                    amap_poi_id=amap_id,
                )
            )
            continue
        items.append(
            ImportItem(
                poi_id=amap_id or f"imp:{resolved or name}",
                name=resolved or name,
                city=item_city,
                address=address,
                lat=lat,
                lng=lng,
                located=True,
                duplicate=False,
                in_trip_day=_day_of(trip, amap_id=amap_id) if amap_id else None,
                amap_poi_id=amap_id,
            )
        )

    seen_ids: set[str] = set()
    for item in items:
        key = item.amap_poi_id or item.poi_id or item.name
        if key in seen_ids:
            item.duplicate = True
        seen_ids.add(str(key))

    message = None
    if not any(item.located for item in items):
        message = "识别出地点名，但一个都没定位成功。可以手动搜索补位置，或换一条链接。"
    elif any(not item.located for item in items):
        message = "有地点未定位：确认面板里可以手动搜索，或先跳过它们。"
    return ImportResult(
        job_id=job_id,
        kind="link" if url else "text",
        source_url=url,
        title=title,
        items=items,
        failures=failures,
        message=message,
        fetched_at=_now(),
    )


def _day_of(trip: Trip | None, *, amap_id: str | None = None, name: str | None = None) -> int | None:
    if trip is None:
        return None
    for day in trip.days:
        for stop in day.stops:
            if amap_id and stop.poi.amap_poi_id == amap_id:
                return day.day_index
            if not name:
                continue
            full = stop.poi.name or ""
            variants = [full, *[part.strip() for part in full.split(" · ") if part.strip()]]
            if any(variant == name or _name_similar(variant, name) for variant in variants):
                return day.day_index
    return None


def _decode_image(data_base64: str) -> bytes:
    raw = data_base64.split(",", 1)[-1] if data_base64.startswith("data:") else data_base64
    return base64.b64decode(raw, validate=False)


async def import_images(
    images: Iterable[tuple[str, str]], mode: str = "screenshot"
) -> ImportResult:
    """截图 / 拍照识别（P1-4 / P2-2）。

    本仓库没有 OCR / 视觉模型接线，因此这里**显式失败**：校验数量与大小、说明原因、
    指向手动搜索。原图不落盘（所以不存在「超过 24h」的留存问题）。
    """
    job_id = "imp_" + uuid.uuid4().hex[:10]
    received = list(images)
    failures: list[str] = []
    kept = 0
    for name, data in received[:MAX_IMAGES]:
        try:
            payload = _decode_image(data)
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{name} 解码失败：{exc}")
            continue
        if len(payload) > MAX_IMAGE_BYTES:
            failures.append(f"{name} 超过 5MB，已跳过")
            continue
        kept += 1
    if len(received) > MAX_IMAGES:
        failures.append(f"一次最多 {MAX_IMAGES} 张，超出部分已忽略")
    label = "拍照" if mode == "photo" else "截图"
    message = (
        f"{label}已收到，但当前部署没有配置 OCR / 视觉模型，无法自动识别地点。"
        "可以先手动搜索地点，或配置视觉模型后重试。原图不会被保存。"
    )
    return ImportResult(
        job_id=job_id,
        kind="images",
        items=[],
        failures=failures,
        message=message if kept else "没有收到有效图片（支持 1–10 张，每张 ≤5MB）。",
        fetched_at=_now(),
    )
