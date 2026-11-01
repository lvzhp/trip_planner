"""攻略层生成管线（docs/07 §9）。

独立于主 agent loop：主 loop 是协商式的（多轮、ask_user、冲突修复、写 Trip JSON），
这里是"一次性检索填充"——读多写零、不碰 Trip JSON、可缓存。混在一起会让攻略
继承主 loop 的重试/瘦身/SSE 复杂度，还会污染规划上下文。

管线：`prompt 定 schema → 并发调 around + web_search → LLM 填充 →
服务端按名字回填权威候选 → Pydantic 校验 → 存缓存`。

关键安全设计：**模型只能从候选里挑选并注解，坐标/poiid/距离一律由服务端回填**
（`_backfill`）。模型写名字和一句话，服务端按名字回查权威结果，查不到就丢弃。
这是"坐标必须来自 search_poi"铁律在攻略层的延伸，同时防止模型篡改坐标导致
导航深链把人带到错误地点。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from typing import Any

from app.agent.prompts import GUIDE_SYSTEM_PROMPT, guide_user_prompt
from app.config import Settings
from app.db import Database
from app.llm.providers import ProviderError, build_provider
from app.schemas.guide import GuideItem, GuideSection, GuideStage, StopGuide
from app.schemas.plan import Stop
from app.tools.amap import AmapClient, AmapError
from app.tools.mock_data import mock_search_around, mock_web_search
from app.tools.tavily import TavilyClient, TavilyError

CACHE_TOOL = "stop_guide"
AROUND_RADIUS_M = 3000
AROUND_LIMIT = 20


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def poi_hash(stop: Stop) -> str:
    """stop_id 跨重规划必须存活（prompts.py 硬约束），所以「改这里」把禾木村
    换成白哈巴后 stop_id 不变 —— 必须靠 POI 身份区分新旧，否则会把禾木村的
    攻略显示在白哈巴名下。

    不含 address：高德同一 POI 的 address 偶尔因数据更新微调，含进去会导致
    无意义的重新生成。
    """
    poi = stop.poi
    raw = f"{poi.amap_poi_id or ''}|{poi.name}|{poi.lng}|{poi.lat}"
    return hashlib.sha1(raw.encode()).hexdigest()[:12]


def _hash(values: Any) -> str:
    raw = json.dumps(values, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha1(raw.encode()).hexdigest()[:12]


def filter_hash(filters: list[str]) -> str:
    return _hash(sorted(f.strip() for f in filters if f.strip())) or "none"


def profile_hash(diet: list[str], taste: list[str]) -> str:
    if not diet and not taste:
        return "none"
    return _hash({"diet": sorted(diet), "taste": sorted(taste)})


class GuideService:
    def __init__(self, settings: Settings, db: Database):
        self.settings = settings
        self.db = db
        self.amap = AmapClient(settings)
        self.tavily = TavilyClient(settings)

    # ------------------------------------------------------------------
    # cache
    # ------------------------------------------------------------------
    def cache_params(
        self, trip_id: str, stop: Stop, filters: list[str], diet: list[str], taste: list[str]
    ) -> dict[str, Any]:
        """缓存 key 的每个维度都会导致自动失效（docs/07 §9）：
        - poi_hash：换地点（update_stop 改 poi，stop_id 不变）
        - filter_hash：用户点了口味/范围 chips
        - profile_hash：用户改了长期偏好档案
        - mode：演示模式与真实模式的结果不能互相顶替（同 registry._cache_params）
        孤儿条目靠 tool_cache 的 TTL + cache_cleanup 自然消失，不需要失效逻辑。
        """
        return {
            "trip_id": trip_id,
            "stop_id": stop.stop_id,
            "poi_hash": poi_hash(stop),
            "filter_hash": filter_hash(filters),
            "profile_hash": profile_hash(diet, taste),
            "_mode": "real" if self._real() else "mock",
        }

    async def cached(self, params: dict[str, Any]) -> StopGuide | None:
        raw = await self.db.cache_get(CACHE_TOOL, params)
        if not raw:
            return None
        try:
            return StopGuide.model_validate(raw)
        except Exception:  # 结构演进导致的旧缓存：当作 miss 重新生成
            return None

    # ------------------------------------------------------------------
    # mode / configuration
    # ------------------------------------------------------------------
    def _real(self) -> bool:
        """沿用 registry._source_for 的模式分裂：Mock provider → 离线 fixture；
        真实 provider → 必须配齐 Key，缺了就明确报错，绝不拿 fixture 冒充。"""
        return not self.settings.demo_mode

    def missing_keys(self) -> list[str]:
        out = []
        if not self.amap.configured:
            out.append("AMAP_WEB_KEY")
        if not self.tavily.configured:
            out.append("TAVILY_API_KEY")
        return out

    # ------------------------------------------------------------------
    # public API
    # ------------------------------------------------------------------
    async def stream(
        self,
        *,
        trip_id: str,
        trip_title: str | None,
        season_note: str | None,
        stop: Stop,
        filters: list[str],
        diet: list[str],
        taste: list[str],
        provider_id: str,
        model: str,
        refresh: bool = False,
    ) -> AsyncIterator[GuideStage]:
        params = self.cache_params(trip_id, stop, filters, diet, taste)
        if not refresh:
            hit = await self.cached(params)
            if hit is not None:
                yield GuideStage(stage="done", label="已缓存", detail=hit)
                return

        if self._real() and (missing := self.missing_keys()):
            # 真实模式缺 Key：明确报未配置，不用 fixture 兜底（docs/07 §9）
            guide = StopGuide(
                trip_id=trip_id,
                stop_id=stop.stop_id,
                poi_hash=poi_hash(stop),
                filter_hash=filter_hash(filters),
                profile_hash=profile_hash(diet, taste),
                source="real",
                not_configured="、".join(missing),
                generated_at=_now_iso(),
            )
            yield GuideStage(
                stage="error",
                label="未配置检索服务",
                detail=guide,
                error=f"生成地点攻略需要 {'、'.join(missing)}，请在「接入配置」里填写。",
            )
            return

        yield GuideStage(stage="searching", label="正在检索周边…")
        try:
            food_rows, spot_rows, web_food, web_spot = await self._retrieve(stop, filters)
        except (AmapError, TavilyError) as exc:
            yield GuideStage(stage="error", label="检索失败", error=exc.message)
            return

        if not food_rows and not spot_rows and not web_food and not web_spot:
            guide = self._empty_guide(trip_id, stop, filters, diet, taste, "mock" if not self._real() else "real")
            guide.food.narrative = ["这一带没有检索到可用的周边信息。"]
            yield GuideStage(stage="done", label="无周边结果", detail=guide)
            return
        # around 为空但 web 检索有内容时不短路：偏远景区（禾木/喀纳斯）周边
        # POI 稀疏是常态，丢掉 Tavily 已检索到的特色叙事会让现场场景空手而归。
        # items 会因回填机制自然为空（模型不能编店名），narrative 仍然成立。

        yield GuideStage(stage="writing", label="正在整理推荐…")
        try:
            guide = await self._write(
                trip_id=trip_id,
                trip_title=trip_title,
                season_note=season_note,
                stop=stop,
                filters=filters,
                diet=diet,
                taste=taste,
                food_rows=food_rows,
                spot_rows=spot_rows,
                web_food=web_food,
                web_spot=web_spot,
                provider_id=provider_id,
                model=model,
            )
        except (ProviderError, ValueError) as exc:
            message = getattr(exc, "message", None) or str(exc)
            yield GuideStage(stage="error", label="生成失败", error=f"攻略生成失败：{message}")
            return

        await self.db.cache_set(CACHE_TOOL, params, guide.model_dump(mode="json"), self.settings.cache_ttl_guide)
        yield GuideStage(stage="done", label="完成", detail=guide)

    # ------------------------------------------------------------------
    # retrieval
    # ------------------------------------------------------------------
    async def _retrieve(
        self, stop: Stop, filters: list[str]
    ) -> tuple[list[dict], list[dict], str, str]:
        poi = stop.poi
        lng, lat = poi.lng, poi.lat
        keyword = " ".join(f.strip() for f in filters if f.strip()) or None

        if not self._real():
            food = mock_search_around(lng, lat, "food", radius=AROUND_RADIUS_M, limit=AROUND_LIMIT)
            spots = mock_search_around(lng, lat, "spot", radius=AROUND_RADIUS_M, limit=AROUND_LIMIT)
            web_food = mock_web_search(f"{poi.name} 特色美食 推荐", 3).conclusion or ""
            web_spot = mock_web_search(f"{poi.name} 打卡 拍照 机位", 3).conclusion or ""
            return _rows(food), _rows(spots), web_food, web_spot

        if lng is None or lat is None:
            raise AmapError("no_coord", f"「{poi.name}」没有坐标，无法做周边检索")

        food_task = self.amap.search_around(lng, lat, "food", None, AROUND_RADIUS_M, AROUND_LIMIT)
        spot_task = self.amap.search_around(lng, lat, "spot", None, AROUND_RADIUS_M, AROUND_LIMIT)
        web_food_task = self.tavily.search(f"{poi.name} {poi.city or ''} 特色美食 推荐 小红书", 3)
        web_spot_task = self.tavily.search(f"{poi.name} {poi.city or ''} 打卡 拍照 机位 最佳时间", 3)
        food, spots, wf, ws = await asyncio.gather(food_task, spot_task, web_food_task, web_spot_task)
        return _rows(food), _rows(spots), wf.conclusion or "", ws.conclusion or ""

    # ------------------------------------------------------------------
    # LLM fill
    # ------------------------------------------------------------------
    async def _write(
        self,
        *,
        trip_id: str,
        trip_title: str | None,
        season_note: str | None,
        stop: Stop,
        filters: list[str],
        diet: list[str],
        taste: list[str],
        food_rows: list[dict],
        spot_rows: list[dict],
        web_food: str,
        web_spot: str,
        provider_id: str,
        model: str,
    ) -> StopGuide:
        if provider_id == "mock":
            return self._mock_guide(trip_id, stop, filters, diet, taste, food_rows, spot_rows)

        provider = build_provider(self.settings, provider_id)
        prompt = guide_user_prompt(
            poi_name=stop.poi.name,
            city=stop.poi.city,
            trip_title=trip_title,
            season_note=season_note,
            diet=[*diet, *taste],
            filters=filters,
            food_candidates=food_rows,
            spot_candidates=spot_rows,
            web_food=web_food,
            web_spot=web_spot,
        )
        response = await provider.chat(
            [
                {"role": "system", "content": GUIDE_SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            [],
            model,
        )
        parsed = _parse_json_object(response.content)
        if parsed is None:
            raise ValueError("模型没有返回可解析的 JSON")

        guide = self._empty_guide(
            trip_id, stop, filters, diet, taste, "mock" if not self._real() else "real"
        )
        guide.food = _section(parsed.get("food"), food_rows, with_best_time=False)
        guide.spot = _section(parsed.get("spot"), spot_rows, with_best_time=True)
        return guide

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    def _empty_guide(
        self,
        trip_id: str,
        stop: Stop,
        filters: list[str],
        diet: list[str],
        taste: list[str],
        source: str,
    ) -> StopGuide:
        return StopGuide(
            trip_id=trip_id,
            stop_id=stop.stop_id,
            poi_hash=poi_hash(stop),
            filter_hash=filter_hash(filters),
            profile_hash=profile_hash(diet, taste),
            source="mock" if source == "mock" else "real",
            generated_at=_now_iso(),
        )

    def _mock_guide(
        self,
        trip_id: str,
        stop: Stop,
        filters: list[str],
        diet: list[str],
        taste: list[str],
        food_rows: list[dict],
        spot_rows: list[dict],
    ) -> StopGuide:
        """不调模型的填充路径（LLM provider == mock）。

        注意两条轴是独立的：
        - **检索轴** `_real()`：数据是高德/Tavily 真实返回，还是内置离线 fixture。
          它决定 `source` 字段与前端"演示数据"横幅（docs/07 §9）。
        - **LLM 轴** `provider == mock`：有没有大模型来写叙事与特色注解。

        诚实性铁律：叙事必须反映**数据**的真实来源，不能因为走了这条无 LLM 的路径
        就把真实检索结果说成"演示数据"。
        """
        # source 只跟随检索轴
        guide = self._empty_guide(
            trip_id, stop, filters, diet, taste, "real" if self._real() else "mock"
        )
        name = stop.poi.name
        retrieval_real = self._real()
        if retrieval_real:
            # 数据是真的，只是没接大模型写注解：如实说明，不谎称演示数据
            food_note = (
                f"{name}周边餐饮来自高德实时检索。当前未接大模型生成特色说明，"
                "列表按距离给出真实店铺，可直接点导航；接入模型后会补充当地特色与推荐菜。"
            )
            spot_note = f"{name}周边打卡点来自高德实时检索，未接大模型，暂无最佳时间/机位说明。"
        else:
            food_note = (
                f"{name}周边的餐饮候选来自内置离线数据，仅用于演示交互，不是真实检索结果。"
                "配置高德 Web Key 与 Tavily Key 后，这里会换成真实周边店铺与当地特色说明。"
            )
            spot_note = f"{name}周边的打卡候选同样来自离线数据，仅用于演示。"
        guide.food = GuideSection(
            narrative=[food_note],
            items=[_item_from_row(r) for r in food_rows[:6]],
        )
        guide.spot = GuideSection(
            narrative=[spot_note],
            items=[_item_from_row(r) for r in spot_rows[:5]],
        )
        return guide


# --------------------------------------------------------------------------
# module-level helpers
# --------------------------------------------------------------------------


def _rows(pois) -> list[dict]:
    return [
        {
            "name": p.name,
            "amap_poi_id": p.amap_poi_id,
            "lng": p.lng,
            "lat": p.lat,
            "address": p.address,
            "category": p.category,
            "distance_m": p.distance_m,
            "source_ref": p.source_ref,
        }
        for p in pois
    ]


def _item_from_row(row: dict, highlight: str | None = None, best_time: str | None = None) -> GuideItem:
    return GuideItem(
        name=row["name"],
        amap_poi_id=row.get("amap_poi_id"),
        lng=row.get("lng"),
        lat=row.get("lat"),
        distance_m=row.get("distance_m"),
        highlight=(highlight or "").strip() or None,
        best_time=(best_time or "").strip() or None,
        source_ref=row.get("source_ref"),
    )


def _norm_key(name: str) -> str:
    """按名字回查候选时的宽松匹配：去空格、去括号内容差异、转小写。"""
    return "".join(str(name).split()).replace("（", "(").replace("）", ")").lower()


def _section(raw: Any, rows: list[dict], *, with_best_time: bool) -> GuideSection:
    """把模型输出转成 GuideSection，并用服务端候选回填权威字段。

    模型写的名字在候选里找不到 → 丢弃该条（铁律 1）。坐标/poiid/距离
    一律取候选值，模型无权决定。
    """
    if not isinstance(raw, dict):
        return GuideSection()
    narrative = [str(x).strip() for x in (raw.get("narrative") or []) if str(x).strip()][:3]
    by_name = {_norm_key(r["name"]): r for r in rows}
    items: list[GuideItem] = []
    for entry in raw.get("items") or []:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        if not name:
            continue
        row = by_name.get(_norm_key(name))
        if row is None:
            continue  # 不在候选池里：可能是模型编的，丢弃
        highlight = entry.get("highlight")
        best_time = entry.get("best_time") if with_best_time else None
        items.append(
            _item_from_row(
                row,
                str(highlight).strip() if highlight else None,
                str(best_time).strip() if best_time else None,
            )
        )
    return GuideSection(narrative=narrative, items=items[:10])


def _parse_json_object(text: str) -> dict[str, Any] | None:
    """容忍 ```json 围栏与前后解释文字，取第一个平衡的 {...}。"""
    if not text:
        return None
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    parsed = json.loads(text[start : i + 1])
                except json.JSONDecodeError:
                    return None
                return parsed if isinstance(parsed, dict) else None
    return None
