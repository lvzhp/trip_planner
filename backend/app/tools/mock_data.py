"""Offline fixtures used when external keys are absent (demo mode).

The coordinates are real GCJ-02 approximations.  Tool outputs still carry
`source_ref`s, so the validator and the UI behave exactly as they do with a
live AMap key — only the transport differs.
"""

from __future__ import annotations

import hashlib
import json
import math
from datetime import date, timedelta

from app.schemas.tools import (
    AroundPoi,
    PoiResult,
    RouteResult,
    WeatherResult,
    WebResultItem,
    WebSearchResult,
)

CITY_CENTERS: dict[str, tuple[float, float]] = {
    "乌鲁木齐": (87.6168, 43.8256),
    "阿勒泰": (88.1396, 47.8484),
    "布尔津": (86.8749, 47.7045),
    "伊宁": (81.3241, 43.9169),
    "特克斯": (81.8362, 43.2172),
    "喀纳斯": (87.0206, 48.7231),
    "禾木": (87.4167, 48.8306),
    "赛里木湖": (81.1671, 44.6083),
    "上海": (121.4737, 31.2304),
    "北京": (116.4074, 39.9042),
    "广州": (113.2644, 23.1291),
    "大理": (100.2676, 25.6065),
    "丽江": (100.2278, 26.8721),
    "安吉": (119.6804, 30.6382),
    "大阪": (135.5023, 34.6937),
    "京都": (135.7681, 35.0116),
}

