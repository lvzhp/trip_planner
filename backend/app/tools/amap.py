"""High-德 (AMap) Web Service client.

Only three capabilities are exposed: POI search, route planning, weather.
Every response carries a server-issued `source_ref` so a plan can always be
traced back to the tool call that produced it (docs §3.1).
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

import httpx

from app.config import Settings
from app.schemas.tools import AroundPoi, PoiResult, RouteResult, ToolError, WeatherResult




def _parse_polyline(raw: Any) -> list[list[float]]:
    points: list[list[float]] = []
    for chunk in str(raw or "").split(";"):
        if "," not in chunk:
            continue
        lng_s, lat_s = chunk.split(",", 1)
        try:
            points.append([float(lng_s), float(lat_s)])
        except ValueError:
            continue
    return points


def _extract_polyline(first: dict[str, Any], mode: str) -> list[list[float]]:
    """从高德路径结果里拼出完整几何（driving/walking 用 steps，公交用 segments）。"""
    points: list[list[float]] = []
    if mode == "transit":
        for segment in first.get("segments") or []:
            walking = segment.get("walking") or {}
            for step in walking.get("steps") or []:
                points.extend(_parse_polyline(step.get("polyline")))
            bus = segment.get("bus") or {}
            for line in bus.get("buslines") or []:
                points.extend(_parse_polyline(line.get("polyline")))
    else:
        for step in first.get("steps") or []:
            points.extend(_parse_polyline(step.get("polyline")))
    return points


def _simplify_polyline(points: list[list[float]], max_points: int = 900) -> list[list[float]] | None:
    """Douglas-Peucker 压点：保留道路转弯，去掉直线上的冗余点（控制 DB / 详情体积）。"""
    if len(points) <= 2:
        return points or None
    tolerance = 0.00022  # 约 20m
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        start, end = stack.pop()
        if end <= start + 1:
            continue
        ax, ay = points[start]
        bx, by = points[end]
        dx, dy = bx - ax, by - ay
        seg_len = (dx * dx + dy * dy) ** 0.5
        max_dist = -1.0
        max_index = -1
        for index in range(start + 1, end):
            px, py = points[index]
            if seg_len == 0:
                dist = ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
            else:
                dist = abs(dy * px - dx * py + bx * ay - by * ax) / seg_len
            if dist > max_dist:
                max_dist, max_index = dist, index
        if max_dist > tolerance:
            keep[max_index] = True
            stack.append((start, max_index))
            stack.append((max_index, end))
    simplified = [point for point, flag in zip(points, keep) if flag]
    if len(simplified) > max_points:
        step = len(simplified) / max_points
        simplified = [simplified[int(i * step)] for i in range(max_points - 1)] + [simplified[-1]]
    return simplified or points[:1]


class AmapError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        self.code = code
        self.message = message
        self.retryable = retryable
        super().__init__(message)

    def as_error(self, tool: str) -> ToolError:
        return ToolError(tool=tool, code=self.code, message=self.message, retryable=self.retryable)


def _ref(prefix: str, payload: Any) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    return f"{prefix}:{hashlib.sha1(raw.encode()).hexdigest()[:12]}"


def _to_int(value: Any) -> int | None:
    """高德常把数值字段返回成字符串（distance="234"），空串/缺失返回 None。"""
    if value is None or value == "":
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


class AmapClient:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.key = settings.amap_web_key

    @property
    def configured(self) -> bool:
        return bool(self.key)

    async def _get(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        if not self.key:
            raise AmapError("no_key", "未配置高德 Web 服务 key", retryable=False)
        q = {"key": self.key, "output": "json", **params}
        try:
            async with httpx.AsyncClient(timeout=15.0, trust_env=self.settings.http_trust_env) as client:
                resp = await client.get(f"{self.settings.amap_base_url.rstrip('/')}/{path}", params=q)
                resp.raise_for_status()
                data = resp.json()
        except httpx.HTTPError as exc:
            raise AmapError("http_error", f"高德请求失败：{exc}", retryable=True) from exc
        if str(data.get("status")) != "1":
            raise AmapError(
                str(data.get("infocode") or "amap_error"),
                str(data.get("info") or "高德接口返回错误"),
                retryable=str(data.get("infocode")) in {"10004", "10021"},
            )
        return data

    async def search_poi(
        self, keyword: str, city: str | None, category: str | None, limit: int = 8
    ) -> list[PoiResult]:
        params: dict[str, Any] = {
            "keywords": keyword,
            "offset": min(limit, 8),
            "page": 1,
            "extensions": "base",
        }
        if city:
            params["city"] = city
            params["citylimit"] = "false"
        if category:
            mapping = {"景点": "110000", "美食": "050000", "酒店": "100000", "交通": "150000"}
            params["types"] = mapping.get(category, "")
        data = await self._get("place/text", params)
        pois = data.get("pois") or []
        out: list[PoiResult] = []
        for poi in pois[:limit]:
            loc = poi.get("location") or ""
            if "," not in loc:
                continue
            lng_s, lat_s = loc.split(",", 1)
            try:
                lng, lat = float(lng_s), float(lat_s)
            except ValueError:
                continue
            city_raw = poi.get("cityname")
            if isinstance(city_raw, list):
                city_raw = city_raw[0] if city_raw else None
            address_raw = poi.get("address")
            if isinstance(address_raw, list):
                address_raw = address_raw[0] if address_raw else None
            item = {
                "name": poi.get("name") or keyword,
                "amap_poi_id": poi.get("id"),
                "lng": lng,
                "lat": lat,
                "city": city_raw or city,
                "address": address_raw if isinstance(address_raw, str) else None,
                "category": poi.get("type"),
                "rating": None,
            }
            item["source_ref"] = _ref("poi", item)
            out.append(PoiResult.model_validate(item))
        return out

    #: 高德 POI 大类码。攻略层的"到了怎么选"只需要这两类。
    AROUND_TYPES = {
        "food": "050000",      # 餐饮服务
        "spot": "110000",      # 风景名胜
        "hotel": "100000",     # 住宿服务
        "transport": "150000", # 交通设施
        "shopping": "060000",  # 购物服务
    }

    async def search_around(
        self, lng: float, lat: float, kind: str, keyword: str | None = None, radius: int = 3000, limit: int = 20
    ) -> list[AroundPoi]:
        """周边搜索（`place/around`）。

        规划层的 search_poi 用关键词，攻略层用坐标：用户已经到了这个 stop，
        要的是"这附近有什么"，按距离排序。返回 amap_poi_id 以便直接生成
        导航深链（docs/07 §4、§9）。
        """
        params: dict[str, Any] = {
            "location": f"{lng:.6f},{lat:.6f}",
            "radius": max(500, min(int(radius), 50000)),
            "offset": max(1, min(int(limit), 25)),
            "page": 1,
            "extensions": "base",
            "sortrule": "distance",
        }
        types = self.AROUND_TYPES.get(kind)
        if types:
            params["types"] = types
        if keyword:
            params["keywords"] = keyword
        data = await self._get("place/around", params)
        out: list[AroundPoi] = []
        for poi in data.get("pois") or []:
            loc = poi.get("location") or ""
            if "," not in loc:
                continue
            lng_s, lat_s = loc.split(",", 1)
            try:
                item_lng, item_lat = float(lng_s), float(lat_s)
            except ValueError:
                continue
            address = poi.get("address")
            if isinstance(address, list):  # 高德偶尔返回空数组
                address = None
            item = {
                "name": poi.get("name") or "",
                "amap_poi_id": poi.get("id"),
                "lng": item_lng,
                "lat": item_lat,
                "address": address if isinstance(address, str) else None,
                "category": poi.get("type"),
                # 高德 place/around 的 distance 是字符串（"234"），也可能是空串
                "distance_m": _to_int(poi.get("distance")),
            }
            if not item["name"]:
                continue
            item["source_ref"] = _ref("around", item)
            out.append(AroundPoi.model_validate(item))
        return out

    async def place_detail(self, poi_id: str) -> dict[str, Any]:
        """高德 POI 详情（浮卡：评分/图片/营业时间/电话）。

        返回值只包含高德真实给出的字段；缺失就是缺失，由 PlaceService 标 `missing`。
        """
        data = await self._get("place/detail", {"id": poi_id, "extensions": "all"})
        pois = data.get("pois") or []
        if not pois:
            raise AmapError("no_poi", f"高德没有 {poi_id} 的详情")
        poi = pois[0]
        biz = poi.get("biz_ext") or {}
        if isinstance(biz, list):
            biz = biz[0] if biz else {}
        photos = poi.get("photos") or []
        urls = [p.get("url") for p in photos if isinstance(p, dict) and p.get("url")]

        def _num(value: Any) -> float | None:
            try:
                if value in (None, "", []):
                    return None
                return float(value)
            except (TypeError, ValueError):
                return None

        loc = poi.get("location") or ""
        lng = lat = None
        if "," in loc:
            try:
                lng, lat = (float(x) for x in loc.split(",", 1))
            except ValueError:
                lng = lat = None
        city = poi.get("cityname")
        if isinstance(city, list):
            city = city[0] if city else None
        address = poi.get("address")
        if isinstance(address, list):
            address = address[0] if address else None
        return {
            "poi_id": poi.get("id") or poi_id,
            "name": poi.get("name"),
            "category": poi.get("type"),
            "city": city,
            "address": address if isinstance(address, str) else None,
            "lng": lng,
            "lat": lat,
            "tel": poi.get("tel") if isinstance(poi.get("tel"), str) else None,
            "business_time": poi.get("business_time"),
            "rating": _num(biz.get("rating")),
            "cost": _num(biz.get("cost")),
            "photos": urls[:5],
            "source": "amap",
        }

    async def geocode(self, name: str, city: str | None = None) -> tuple[float, float] | None:
        params = {"address": name}
        if city:
            params["city"] = city
        data = await self._get("geocode/geo", params)
        geos = data.get("geocodes") or []
        if not geos:
            return None
        loc = geos[0].get("location") or ""
        if "," not in loc:
            return None
        lng, lat = loc.split(",", 1)
        return float(lng), float(lat)

    async def plan_route(
        self,
        from_poi: str,
        to_poi: str,
        mode: str,
        from_coord: tuple[float, float] | None = None,
        to_coord: tuple[float, float] | None = None,
    ) -> RouteResult:
        origin = from_coord or await self.geocode(from_poi)
        destination = to_coord or await self.geocode(to_poi)
        if not origin or not destination:
            raise AmapError("geocode_failed", f"无法定位 {from_poi} 或 {to_poi}")
        if mode == "walk":
            path, key = "direction/walking", "paths"
        elif mode in ("bicycling", "bike"):
            mode = "bicycling"
            path, key = "direction/bicycling", "paths"
        elif mode == "transit":
            path, key = "direction/transit/integrated", "transits"
        else:
            path, key = "direction/driving", "paths"
        # extensions=all 才会返回 steps[].polyline：地图上要沿道路画，不能两点一线。
        data = await self._get(
            path,
            {
                "origin": f"{origin[0]:.6f},{origin[1]:.6f}",
                "destination": f"{destination[0]:.6f},{destination[1]:.6f}",
                "extensions": "all",
            },
        )
        route = data.get("route") or data.get("data") or {}
        items = route.get(key) or []
        if not items:
            raise AmapError("no_route", f"没有找到 {from_poi} → {to_poi} 的路线")
        first = items[0]
        if mode == "transit":
            distance = float(first.get("distance") or 0) / 1000
            minutes = int(float(first.get("duration") or 0) / 60)
            roads = []
        else:
            distance = float(first.get("distance") or 0) / 1000
            minutes = int(float(first.get("duration") or 0) / 60)
            roads = [s.get("road") for s in (first.get("steps") or []) if s.get("road")]
        # 过路费：01 §9.3。高德驾车返回 paths[].tolls（元）与 toll_distance（米），
        # steps[].toll_road 标出收费路段。以前只取了距离/时长/路名，自驾预算没有工具来源。
        tolls: float | None = None
        toll_distance_km: float | None = None
        has_toll_road: bool | None = None
        if mode == "drive":
            raw_tolls = first.get("tolls")
            if raw_tolls not in (None, ""):
                try:
                    tolls = float(raw_tolls)
                except (TypeError, ValueError):
                    tolls = None
            raw_toll_distance = first.get("toll_distance")
            if raw_toll_distance not in (None, ""):
                try:
                    toll_distance_km = round(float(raw_toll_distance) / 1000, 1)
                except (TypeError, ValueError):
                    toll_distance_km = None
            has_toll_road = any(
                str(step.get("toll_road") or "").strip() not in {"", "0", "[]", "None"}
                for step in (first.get("steps") or [])
            )
        payload = {
            "from_poi": from_poi,
            "to_poi": to_poi,
            "mode": mode,
            "distance_km": round(distance, 1),
            "minutes": minutes,
            "road_refs": list(dict.fromkeys(roads))[:6],
            "tolls": tolls,
            "toll_distance_km": toll_distance_km,
            "has_toll_road": has_toll_road,
            "polyline": _simplify_polyline(_extract_polyline(first, mode)),
        }
        payload["source_ref"] = _ref("route", payload)
        return RouteResult.model_validate(payload)

    async def weather(self, city: str, date: str | None = None) -> WeatherResult:
        data = await self._get("weather/weatherInfo", {"city": city, "extensions": "all"})
        forecasts = data.get("forecasts") or []
        casts: list[dict[str, Any]] = []
        for f in forecasts:
            casts.extend(f.get("casts") or [])
        chosen = None
        if date:
            chosen = next((c for c in casts if c.get("date") == date), None)
            if chosen is None:
                # 以前静默取 casts[0]，等于拿今天的天气当目标日期的天气（01 §8）。
                span = (
                    f"{casts[0].get('date')}–{casts[-1].get('date')}" if casts else "无预报"
                )
                raise AmapError(
                    "out_of_forecast",
                    f"高德只返回 3 天预报（{span}），{date} 超出预报范围；"
                    "请改用 climate_reference 给气候参考，不要拿其他日期顶替",
                    retryable=False,
                )
        else:
            chosen = casts[0] if casts else None
        if not chosen:
            raise AmapError("no_weather", f"没有 {city} 的天气数据")
        payload = {
            "city": city,
            "date": chosen.get("date"),
            "summary": f"{chosen.get('dayweather', '')}，{chosen.get('daywind', '')}{chosen.get('daypower', '')}",
            "high": int(chosen["daytemp"]) if chosen.get("daytemp") else None,
            "low": int(chosen["nighttemp"]) if chosen.get("nighttemp") else None,
            "wind": f"{chosen.get('daywind', '')} {chosen.get('daypower', '')}".strip(),
        }
        payload["source_ref"] = _ref("weather", payload)
        return WeatherResult.model_validate(payload)