POIS: list[dict] = [
    {"name": "新疆国际大巴扎", "city": "乌鲁木齐", "lng": 87.6165, "lat": 43.7915, "category": "景点", "rating": 4.6, "address": "天山区解放南路8号", "amap_poi_id": "B0FFG1K9A0"},
    {"name": "天山天池", "city": "昌吉", "lng": 88.1247, "lat": 43.8842, "category": "景点", "rating": 4.7, "address": "阜康市准噶尔路", "amap_poi_id": "B0FFH2N3C1"},
    {"name": "乌鲁木齐地窝堡国际机场", "city": "乌鲁木齐", "lng": 87.4744, "lat": 43.9071, "category": "交通", "rating": 4.4, "address": "新市区迎宾路46号", "amap_poi_id": "B0FFG1K9A1"},
    {"name": "海尔巴格餐厅（大巴扎店）", "city": "乌鲁木齐", "lng": 87.6188, "lat": 43.7902, "category": "美食", "rating": 4.5, "address": "天山区解放南路", "amap_poi_id": "B0FFG1K9A2"},
    {"name": "血站大盘鸡", "city": "乌鲁木齐", "lng": 87.5902, "lat": 43.8031, "category": "美食", "rating": 4.6, "address": "沙依巴克区阿勒泰路", "amap_poi_id": "B0FFG1K9A3"},
    {"name": "乌鲁木齐天山大厦", "city": "乌鲁木齐", "lng": 87.6038, "lat": 43.8002, "category": "酒店", "rating": 4.5, "address": "天山区新华北路", "amap_poi_id": "B0FFG1K9A4"},
    {"name": "可可托海景区", "city": "富蕴", "lng": 89.7204, "lat": 47.1912, "category": "景点", "rating": 4.8, "address": "可可托海镇", "amap_poi_id": "B0FFHR22K1"},
    {"name": "可可托海镇宝石宾馆", "city": "富蕴", "lng": 89.7031, "lat": 47.2051, "category": "酒店", "rating": 4.3, "address": "可可托海镇", "amap_poi_id": "B0FFHR22K2"},
    {"name": "阿勒泰市克兰河", "city": "阿勒泰", "lng": 88.1396, "lat": 47.8452, "category": "景点", "rating": 4.4, "address": "阿勒泰市", "amap_poi_id": "B0FFHA11K1"},
    {"name": "布尔津五彩滩", "city": "布尔津", "lng": 86.8744, "lat": 47.8045, "category": "景点", "rating": 4.6, "address": "布尔津县", "amap_poi_id": "B0FFHB22K1"},
    {"name": "喀纳斯湖", "city": "布尔津", "lng": 87.0206, "lat": 48.7231, "category": "景点", "rating": 4.9, "address": "喀纳斯景区", "amap_poi_id": "B0FFH3V5Q2"},
    {"name": "喀纳斯景区贾登峪门票站", "city": "布尔津", "lng": 87.1302, "lat": 48.4962, "category": "景点", "rating": 4.5, "address": "喀纳斯景区", "amap_poi_id": "B0FFH3V5Q3"},
    {"name": "禾木村", "city": "布尔津", "lng": 87.4167, "lat": 48.8306, "category": "景点", "rating": 4.8, "address": "禾木哈纳斯蒙古族乡", "amap_poi_id": "B0FFHP88W3"},
    {"name": "禾木山庄", "city": "布尔津", "lng": 87.4132, "lat": 48.8291, "category": "酒店", "rating": 4.4, "address": "禾木村", "amap_poi_id": "B0FFHP88W4"},
    {"name": "乌尔禾世界魔鬼城", "city": "克拉玛依", "lng": 85.6872, "lat": 46.0984, "category": "景点", "rating": 4.7, "address": "乌尔禾区", "amap_poi_id": "B0FFHC33K1"},
    {"name": "奎屯锦江都城酒店", "city": "奎屯", "lng": 84.9031, "lat": 44.4232, "category": "酒店", "rating": 4.5, "address": "奎屯市", "amap_poi_id": "B0FFHD44K1"},
    {"name": "赛里木湖", "city": "博乐", "lng": 81.1671, "lat": 44.6083, "category": "景点", "rating": 4.9, "address": "博尔塔拉蒙古自治州", "amap_poi_id": "B03E700I9K"},
    {"name": "赛里木湖景区毡房营地", "city": "博乐", "lng": 81.1892, "lat": 44.6203, "category": "酒店", "rating": 4.3, "address": "赛里木湖景区", "amap_poi_id": "B03E700I9L"},
    {"name": "果子沟大桥", "city": "霍城", "lng": 81.1432, "lat": 44.4212, "category": "景点", "rating": 4.7, "address": "连霍高速果子沟段", "amap_poi_id": "B0FFHE55K1"},
    {"name": "伊宁喀赞其民俗旅游区", "city": "伊宁", "lng": 81.3297, "lat": 43.9128, "category": "景点", "rating": 4.6, "address": "伊宁市", "amap_poi_id": "B0FFHF66K1"},
    {"name": "伊宁六星街", "city": "伊宁", "lng": 81.3177, "lat": 43.9211, "category": "景点", "rating": 4.5, "address": "伊宁市", "amap_poi_id": "B0FFHF66K2"},
    {"name": "伊宁天缘国际酒店", "city": "伊宁", "lng": 81.3202, "lat": 43.9302, "category": "酒店", "rating": 4.4, "address": "伊宁市", "amap_poi_id": "B0FFHF66K3"},
    {"name": "特克斯八卦城", "city": "特克斯", "lng": 81.8399, "lat": 43.2148, "category": "景点", "rating": 4.5, "address": "特克斯县", "amap_poi_id": "B0FFHG77K1"},
    {"name": "琼库什台村", "city": "特克斯", "lng": 82.0986, "lat": 43.0503, "category": "景点", "rating": 4.7, "address": "喀拉达拉镇", "amap_poi_id": "B0FFHG77K2"},
    {"name": "那拉提草原", "city": "新源", "lng": 84.0057, "lat": 43.3102, "category": "景点", "rating": 4.8, "address": "新源县那拉提镇", "amap_poi_id": "B0FFHH88K1"},
    {"name": "独库公路", "city": "独山子", "lng": 84.8862, "lat": 44.3283, "category": "景点", "rating": 4.9, "address": "G217 独山子—库车", "amap_poi_id": "B0FFHKQ31X"},
    {"name": "上海虹桥国际机场", "city": "上海", "lng": 121.3363, "lat": 31.1979, "category": "交通", "rating": 4.5, "address": "长宁区虹桥路2550号", "amap_poi_id": "B0FFH1A1A1"},
    {"name": "伊宁机场", "city": "伊宁", "lng": 81.3303, "lat": 43.9551, "category": "交通", "rating": 4.3, "address": "伊宁市机场路", "amap_poi_id": "B0FFHF66K4"},
]

# 演示模式的周边餐饮候选（docs/07 §9）。店名与菜品取自验收 case 的真实素材，
# 坐标是 GCJ-02 近似值。**只覆盖新疆环线的主要 stop** —— 匹配不到的地点返回空，
# 前端显示"该地点暂无演示数据"，不为铺满而编造假攻略。
FOOD_AROUND: list[dict] = [
    {"name": "海尔巴格餐厅（大巴扎店）", "lng": 87.6188, "lat": 43.7902, "address": "天山区解放南路", "amap_poi_id": "B0FFG1K9A2"},
    {"name": "血站大盘鸡", "lng": 87.5902, "lat": 43.8031, "address": "沙依巴克区阿勒泰路", "amap_poi_id": "B0FFG1K9A3"},
    {"name": "一品烤包子（二道桥店）", "lng": 87.6120, "lat": 43.7880, "address": "天山区二道桥", "amap_poi_id": None},
    {"name": "可可托海牧场家宴", "lng": 89.7210, "lat": 47.1920, "address": "可可托海镇景区门口", "amap_poi_id": None},
    {"name": "额河烤鱼店（克兰河路店）", "lng": 88.1400, "lat": 47.8440, "address": "阿勒泰市克兰河路", "amap_poi_id": None},
    {"name": "布尔津河堤夜市", "lng": 86.8740, "lat": 47.7030, "address": "布尔津县河堤", "amap_poi_id": None},
    {"name": "禾木山庄餐厅", "lng": 87.4132, "lat": 48.8291, "address": "禾木村内", "amap_poi_id": "B0FFHP88W4"},
    {"name": "奎屯凉皮黄面烤肉三件套", "lng": 84.9020, "lat": 44.4240, "address": "奎屯市夜市", "amap_poi_id": None},
    {"name": "湖区毡房餐厅", "lng": 81.1700, "lat": 44.6100, "address": "赛里木湖点将台附近", "amap_poi_id": None},
    {"name": "喀赞其家访宴", "lng": 81.3300, "lat": 43.9130, "address": "伊宁喀赞其蓝色小院", "amap_poi_id": None},
    {"name": "亚历山大庭院餐厅", "lng": 81.3180, "lat": 43.9215, "address": "伊宁六星街", "amap_poi_id": None},
    {"name": "离街架子肉老店", "lng": 81.8400, "lat": 43.2150, "address": "特克斯八卦城离街", "amap_poi_id": None},
]

WEB_FIXTURES: dict[str, dict] = {
    "独库": {
        "conclusion": "G217 独山子—库车段通常在 6 月上旬至 10 月中旬开放；2026 年具体通车日期以新疆交通运输厅公告为准。五一期间大概率仍处于交通管制。",
        "results": [
            {"title": "独库公路 2026 年通车时间公告", "url": "https://www.xjjt.gov.cn/", "content": "独库公路受山区积雪影响，每年 6 月上旬解除交通管制，10 月中旬视天气封闭。2026 年通车时间尚未发布，预计与往年接近。"},
            {"title": "五一自驾独库公路注意事项", "url": "https://example.com/duku", "content": "五一期间独库公路北段通常未开放，建议改走 G30 或伊犁环线。山区天气多变，出发前查询实时路况。"},
        ],
    },
    "喀纳斯": {
        "conclusion": "喀纳斯景区需实名预约，门票+区间车约 ¥230–280，官方渠道为微信公众号「喀纳斯景区」，建议提前 3 天购票。",
        "results": [
            {"title": "喀纳斯景区门票预约指南", "url": "https://example.com/kanas", "content": "微信公众号「喀纳斯景区」可预约门票与区间车，旺季建议提前 3 天。景区区间车末班 19:00。"},
            {"title": "喀纳斯禾木住宿怎么选", "url": "https://example.com/kanas-hotel", "content": "禾木村内木屋五一余量紧张，价格约 ¥680 起，建议提前两周预订。"},
        ],
    },
    "禾木": {
        "conclusion": "禾木村住宿五一紧张，村内木屋 ¥680 起；日落观景台建议 19:40 前到位，5 月初日落约 21:20。",
        "results": [
            {"title": "禾木村住宿与日落观景攻略", "url": "https://example.com/hemu", "content": "禾木日落观景台从村口步行约 30 分钟，也可骑马上山。5 月初日落 21:20 左右。"},
        ],
    },
    "赛里木湖": {
        "conclusion": "赛里木湖环湖东岸上午顺光，适合拍照；环湖公路约 90 公里，自驾 3–4 小时。",
        "results": [
            {"title": "赛里木湖环湖自驾指南", "url": "https://example.com/sayram", "content": "顺时针环湖，东岸上午顺光，西岸下午顺光。景区内毡房营地需提前预订。"},
        ],
    },
    "边防证": {
        "conclusion": "前往白哈巴、塔县等边境地区需办理边境管理区通行证，可在户籍地公安或新疆当地政务中心办理，通常当天可取。",
        "results": [
            {"title": "新疆边防证办理指南", "url": "https://example.com/permit", "content": "布尔津县政务服务中心可办理白哈巴方向边防证，持身份证当天办理。"},
        ],
    },
    "新疆": {
        "conclusion": "五一北疆推荐 7–8 天环线：乌鲁木齐—可可托海—喀纳斯/禾木—魔鬼城—赛里木湖—伊宁。独库公路五一通常未开放。",
        "results": [
            {"title": "北疆五一 8 日自驾环线", "url": "https://example.com/xinjiang", "content": "顺时针环线不走回头路，乌鲁木齐取车、伊宁还车。每天驾驶控制在 5 小时内。"},
            {"title": "新疆五一天气与路况", "url": "https://example.com/xinjiang-weather", "content": "北疆昼夜温差 15°C 以上，山区垭口可能有残雪，需备防滑链。"},
        ],
    },
}


def _ref(prefix: str, payload) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    return f"{prefix}:{hashlib.sha1(raw.encode()).hexdigest()[:12]}"


def mock_search_poi(keyword: str, city: str | None, category: str | None, limit: int = 8) -> list[PoiResult]:
    kw = (keyword or "").replace(" ", "")
    parts = [part for part in kw.split("·") if part]
    matches: list[dict] = []
    scored: list[tuple[int, dict]] = []
    for poi in POIS:
        hay = f"{poi['name']}{poi['city']}{poi['category']}"
        if category and category not in poi["category"]:
            continue
        score = 0
        for part in parts:
            if not part:
                continue
            # 名字命中关键词 / 关键词命中名字 都算；不做单字模糊匹配
            if part in poi["name"]:
                score = max(score, 5)
            elif poi["name"] in part:
                score = max(score, 4)
            elif part in poi["city"]:
                score = max(score, 2)
        if score == 0 and parts and len(parts[0]) >= 2 and parts[0][:2] in poi["name"]:
            score = 1
        if score == 0:
            continue
        if city and city in poi["city"]:
            score += 1
        scored.append((score, poi))
    scored.sort(key=lambda item: item[0], reverse=True)
    matches = [poi for _score, poi in scored]
    if not matches:
        center = CITY_CENTERS.get(city or "", CITY_CENTERS["乌鲁木齐"])
        matches = [
            {
                "name": keyword.split("·")[0][:24] or (city or "目的地"),
                "city": city or "乌鲁木齐",
                "lng": center[0] + (hash(keyword) % 100 - 50) / 2000,
                "lat": center[1] + (hash(keyword + "x") % 100 - 50) / 2000,
                "category": category or "景点",
                "rating": 4.4,
                "address": city,
                "amap_poi_id": None,
            }
        ]
    out = []
    for poi in matches[:limit]:
        item = {
            "name": poi["name"],
            "amap_poi_id": poi.get("amap_poi_id"),
            "lng": poi["lng"],
            "lat": poi["lat"],
            "city": poi.get("city"),
            "address": poi.get("address"),
            "category": poi.get("category"),
            "rating": poi.get("rating"),
        }
        item["source_ref"] = _ref("poi", {**item, "query": keyword})
        out.append(PoiResult.model_validate(item))
    return out


def _haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    r = 6371.0
    la1, lo1, la2, lo2 = map(math.radians, [a[1], a[0], b[1], b[0]])
    dlat, dlon = la2 - la1, lo2 - lo1
    h = math.sin(dlat / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def mock_search_around(
    lng: float | None,
    lat: float | None,
    kind: str,
    keyword: str | None = None,
    radius: int = 3000,
    limit: int = 20,
) -> list[AroundPoi]:
    """演示模式的周边搜索：按半径过滤内置候选、按距离排序。

    spot 用 POIS 里的景点，food 用 FOOD_AROUND 的真实店名素材。
    半径内没有候选就返回空 —— 前端显示"该地点暂无演示数据"，
    绝不拿远处的点凑数（那会误导"步行可达"）。
    """
    if lng is None or lat is None:
        return []
    center = (lng, lat)
    pools: dict[str, list[dict]] = {
        "food": FOOD_AROUND,
        "spot": [p for p in POIS if p.get("category") == "景点"],
        "hotel": [p for p in POIS if p.get("category") == "酒店"],
        "transport": [p for p in POIS if p.get("category") == "交通"],
        "shopping": [],
    }
    pool = pools.get(kind, pools["spot"])
    kw = (keyword or "").strip()
    out: list[tuple[int, dict]] = []
    for poi in pool:
        if kw and kw not in f"{poi['name']}{poi.get('address', '')}":
            continue
        dist_m = int(_haversine_km(center, (poi["lng"], poi["lat"])) * 1000)
        if dist_m > radius:
            continue
        out.append((dist_m, poi))
    out.sort(key=lambda pair: pair[0])
    results: list[AroundPoi] = []
    for dist_m, poi in out[:limit]:
        item = {
            "name": poi["name"],
            "amap_poi_id": poi.get("amap_poi_id"),
            "lng": poi["lng"],
            "lat": poi["lat"],
            "address": poi.get("address"),
            "category": poi.get("category"),
            "distance_m": dist_m,
        }
        item["source_ref"] = _ref("around", item)
        results.append(AroundPoi.model_validate(item))
    return results


def mock_plan_route(
    from_poi: str,
    to_poi: str,
    mode: str,
    from_coord: tuple[float, float] | None = None,
    to_coord: tuple[float, float] | None = None,
) -> RouteResult:
    def locate(name: str, coord):
        if coord:
            return coord
        for poi in POIS:
            if name in poi["name"] or poi["name"] in name:
                return (poi["lng"], poi["lat"])
        for city, center in CITY_CENTERS.items():
            if city in name:
                return center
        return CITY_CENTERS["乌鲁木齐"]

    a, b = locate(from_poi, from_coord), locate(to_poi, to_coord)
    direct = _haversine_km(a, b)
    if mode == "walk":
        distance = direct * 1.15
        minutes = max(3, round(distance / 4.5 * 60))
    elif mode == "transit":
        distance = direct * 1.25
        minutes = max(10, round(distance / 28 * 60 + 8))
    else:
        distance = direct * 1.32
        speed = 55 if direct > 60 else 32
        minutes = max(6, round(distance / speed * 60))
    roads = []
    if direct > 150:
        roads = ["G30" if a[1] < 45 and b[1] < 46 else "G216"]
    elif direct > 30:
        roads = ["G217"]
    payload = {
        "from_poi": from_poi,
        "to_poi": to_poi,
        "mode": mode,
        "distance_km": round(distance, 1),
        "minutes": minutes,
        "road_refs": roads,
    }
    payload["source_ref"] = _ref("route", payload)
    return RouteResult.model_validate(payload)


def mock_weather(city: str, date_str: str | None = None) -> WeatherResult:
    base = date.fromisoformat(date_str) if date_str else date.today()
    seed = sum(ord(c) for c in city) + base.toordinal()
    high = 8 + seed % 14
    low = high - (7 + seed % 6)
    summaries = ["晴", "多云", "晴间多云", "阴", "小雪"]
    summary = summaries[seed % len(summaries)]
    payload = {
        "city": city,
        "date": base.isoformat(),
        "summary": f"{summary}，昼夜温差大，山区有残雪",
        "high": high,
        "low": low,
        "wind": "西北风 3–4 级",
    }
    payload["source_ref"] = _ref("weather", payload)
    return WeatherResult.model_validate(payload)


def mock_web_search(query: str, max_results: int = 3) -> WebSearchResult:
    fixture = None
    for key, value in WEB_FIXTURES.items():
        if key in query:
            fixture = value
            break
    if fixture is None:
        fixture = {
            "conclusion": f"已检索「{query}」：建议出发前再次确认官方公告与实时路况。",
            "results": [
                {
                    "title": f"{query} · 搜索摘要",
                    "url": "https://example.com/search",
                    "content": f"关于「{query}」的公开资料摘要。时效性信息（票价、开放时间、封路）请以官方渠道为准。",
                }
            ],
        }
    results = [
        WebResultItem(
            title=item["title"],
            url=item.get("url"),
            content=item["content"][:600],
            score=0.9 - i * 0.1,
        )
        for i, item in enumerate(fixture["results"][:max_results])
    ]
    payload = {
        "query": query,
        "results": [r.model_dump() for r in results],
        "conclusion": fixture["conclusion"],
    }
    payload["source_ref"] = _ref("web", payload)
    return WebSearchResult.model_validate(payload)


def add_days(iso: str, days: int) -> str:
    return (date.fromisoformat(iso) + timedelta(days=days)).isoformat()
