"""Tool registry: specs, cache, retry, explicit errors, slim payloads.

Read-only tools execute through here.  Write tools are exposed to the model with
the same spec list but are routed to PlanService by the agent loop, so a
concurrent tool batch can never contain two writes.

Routing metadata (docs/new-plan 01 §2.2) lives on the spec: `tier` says who may
release the tool, `expensive` raises the Jev threshold and the call budget.  The
subagent whitelist is enforced twice — once when the tool list is rendered
(02 §2.2) and again here at execution time, because `providers.py` does not
validate tool names.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from typing import Any

from app.config import Settings
from app.db import Database
from app.schemas.research import SUBAGENT_DENIED, SUBAGENT_ONLY
from app.schemas.sources import EvidenceStatus
from app.schemas.tools import (
    ToolError,
    ToolName,
    ToolOutcome,
    ToolSpec,
    ToolTier,
)
from app.services.source_registry import SourceRegistry, content_ref
from app.tools.amap import AmapClient, AmapError
from app.tools.composite import (
    CompositeUnavailable,
    Retriever as CompositeRetriever,
    climate_reference,
    closure_notice_lookup,
    opening_hours_lookup,
    permit_policy_lookup,
    ticket_channel_lookup,
    transport_info_lookup,
)
from app.tools.deepseek_search import DeepSeekSearchClient, DeepSeekSearchError
from app.tools.local_facts import holiday_calendar, sun_times
from app.tools.mock_data import mock_plan_route, mock_search_poi, mock_weather, mock_web_search
from app.tools.social import SocialDigestError, social_digest
from app.tools.tavily import TavilyClient, TavilyError

READ_ONLY = {
    ToolName.SEARCH_POI,
    ToolName.PLAN_ROUTE,
    ToolName.WEB_SEARCH,
    ToolName.GET_WEATHER,
    ToolName.SEARCH_AROUND,
    ToolName.PLACE_DETAIL,
    ToolName.FETCH_PAGE,
    ToolName.CLIMATE_REFERENCE,
    ToolName.SUN_TIMES,
    ToolName.HOLIDAY_CALENDAR,
    ToolName.TICKET_CHANNEL_LOOKUP,
    ToolName.CLOSURE_NOTICE_LOOKUP,
    ToolName.PERMIT_POLICY_LOOKUP,
    ToolName.TRANSPORT_INFO_LOOKUP,
    ToolName.OPENING_HOURS_LOOKUP,
    ToolName.SOCIAL_DIGEST,
    ToolName.DISPATCH_RESEARCH,
}
WRITE = {ToolName.DRAFT_ITINERARY, ToolName.UPDATE_ITINERARY}

TRIP_SCHEMA_HINT = {
    "type": "object",
    "description": (
        "完整 Trip 文档（trip_id/version/derived 由服务端填）。字段名使用 snake_case。"
        "draft_itinerary 的参数必须是 {trip: 本文档, summary: \"一句话\"}；"
        "禁止把整份 JSON 塞进 Raw 字符串，trip.days 至少一天。"
    ),
    "properties": {
        "title": {"type": "string", "description": "行程标题"},
        "constraints": {
            "type": "object",
            "properties": {
                "origin": {"type": "string", "description": "出发城市"},
                "destination": {"type": "string", "description": "目的地"},
                "date_range": {
                    "type": "object",
                    "properties": {
                        "start": {"type": "string", "description": "YYYY-MM-DD 或 null"},
                        "end": {"type": "string", "description": "YYYY-MM-DD 或 null"},
                        "note": {"type": "string"},
                    },
                },
                "travelers": {"type": "integer"},
                "budget": {
                    "type": "object",
                    "properties": {
                        "total": {"type": "number"},
                        "level": {"type": "string", "enum": ["low", "mid", "high"]},
                        "per_person_est": {"type": "number"},
                    },
                },
                "transport_mode": {
                    "type": "string",
                    "enum": ["flight", "train", "self_drive"],
                },
                "pace": {"type": "string", "enum": ["relaxed", "normal", "intense"]},
                "diet": {"type": "array", "items": {"type": "string"}},
                "must_go": {
                    "type": "array",
                    "items": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
                },
                "must_avoid": {
                    "type": "array",
                    "items": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
                },
                "assumptions": {"type": "array", "items": {"type": "string"}},
            },
        },
        "days": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "required": ["day_index", "stops"],
                "properties": {
                    "day_index": {"type": "integer", "minimum": 1},
                    "date": {"type": "string", "description": "YYYY-MM-DD 或 null"},
                    "theme": {"type": "string"},
                    "rhythm": {
                        "type": "object",
                        "properties": {
                            "wake": {"type": "string", "description": "HH:MM"},
                            "sleep": {"type": "string", "description": "HH:MM"},
                        },
                    },
                    "stops": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "object",
                            "required": ["poi", "activities"],
                            "properties": {
                                "stop_id": {"type": "string", "description": "稳定 ID；可省略，由服务端生成"},
                                "poi": {
                                    "type": "object",
                                    "required": ["name", "lng", "lat"],
                                    "properties": {
                                        "name": {"type": "string"},
                                        "lng": {"type": "number"},
                                        "lat": {"type": "number"},
                                        "amap_poi_id": {"type": "string"},
                                        "city": {"type": "string"},
                                        "address": {"type": "string"},
                                        "source_ref": {"type": "string", "description": "search_poi 返回的 sourceRef"},
                                    },
                                },
                                "opening_hours": {
                                    "type": "object",
                                    "description": (
                                        "营业时间。只允许写 source_refs（来自 opening_hours_lookup 的返回），"
                                        "值由服务端从来源登记簿回填；没有证据就不要写这个字段。"
                                    ),
                                    "properties": {
                                        "source_refs": {"type": "array", "items": {"type": "string"}}
                                    },
                                    "required": ["source_refs"],
                                },
                                "activities": {
                                    "type": "array",
                                    "minItems": 1,
                                    "items": {
                                        "type": "object",
                                        "required": ["activity_id", "type", "title", "time_window"],
                                        "properties": {
                                            "activity_id": {"type": "string", "description": "稳定 ID；可省略，由服务端生成"},
                                            "type": {
                                                "type": "string",
                                                "enum": ["visit", "meal", "stay", "long_transit", "free"],
                                                "description": "没有 rest 类型；休息用 free",
                                            },
                                            "title": {"type": "string"},
                                            "time_window": {
                                                "type": "object",
                                                "required": ["start", "end"],
                                                "properties": {
                                                    "start": {"type": "string", "description": "HH:MM"},
                                                    "end": {"type": "string", "description": "HH:MM"},
                                                },
                                            },
                                            "note": {"type": "string"},
                                            "tips": {"type": "array", "items": {"type": "string"}},
                                            "transit_from_prev": {
                                                "type": "object",
                                                "description": "市内短驳（边）。只挂在 activity 上，不挂在 stop 上；数值必须来自 plan_route",
                                                "properties": {
                                                    "mode": {"type": "string", "enum": ["drive", "walk", "transit"]},
                                                    "minutes": {"type": "integer"},
                                                    "distance_km": {"type": "number"},
                                                    "source_ref": {"type": "string"},
                                                },
                                            },
                                            "transit_detail": {
                                                "type": "object",
                                                "description": (
                                                    "仅 long_transit 使用。mode=flight: {flight_no,airline,airport_from,airport_to,dep_time,arr_time}；"
                                                    "mode=train: {train_no,station_from,station_to,seat_class,dep_time,arr_time}；"
                                                    "mode=self_drive: {distance_km,drive_minutes,waypoints_poi,road_refs,road_condition,season_closure,fuel_stops,parking,permit_required,permit_note}"
                                                ),
                                                "properties": {
                                                    "mode": {"type": "string", "enum": ["flight", "train", "self_drive"]}
                                                },
                                                "required": ["mode"],
                                            },
                                            "ticket": {
                                                "type": "object",
                                                "description": "没有票就省略。字段是 price_range / channels[] / sale_rule / limited_quota，没有 price / channel 这两个字段名。",
                                                "properties": {
                                                    "kind": {
                                                        "type": "string",
                                                        "enum": ["attraction", "transport", "none"],
                                                        "description": "hotel 已废弃：住宿收缩为区域级，不要写酒店票",
                                                    },
                                                    "price_range": {
                                                        "type": "array",
                                                        "items": {"type": "number"},
                                                        "minItems": 2,
                                                        "maxItems": 2,
                                                    },
                                                    "currency": {"type": "string"},
                                                    "lead_time_days": {"type": "integer"},
                                                    "real_name_required": {"type": "boolean"},
                                                    "channels": {
                                                        "type": "array",
                                                        "items": {
                                                            "type": "object",
                                                            "required": ["name", "type"],
                                                            "properties": {
                                                                "name": {"type": "string"},
                                                                "type": {
                                                                    "type": "string",
                                                                    "enum": ["wechat_mp", "mini_program", "app", "web", "ota", "onsite"],
                                                                },
                                                                "detail": {"type": "string", "description": "公众号全名 / 小程序名 / App 名 / 网址"},
                                                                "note": {"type": "string"},
                                                                "official": {"type": "boolean"},
                                                                "status": {"type": "string", "enum": ["verified", "clue", "unverified"]},
                                                                "evidence_url": {"type": "string"},
                                                                "how_to_find": {"type": "string"},
                                                            },
                                                        },
                                                    },
                                                    "recommended_purchase": {
                                                        "type": "object",
                                                        "properties": {
                                                            "target_date": {"type": "string"},
                                                            "session": {"type": "string"},
                                                            "lead_time_days": {"type": "integer"},
                                                            "note": {"type": "string"},
                                                        },
                                                    },
                                                    "sale_rule": {
                                                        "type": "object",
                                                        "description": "开售规则。有值必须带本趟已发出的 source_ref（来自 ticket_channel_lookup）",
                                                        "properties": {
                                                            "mode": {
                                                                "type": "string",
                                                                "enum": [
                                                                    "advance_days_at_time",
                                                                    "fixed_date",
                                                                    "rolling_daily",
                                                                    "lottery_or_reservation",
                                                                    "onsite_only",
                                                                ],
                                                            },
                                                            "advance_days": {"type": "integer"},
                                                            "release_time": {"type": "string"},
                                                            "fixed_date": {"type": "string"},
                                                            "source_ref": {"type": "string"},
                                                        },
                                                    },
                                                    "limited_quota": {
                                                        "type": "object",
                                                        "properties": {
                                                            "quote": {"type": "string"},
                                                            "source_ref": {"type": "string"},
                                                        },
                                                    },
                                                    "note": {"type": "string"},
                                                    "source_ref": {"type": "string"},
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
    "required": ["title", "days"],
}

OPS_SCHEMA = {
    "type": "array",
    "description": (
        "增量补丁 op 列表。可用 op：update_stop / remove_stop / insert_stop / reorder / "
        "update_activity / remove_activity / insert_activity / set_day_rhythm / set_constraints。"
        "禁止修改派生字段，禁止改 stop_id / activity_id。"
    ),
    "items": {
        "type": "object",
        "properties": {
            "op": {
                "type": "string",
                "enum": [
                    "update_stop",
                    "remove_stop",
                    "insert_stop",
                    "reorder",
                    "update_activity",
                    "remove_activity",
                    "insert_activity",
                    "set_day_rhythm",
                    "set_constraints",
                ],
            },
            "stop_id": {"type": "string"},
            "activity_id": {"type": "string"},
            "day_index": {"type": "integer"},
            "at_seq": {"type": "integer"},
            "patch": {"type": "object"},
            "stop": {"type": "object"},
            "activity": {"type": "object"},
            "stop_ids": {"type": "array", "items": {"type": "string"}},
            "rhythm": {"type": "object", "properties": {"wake": {"type": "string"}, "sleep": {"type": "string"}}},
        },
        "required": ["op"],
    },
}

RESEARCH_TASKS_SCHEMA = {
    "type": "object",
    "description": "并行派给子 Agent 的调研任务。只写 goal 与 context；deny_tools 只能收窄角色默认白名单。",
    "properties": {
        "tasks": {
            "type": "array",
            "minItems": 1,
            "maxItems": 6,
            "items": {
                "type": "object",
                "required": ["task_id", "role", "goal"],
                "properties": {
                    "task_id": {"type": "string"},
                    "role": {
                        "type": "string",
                        "enum": ["route", "experience", "transport", "conditions"],
                    },
                    "goal": {"type": "string", "description": "这个子 Agent 要查什么"},
                    "context": {
                        "type": "object",
                        "description": "目的地、日期、人数等",
                        "properties": {
                            "destination": {"type": "string"},
                            "date_range": {"type": "string"},
                            "travelers": {"type": "integer"},
                        },
                    },
                    "deny_tools": {"type": "array", "items": {"type": "string"}},
                    "max_summary_chars": {"type": "integer"},
                },
            },
        }
    },
    "required": ["tasks"],
}

FINDINGS_SCHEMA = {
    "type": "object",
    "description": "调研结论。收尾必须调用 submit_findings，把结构化摘要作为参数提交。",
    "properties": {
        "task_id": {"type": "string"},
        "role": {"type": "string", "enum": ["route", "experience", "transport", "conditions"]},
        "status": {"type": "string", "enum": ["ok", "partial", "failed"]},
        "summary": {"type": "string", "description": "不超过 800 字的人读摘要"},
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["kind", "claim"],
                "properties": {
                    "kind": {"type": "string", "enum": ["fact", "experience", "clue"]},
                    "claim": {"type": "string"},
                    "source_refs": {"type": "array", "items": {"type": "string"}},
                    "evidence": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "url": {"type": "string"},
                                "published_at": {"type": "string"},
                                "quote": {"type": "string"},
                            },
                        },
                    },
                    "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
                },
            },
        },
        "gaps": {"type": "array", "items": {"type": "string"}},
        "tool_calls_used": {"type": "integer"},
    },
    "required": ["task_id", "role", "summary", "findings"],
}


TOOL_SPECS: list[ToolSpec] = [
    ToolSpec(
        name="search_poi",
        description=(
            "搜索景点/餐厅/酒店/交通枢纽，返回真实高德 POI 与经纬度。"
            "写行程时 poi.lng/lat/amap_poi_id/source_ref 必须来自本工具返回，禁止编造。"
        ),
        read_only=True,
        tier=ToolTier.ALWAYS,
        parameters={
            "type": "object",
            "properties": {
                "keyword": {"type": "string", "description": "搜索关键词，如「喀纳斯湖」"},
                "city": {"type": "string", "description": "城市，如「布尔津」"},
                "category": {"type": "string", "enum": ["景点", "美食", "酒店", "交通"]},
            },
            "required": ["keyword"],
        },
    ),
    ToolSpec(
        name="plan_route",
        description=(
            "计算两地之间的路程时长、距离与过路费。transit_from_prev 与自驾 drive_minutes "
            "只能使用本工具返回的数值，禁止估算。"
        ),
        read_only=True,
        tier=ToolTier.ALWAYS,
        parameters={
            "type": "object",
            "properties": {
                "from": {"type": "string", "description": "起点名称"},
                "to": {"type": "string", "description": "终点名称"},
                "mode": {"type": "string", "enum": ["drive", "walk", "transit"]},
                "from_lng": {"type": "number"},
                "from_lat": {"type": "number"},
                "to_lng": {"type": "number"},
                "to_lat": {"type": "number"},
            },
            "required": ["from", "to", "mode"],
        },
    ),
    ToolSpec(
        name="search_around",
        description=(
            "按坐标搜周边 POI（景点/美食/酒店），带距离与高德 POI ID。"
            "用于攻略层候选与「这附近有什么」。"
        ),
        read_only=True,
        tier=ToolTier.JEV,
        parameters={
            "type": "object",
            "properties": {
                "lng": {"type": "number"},
                "lat": {"type": "number"},
                "kind": {"type": "string", "enum": ["food", "spot", "hotel", "transport", "shopping"]},
                "keyword": {"type": "string"},
                "radius": {"type": "integer", "description": "米，默认 3000"},
            },
            "required": ["lng", "lat"],
        },
    ),
    ToolSpec(
        name="place_detail",
        description="查高德 POI 详情：地址、电话、营业时间原文、评分、图片。营业时间只是线索，不是核实过的营业时间。",
        read_only=True,
        tier=ToolTier.JEV,
        parameters={
            "type": "object",
            "properties": {"amap_poi_id": {"type": "string"}},
            "required": ["amap_poi_id"],
        },
    ),
    ToolSpec(
        name="web_search",
        description=(
            "联网检索。DeepSeek 与 Tavily 并行，返回带出处的结果（含 authority/日期）。"
            "用于开放性问题与目的地玩法；票务、营业时间、封路这些字段用它取线索也够，"
            "但要写进行程的字段仍要引用结构化工具的 source_ref。"
        ),
        read_only=True,
        tier=ToolTier.JEV,
        parameters={
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
    ),
    ToolSpec(
        name="fetch_page",
        description="取一个网页的 Markdown 正文（DeepSeek Fetch）。被安全策略拒绝返回 403，取不到正文返回 404。",
        read_only=True,
        tier=ToolTier.SUBAGENT,
        parameters={
            "type": "object",
            "properties": {"url": {"type": "string"}},
            "required": ["url"],
        },
    ),
    ToolSpec(
        name="get_weather",
        description=(
            "查询城市天气（高德 3 天预报）。目标日期超出预报范围时返回 out_of_forecast，"
            "此时改用 climate_reference 给气候参考，不要拿别的日期顶替。"
        ),
        read_only=True,
        tier=ToolTier.ALWAYS,
        parameters={
            "type": "object",
            "properties": {
                "city": {"type": "string"},
                "date": {"type": "string", "description": "YYYY-MM-DD"},
            },
            "required": ["city"],
        },
    ),
    ToolSpec(
        name="climate_reference",
        description="查某地某月的气候参考（历史统计，不是预报）。卡片会标「气候参考，非预报」。",
        read_only=True,
        tier=ToolTier.JEV,
        parameters={
            "type": "object",
            "properties": {
                "city": {"type": "string"},
                "month": {"type": "integer", "minimum": 1, "maximum": 12},
            },
            "required": ["city"],
        },
    ),
    ToolSpec(
        name="sun_times",
        description="本地天文计算某坐标某日期的日出日落（零外呼）。晨昏活动时间必须来自这里，不要凭经验写。",
        read_only=True,
        tier=ToolTier.ALWAYS,
        parameters={
            "type": "object",
            "properties": {
                "lng": {"type": "number"},
                "lat": {"type": "number"},
                "date": {"type": "string", "description": "YYYY-MM-DD"},
            },
            "required": ["lng", "lat"],
        },
    ),
    ToolSpec(
        name="holiday_calendar",
        description="查区间的节假日与调休。内置表只有部分年份，未收录的年份会明确返回 unverified，不要自己补日期。",
        read_only=True,
        tier=ToolTier.ALWAYS,
        parameters={
            "type": "object",
            "properties": {
                "start": {"type": "string", "description": "YYYY-MM-DD"},
                "end": {"type": "string", "description": "YYYY-MM-DD"},
            },
        },
    ),
    ToolSpec(
        name="ticket_channel_lookup",
        description=(
            "查门票的价格、购票渠道（公众号/小程序全名）、实名、提前期、预约与开售规则。"
            "字段级事实只能来自本工具；返回的 source_refs 用于 ticket.source_ref / sale_rule.source_ref。"
        ),
        read_only=True,
        tier=ToolTier.FORCED,
        expensive=True,
        parameters={
            "type": "object",
            "properties": {
                "poi": {"type": "string", "description": "景点名"},
                "city": {"type": "string"},
            },
            "required": ["poi"],
        },
    ),
    ToolSpec(
        name="closure_notice_lookup",
        description=(
            "查封路、季节性开放、临时管制公告。自驾长途段与必去路段必须查。"
            "返回的 closures 可直接用于 season_closure，source_refs 供引用。"
        ),
        read_only=True,
        tier=ToolTier.FORCED,
        expensive=True,
        parameters={
            "type": "object",
            "properties": {
                "target": {"type": "string", "description": "路段或景区名，如「独库公路」"},
                "date_range": {"type": "string", "description": "如 2026-05-01~2026-05-08"},
            },
            "required": ["target"],
        },
    ),
    ToolSpec(
        name="permit_policy_lookup",
        description="查边防证、车辆准入等政策要求（办理地点、提前天数）。",
        read_only=True,
        tier=ToolTier.FORCED,
        expensive=True,
        parameters={
            "type": "object",
            "properties": {"region": {"type": "string"}},
            "required": ["region"],
        },
    ),
    ToolSpec(
        name="transport_info_lookup",
        description=(
            "查长途交通的购买渠道、提前预订天数与典型时长（v1 不给班次）。"
            "没有来源的航班号/车次留空，卡片显示「待核实，以购票平台为准」。"
        ),
        read_only=True,
        tier=ToolTier.JEV,
        expensive=True,
        parameters={
            "type": "object",
            "properties": {
                "from": {"type": "string"},
                "to": {"type": "string"},
                "date": {"type": "string"},
                "mode": {"type": "string", "enum": ["flight", "train", "self_drive"]},
            },
            "required": ["from", "to"],
        },
    ),
    ToolSpec(
        name="opening_hours_lookup",
        description=(
            "查景区营业时间：日常时段、最后入园、闭馆日、季节差异、是否需要预约。"
            "每个要排 visit 的景点都要查；返回的 status 为 verified 时才参与行程校验，"
            "把返回的 source_refs 写进 stop.opening_hours.source_refs（值由服务端回填）。"
        ),
        read_only=True,
        tier=ToolTier.FORCED,
        expensive=True,
        parameters={
            "type": "object",
            "properties": {
                "poi": {"type": "string", "description": "景区名"},
                "city": {"type": "string"},
                "amap_poi_id": {"type": "string"},
                "date_range": {"type": "string"},
            },
            "required": ["poi"],
        },
    ),
    ToolSpec(
        name="social_digest",
        description=(
            "抓公开文本平台的攻略并先摘要（知乎/B站专栏等），返回玩法、避坑与出处。"
            "只是线索，不能当票价/渠道/营业时间的事实。登录墙平台未开启时返回 login_required。"
        ),
        read_only=True,
        tier=ToolTier.JEV,
        expensive=True,
        parameters={
            "type": "object",
            "properties": {
                "keyword": {"type": "string"},
                "city": {"type": "string"},
                "platforms": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["keyword"],
        },
    ),
    ToolSpec(
        name="dispatch_research",
        description=(
            "并行派子 Agent 做开放性调研（路线、经验、交通、天候），各返回结构化摘要。"
            "首次规划且还没有目的地级调研证据时必须先调用它；子 Agent 不能再用本工具。"
        ),
        read_only=True,
        tier=ToolTier.JEV,
        expensive=True,
        parameters=RESEARCH_TASKS_SCHEMA,
    ),
    ToolSpec(
        name="submit_findings",
        description="子 Agent 收尾提交结构化结论。只有子 Agent 可见。",
        read_only=True,
        tier=ToolTier.SUBAGENT,
        parameters=FINDINGS_SCHEMA,
    ),
    ToolSpec(
        name="draft_itinerary",
        description=(
            "写初版行程，全量一次。仅在 trip.days 为空时使用。"
            "参数必须是 {trip: {...}, summary: \"...\"}，trip.days 至少一天；"
            "禁止把整份 JSON 塞进 Raw 字符串。"
            "只写 Activity.time_window 作为时间事实；Stop/Day 的窗口、时长、冲突由服务端推导，禁止写。"
        ),
        read_only=False,
        write=True,
        tier=ToolTier.WRITE,
        parameters={
            "type": "object",
            "properties": {
                "trip": TRIP_SCHEMA_HINT,
                "summary": {"type": "string", "description": "一句话说明这次初版行程的路线思路"},
            },
            "required": ["trip"],
        },
    ),
    ToolSpec(
        name="update_itinerary",
        description=(
            "改行程，增量补丁。禁止并发调用；一次可以带多个 op。"
            "未被指令涉及的 stop 顺序不得改变，只能改时间。"
        ),
        read_only=False,
        write=True,
        tier=ToolTier.WRITE,
        parameters={
            "type": "object",
            "properties": {
                "ops": OPS_SCHEMA,
                "summary": {"type": "string", "description": "如「Day3 作息 09:00→13:00，后移 4 个活动」"},
            },
            "required": ["ops"],
        },
    ),
]

SPEC_BY_NAME = {spec.name: spec for spec in TOOL_SPECS}

#: 这些工具不能由主 Agent 直接调用（02 §2.2）：子 Agent 专属。
MAIN_DENIED = set(SUBAGENT_ONLY)

#: 零外呼工具：任何数据源模式下都可执行。
LOCAL_TOOLS = {ToolName.SUN_TIMES.value, ToolName.HOLIDAY_CALENDAR.value}

#: 复合工具：统一用「检索 → 抽取 → 交叉核对」的实现。
COMPOSITE_TOOLS = {
    ToolName.TICKET_CHANNEL_LOOKUP,
    ToolName.CLOSURE_NOTICE_LOOKUP,
    ToolName.PERMIT_POLICY_LOOKUP,
    ToolName.TRANSPORT_INFO_LOOKUP,
    ToolName.OPENING_HOURS_LOOKUP,
    ToolName.CLIMATE_REFERENCE,
    ToolName.SOCIAL_DIGEST,
}

CACHE_TTLS = {
    "search_poi": "cache_ttl_poi",
    "plan_route": "cache_ttl_route",
    "web_search": "cache_ttl_web",
    "get_weather": "cache_ttl_weather",
    "search_around": "cache_ttl_poi",
    "place_detail": "cache_ttl_poi",
    "fetch_page": "cache_ttl_web",
    "climate_reference": "cache_ttl_fact",
    "ticket_channel_lookup": "cache_ttl_fact",
    "closure_notice_lookup": "cache_ttl_fact",
    "permit_policy_lookup": "cache_ttl_fact",
    "transport_info_lookup": "cache_ttl_fact",
    "opening_hours_lookup": "cache_ttl_fact",
    "social_digest": "cache_ttl_web",
}


class ToolRegistry:
    def __init__(self, settings: Settings, db: Database):
        self.settings = settings
        self.db = db
        self.amap = AmapClient(settings)
        self.tavily = TavilyClient(settings)
        self.deepseek = DeepSeekSearchClient(settings)
        self.retriever = CompositeRetriever(settings)
        self.sources = SourceRegistry(db)
        self._research = None

    # ------------------------------------------------------------------
    # specs
    # ------------------------------------------------------------------
    @property
    def specs(self) -> list[ToolSpec]:
        return TOOL_SPECS

    def openai_tools(self, allowed: set[str] | None = None) -> list[dict[str, Any]]:
        if allowed is None:
            return [s.openai_tool() for s in TOOL_SPECS]
        return [s.openai_tool() for s in TOOL_SPECS if s.name in allowed]

    def spec(self, name: str) -> ToolSpec | None:
        return SPEC_BY_NAME.get(name)

    def tools_by_tier(self, tier: ToolTier) -> list[str]:
        return [s.name for s in TOOL_SPECS if s.tier == tier]

    # ------------------------------------------------------------------
    # execution
    # ------------------------------------------------------------------
    async def execute(
        self,
        name: str,
        args: dict[str, Any],
        data_source: str = "auto",
        *,
        trip_id: str | None = None,
        turn_id: str | None = None,
        agent: str = "main",
        allowed: set[str] | None = None,
        event_sink: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
    ) -> ToolOutcome:
        spec = self.spec(name)
        if spec is None:
            return ToolOutcome(
                ok=False,
                tool=name,
                error=ToolError(tool=name, code="unknown_tool", message=f"未知工具：{name}"),
                summary=f"未知工具：{name}",
            )
        # 执行层再校验一次（02 §2.2）：模型可能返回白名单外的工具名。
        if allowed is not None and name not in allowed:
            return ToolOutcome(
                ok=False,
                tool=name,
                error=ToolError(
                    tool=name,
                    code="tool_not_allowed",
                    message=f"工具 {name} 不在本次可用清单里（allowed={sorted(allowed)}）",
                ),
                summary=f"工具 {name} 不在本次可用清单里",
            )
        if agent == "main" and name in MAIN_DENIED:
            return ToolOutcome(
                ok=False,
                tool=name,
                error=ToolError(
                    tool=name,
                    code="tool_not_allowed",
                    message=f"{name} 仅子 Agent 可用",
                ),
                summary=f"{name} 仅子 Agent 可用",
            )
        if spec.write:
            return ToolOutcome(
                ok=False,
                tool=name,
                error=ToolError(tool=name, code="write_tool", message="写工具必须由 PlanService 串行执行"),
                summary="写工具不能直接调用",
            )
        source = self._source_for(name, data_source)
        if source is None:
            return self._not_configured(name)
        started = time.perf_counter()
        ttl_name = CACHE_TTLS.get(name)
        ttl = getattr(self.settings, ttl_name, 0) if ttl_name else 0
        cache_params = self._cache_params(name, args, source) if ttl else None
        cached = await self.db.cache_get(name, cache_params) if cache_params else None
        if cached:
            outcome = ToolOutcome.model_validate(cached)
            outcome.cached = True
            await self._record(outcome, trip_id, turn_id, agent)
            return outcome

        last_error: ToolError | None = None
        for attempt in range(self.settings.tool_retry_times + 1):
            try:
                outcome = await self._dispatch(
                    name,
                    args,
                    source,
                    trip_id=trip_id,
                    turn_id=turn_id,
                    agent=agent,
                    event_sink=event_sink,
                )
                if outcome.ok and ttl and cache_params:
                    await self.db.cache_set(name, cache_params, outcome.model_dump(mode="json"), ttl)
                outcome.duration_ms = int((time.perf_counter() - started) * 1000)
                await self._record(outcome, trip_id, turn_id, agent)
                return outcome
            except (AmapError, TavilyError, DeepSeekSearchError) as exc:
                last_error = exc.as_error(name) if hasattr(exc, "as_error") else ToolError(
                    tool=name, code=getattr(exc, "code", "error"), message=str(exc)
                )
                if not getattr(exc, "retryable", False) or attempt >= self.settings.tool_retry_times:
                    break
                await asyncio.sleep(0.4 * (2**attempt))
            except CompositeUnavailable as exc:
                last_error = ToolError(tool=name, code=exc.code, message=exc.message)
                break
            except SocialDigestError as exc:
                last_error = ToolError(tool=name, code=exc.code, message=exc.message)
                break
            except Exception as exc:  # pragma: no cover - defensive
                last_error = ToolError(tool=name, code="internal_error", message=str(exc))
                break
        outcome = ToolOutcome(
            ok=False,
            tool=name,
            error=last_error or ToolError(tool=name, code="unknown", message="工具调用失败"),
            summary=(last_error.display() if last_error else "工具调用失败"),
            data=(
                {"ok": False, "error": last_error.code} if last_error else {"ok": False}
            ),
            duration_ms=int((time.perf_counter() - started) * 1000),
        )
        return outcome

    async def _record(
        self, outcome: ToolOutcome, trip_id: str | None, turn_id: str | None, agent: str
    ) -> None:
        try:
            await self.sources.record_outcome(
                outcome, trip_id=trip_id, turn_id=turn_id, agent=agent
            )
        except Exception:  # noqa: BLE001 - 登记簿失败不该让工具结果丢掉
            pass

    async def _dispatch(
        self,
        name: str,
        args: dict[str, Any],
        source: str,
        *,
        trip_id: str | None = None,
        turn_id: str | None = None,
        agent: str = "main",
        event_sink: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
    ) -> ToolOutcome:
        if name == ToolName.SEARCH_POI:
            keyword = str(args.get("keyword") or "").strip()
            if not keyword:
                return self._bad_args(name, "keyword 不能为空")
            city = args.get("city") or None
            category = args.get("category") or None
            if source == "real":
                pois = await self.amap.search_poi(keyword, city, category, 8)
                origin = "amap"
            else:
                pois = mock_search_poi(keyword, city, category, 8)
                origin = "mock"
            return ToolOutcome(
                ok=True,
                tool=name,
                data={"source": origin, "results": [p.model_dump(mode="json") for p in pois]},
                summary=f'搜索「{keyword}」· {len(pois)} 条结果',
                source_refs=[p.source_ref for p in pois],
            )

        if name == ToolName.PLAN_ROUTE:
            from_poi = str(args.get("from") or args.get("from_poi") or "").strip()
            to_poi = str(args.get("to") or args.get("to_poi") or "").strip()
            mode = str(args.get("mode") or "drive")
            if not from_poi or not to_poi:
                return self._bad_args(name, "from / to 不能为空")
            from_coord = (
                (float(args["from_lng"]), float(args["from_lat"]))
                if args.get("from_lng") is not None and args.get("from_lat") is not None
                else None
            )
            to_coord = (
                (float(args["to_lng"]), float(args["to_lat"]))
                if args.get("to_lng") is not None and args.get("to_lat") is not None
                else None
            )
            if source == "real":
                route = await self.amap.plan_route(from_poi, to_poi, mode, from_coord, to_coord)
                origin = "amap"
            else:
                route = mock_plan_route(from_poi, to_poi, mode, from_coord, to_coord)
                origin = "mock"
            mode_label = {"drive": "驾车", "walk": "步行", "transit": "公交"}.get(mode, mode)
            toll_part = f" · 过路费 ¥{route.tolls:g}" if route.tolls else ""
            return ToolOutcome(
                ok=True,
                tool=name,
                data={"source": origin, **route.model_dump(mode="json")},
                summary=f"路径规划 · {route.minutes} 分钟 / {route.distance_km} 公里（{mode_label}）{toll_part}",
                source_refs=[route.source_ref],
            )

        if name == ToolName.WEB_SEARCH:
            query = str(args.get("query") or "").strip()
            if not query:
                return self._bad_args(name, "query 不能为空")
            if source == "real":
                return await self._web_search(query)
            result = mock_web_search(query, 3)
            return ToolOutcome(
                ok=True,
                tool=name,
                data={"source": "mock", **result.model_dump(mode="json")},
                summary=f"搜索「{query}」· {len(result.results)} 条结果",
                source_refs=[result.source_ref],
            )

        if name == ToolName.FETCH_PAGE:
            url = str(args.get("url") or "").strip()
            if not url:
                return self._bad_args(name, "url 不能为空")
            page = await self.deepseek.fetch(url)
            ref = content_ref("fetch", {"url": url, "content": page.get("content", "")[:400]})
            return ToolOutcome(
                ok=True,
                tool=name,
                data={
                    "source": "deepseek",
                    **page,
                    "source_ref": ref,
                },
                summary=f"取回 {url} · {len(page.get('content') or '')} 字",
                source_refs=[ref],
            )

        if name == ToolName.GET_WEATHER:
            city = str(args.get("city") or "").strip()
            if not city:
                return self._bad_args(name, "city 不能为空")
            date_str = args.get("date") or None
            if source == "real":
                weather = await self.amap.weather(city, date_str)
                origin = "amap"
            else:
                weather = mock_weather(city, date_str)
                origin = "mock"
            return ToolOutcome(
                ok=True,
                tool=name,
                data={"source": origin, **weather.model_dump(mode="json")},
                summary=f"天气 · {weather.city} {weather.date or ''} {weather.summary} {weather.low}~{weather.high}°C",
                source_refs=[weather.source_ref],
            )

        if name == ToolName.SEARCH_AROUND:
            if source != "real":
                return self._not_configured(name)
            lng = float(args.get("lng"))
            lat = float(args.get("lat"))
            kind = str(args.get("kind") or "spot")
            pois = await self.amap.search_around(
                lng,
                lat,
                kind,
                args.get("keyword") or None,
                int(args.get("radius") or 3000),
                20,
            )
            return ToolOutcome(
                ok=True,
                tool=name,
                data={
                    "source": "amap",
                    "results": [p.model_dump(mode="json") for p in pois],
                },
                summary=f"周边搜索 · {len(pois)} 条结果",
                source_refs=[p.source_ref for p in pois],
            )

        if name == ToolName.PLACE_DETAIL:
            if source != "real":
                return self._not_configured(name)
            poi_id = str(args.get("amap_poi_id") or "").strip()
            if not poi_id:
                return self._bad_args(name, "amap_poi_id 不能为空")
            detail = await self.amap.place_detail(poi_id)
            ref = content_ref("place", {"poi_id": poi_id, "name": detail.get("name")})
            return ToolOutcome(
                ok=True,
                tool=name,
                data={"source": "amap", "source_ref": ref, **detail},
                summary=f"POI 详情 · {detail.get('name')}",
                source_refs=[ref],
            )

        if name == ToolName.SUN_TIMES:
            if args.get("lng") is None or args.get("lat") is None:
                return self._bad_args(name, "lng / lat 不能为空")
            data = sun_times(float(args["lng"]), float(args["lat"]), args.get("date"))
            ref = content_ref("local:sun", data)
            return ToolOutcome(
                ok=True,
                tool=name,
                data={"source": "local", "source_ref": ref, **data},
                summary=f"日出 {data.get('sunrise') or '—'} · 日落 {data.get('sunset') or '—'}",
                source_refs=[ref],
            )

        if name == ToolName.HOLIDAY_CALENDAR:
            data = holiday_calendar(args.get("start"), args.get("end"))
            ref = content_ref("local:holiday", data)
            names = "、".join(h["name"] for h in data["holidays"][:4])
            return ToolOutcome(
                ok=True,
                tool=name,
                data={"source": "local", "source_ref": ref, **data},
                summary=(
                    f"节假日 · {names or '该区间没有收录的法定假日'}"
                    + (f"（{data.get('note')}）" if data.get("missing_years") else "")
                ),
                source_refs=[ref],
            )

        if name == ToolName.TICKET_CHANNEL_LOOKUP:
            poi = str(args.get("poi") or "").strip()
            if not poi:
                return self._bad_args(name, "poi 不能为空")
            data = await ticket_channel_lookup(
                self.settings, self.retriever, poi=poi, city=args.get("city")
            )
            return self._composite_outcome(name, data)

        if name == ToolName.CLOSURE_NOTICE_LOOKUP:
            target = str(args.get("target") or "").strip()
            if not target:
                return self._bad_args(name, "target 不能为空")
            data = await closure_notice_lookup(
                self.settings,
                self.retriever,
                target=target,
                date_range=args.get("date_range"),
            )
            return self._composite_outcome(name, data)

        if name == ToolName.PERMIT_POLICY_LOOKUP:
            region = str(args.get("region") or "").strip()
            if not region:
                return self._bad_args(name, "region 不能为空")
            data = await permit_policy_lookup(self.settings, self.retriever, region=region)
            return self._composite_outcome(name, data)

        if name == ToolName.TRANSPORT_INFO_LOOKUP:
            from_poi = str(args.get("from") or "").strip()
            to_poi = str(args.get("to") or "").strip()
            if not from_poi or not to_poi:
                return self._bad_args(name, "from / to 不能为空")
            data = await transport_info_lookup(
                self.settings,
                self.retriever,
                from_poi=from_poi,
                to_poi=to_poi,
                date_value=args.get("date"),
                mode=str(args.get("mode") or "flight"),
            )
            return self._composite_outcome(name, data)

        if name == ToolName.CLIMATE_REFERENCE:
            city = str(args.get("city") or "").strip()
            if not city:
                return self._bad_args(name, "city 不能为空")
            month = args.get("month")
            data = await climate_reference(
                self.settings,
                self.retriever,
                city=city,
                month=int(month) if month else None,
            )
            return self._composite_outcome(name, data)

        if name == ToolName.OPENING_HOURS_LOOKUP:
            poi = str(args.get("poi") or "").strip()
            if not poi:
                return self._bad_args(name, "poi 不能为空")
            data, amap_text = await opening_hours_lookup(
                self.settings,
                self.retriever,
                poi=poi,
                city=args.get("city"),
                amap_poi_id=args.get("amap_poi_id"),
                amap_client=self.amap,
                date_range=args.get("date_range"),
            )
            outcome = self._composite_outcome(name, data)
            if outcome.ok:
                outcome.data["amap_business_time"] = amap_text
            return outcome

        if name == ToolName.SOCIAL_DIGEST:
            keyword = str(args.get("keyword") or "").strip()
            if not keyword:
                return self._bad_args(name, "keyword 不能为空")
            data = await social_digest(
                self.settings,
                self.retriever,
                keyword=keyword,
                city=args.get("city"),
                platforms=args.get("platforms"),
            )
            return self._composite_outcome(name, data)

        if name == ToolName.DISPATCH_RESEARCH:
            return await self._dispatch_research(
                args, trip_id=trip_id, turn_id=turn_id, event_sink=event_sink
            )

        if name == ToolName.SUBMIT_FINDINGS:
            return self._bad_args(name, "submit_findings 只能由子 Agent 运行器处理")

        return self._bad_args(name, f"未实现的工具：{name}")

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    async def _web_search(self, query: str) -> ToolOutcome:
        """DeepSeek 与 Tavily 并行检索（01 §4.1），单个源失败不影响另一个。"""
        hits: list[dict[str, Any]] = []
        errors: list[str] = []
        tasks: list[tuple[str, Any]] = []
        if self.deepseek.configured:
            tasks.append(("deepseek", self.deepseek.search(query, 5)))
        if self.tavily.configured:
            tasks.append(("tavily", self.tavily.search(query, 3)))
        if tasks:
            outcomes = await asyncio.gather(*[t[1] for t in tasks], return_exceptions=True)
            for (provider, _), outcome in zip(tasks, outcomes):
                if isinstance(outcome, BaseException):
                    errors.append(f"{provider}: {outcome}")
                    continue
                if provider == "deepseek":
                    for hit in outcome:
                        hits.append(
                            {
                                "title": hit.title,
                                "url": hit.url,
                                "content": hit.text(700),
                                "authority": hit.authority,
                                "date": hit.published_at,
                                "rerank_score": hit.rerank_score,
                                "source_ref": hit.source_ref,
                            }
                        )
                else:
                    for item in outcome.results:
                        hits.append(
                            {
                                "title": item.title,
                                "url": item.url,
                                "content": (item.content or "")[:700],
                                "authority": None,
                                "date": None,
                                "rerank_score": None,
                                "source_ref": outcome.source_ref,
                            }
                        )
        if not hits and errors:
            raise CompositeUnavailable("search_failed", "；".join(errors[:2]))
        providers = "+".join(p for p, _ in tasks) or "none"
        ref = content_ref("web:search", {"query": query, "urls": [h.get("url") for h in hits]})
        refs = [h["source_ref"] for h in hits if h.get("source_ref")]
        conclusion = next((h["content"] for h in hits if h.get("content")), None)
        data = {
            "source": providers,
            "conclusion": (conclusion or "")[:600] or None,
            "results": hits[:6],
            "errors": errors,
            "source_ref": ref,
        }
        return ToolOutcome(
            ok=True,
            tool=ToolName.WEB_SEARCH,
            data=data,
            summary=f"搜索「{query}」· {len(data['results'])} 条结果"
            + (f" · {len(errors)} 个源失败" if errors else ""),
            source_refs=[ref, *refs],
        )

    @staticmethod
    def _composite_outcome(name: str, data: dict[str, Any]) -> ToolOutcome:
        status = data.get("status") or EvidenceStatus.UNVERIFIED.value
        value = data.get("value") or {}
        errors = data.get("retrieval_errors") or []
        return ToolOutcome(
            ok=True,
            tool=name,
            data={"source": "+".join(data.get("providers") or ["none"]), **data},
            summary={
                EvidenceStatus.VERIFIED.value: "已核实",
                EvidenceStatus.CLUE.value: "仅有线索，字段待核实",
                EvidenceStatus.CONFLICT.value: "多源冲突，字段待核实",
                EvidenceStatus.UNVERIFIED.value: "没有找到可核实的来源",
            }.get(status, "查询完成")
            + ("（部分检索源失败）" if errors else ""),
            source_refs=list(data.get("source_refs") or []),
        )

    async def _dispatch_research(
        self,
        args: dict[str, Any],
        *,
        trip_id: str | None,
        turn_id: str | None,
        event_sink: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
    ) -> ToolOutcome:
        from app.agent.subagent import ResearchUnavailable

        runner = self.research_runner()
        try:
            result = await runner.run(
                args.get("tasks"),
                trip_id=trip_id,
                turn_id=turn_id,
                sink=event_sink,
            )
        except ResearchUnavailable as exc:
            return ToolOutcome(
                ok=False,
                tool=ToolName.DISPATCH_RESEARCH,
                data={"ok": False, "error": exc.code, "missing": exc.missing},
                error=ToolError(
                    tool=ToolName.DISPATCH_RESEARCH, code=exc.code, message=exc.message
                ),
                summary=exc.message,
            )
        summaries = [
            {
                "task_id": r.task_id,
                "role": r.role.value,
                "status": r.status.value,
                "summary": r.summary,
                "findings": len(r.findings),
                "gaps": r.gaps,
            }
            for r in result
        ]
        refs = [
            ref for r in result for f in r.findings for ref in f.source_refs if ref
        ]
        ref = content_ref("research", summaries)
        return ToolOutcome(
            ok=True,
            tool=ToolName.DISPATCH_RESEARCH,
            data={"source": "subagents", "results": [r.model_dump(mode="json") for r in result],
                  "source_ref": ref},
            summary=f"子 Agent 调研完成 · {len(result)} 份摘要",
            source_refs=[ref, *refs],
        )

    def research_runner(self):
        if self._research is None:
            from app.agent.subagent import ResearchRunner

            self._research = ResearchRunner(self.settings, self)
        return self._research

    def _source_for(self, name: str, data_source: str) -> str | None:
        legacy = {ToolName.SEARCH_POI.value, ToolName.PLAN_ROUTE.value,
                  ToolName.WEB_SEARCH.value, ToolName.GET_WEATHER.value}
        if data_source == "mock":
            if name in LOCAL_TOOLS:
                return "local"
            # 新工具没有脚本化 fixture：假数据不能冒充真实调研（02 §2.8）
            return "mock" if name in legacy else None
        configured = self._configured(name)
        if data_source == "real":
            return "real" if configured else None
        # auto: 老工具在没配置时回落到 fixture；新工具只走真实路径
        if name in legacy:
            return "real" if configured else "mock"
        return "real" if configured else None

    def _configured(self, name: str) -> bool:
        if name == ToolName.WEB_SEARCH:
            return self.tavily.configured or self.deepseek.configured
        if name in {ToolName.SUN_TIMES.value, ToolName.HOLIDAY_CALENDAR.value}:
            return True
        if name in {ToolName.FETCH_PAGE.value}:
            return self.deepseek.configured
        if name in COMPOSITE_TOOLS:
            return self.retriever.configured
        if name == ToolName.DISPATCH_RESEARCH.value:
            return self.settings.llm_configured and (self.settings.default_provider or "mock") != "mock"
        return self.amap.configured

    def _cache_params(self, name: str, args: dict[str, Any], source: str) -> dict[str, Any]:
        """Namespace cache entries by the actual data source.

        Otherwise a demo (mock) result could satisfy a real AMap call for 7 days
        after the operator adds a key.
        """
        if source == "mock":
            origin = "mock"
        elif name == ToolName.WEB_SEARCH:
            origin = f"search:{self.tavily.configured}:{self.deepseek.configured}"
        elif name in COMPOSITE_TOOLS:
            origin = f"composite:{self.deepseek.configured}:{self.tavily.configured}"
        elif name in {ToolName.SUN_TIMES.value, ToolName.HOLIDAY_CALENDAR.value}:
            origin = "local"
        else:
            origin = f"amap:{self.settings.amap_base_url}"
        return {**args, "_source": origin}

    def _not_configured(self, name: str) -> ToolOutcome:
        if name in {ToolName.WEB_SEARCH.value, *COMPOSITE_TOOLS}:
            label = "DEEPSEEK_API_KEY / TAVILY_API_KEY"
            message = "联网检索未配置：请在「接入配置」里填写 DeepSeek 或 Tavily 的 API Key"
        elif name == ToolName.DISPATCH_RESEARCH.value:
            label = "LLM"
            message = (
                "子 Agent 调研未配置：演示模式 / Mock provider 下不派真实调研，"
                "请在「接入配置」里接入模型后再试"
            )
        elif name == ToolName.FETCH_PAGE.value:
            label = "DEEPSEEK_API_KEY"
            message = "网页抓取未配置：请在「接入配置」里填写 DeepSeek API Key"
        else:
            label = "AMAP_WEB_KEY"
            message = "高德 Web 服务未配置：请在「接入配置」里填写高德 Web 服务 Key"
        return ToolOutcome(
            ok=False,
            tool=name,
            data={"ok": False, "error": "not_configured", "missing": label},
            error=ToolError(tool=name, code="not_configured", message=message),
            summary=message,
        )

    @staticmethod
    def _bad_args(tool: str, message: str) -> ToolOutcome:
        return ToolOutcome(
            ok=False,
            tool=tool,
            error=ToolError(tool=tool, code="bad_args", message=message),
            summary=f"参数错误：{message}",
        )

    @staticmethod
    def slim_for_model(name: str, outcome: ToolOutcome) -> dict[str, Any]:
        """Context trimming (docs §4.7): keep only what the model needs."""
        if not outcome.ok:
            return {"ok": False, "error": outcome.error.model_dump() if outcome.error else outcome.summary}
        data = outcome.data or {}
        if name == ToolName.SEARCH_POI:
            results = []
            for p in (data.get("results") or [])[:8]:
                results.append(
                    {
                        "name": p.get("name"),
                        "amap_poi_id": p.get("amap_poi_id"),
                        "lng": p.get("lng"),
                        "lat": p.get("lat"),
                        "city": p.get("city"),
                        "category": p.get("category"),
                        "source_ref": p.get("source_ref"),
                    }
                )
            return {"ok": True, "results": results}
        if name == ToolName.SEARCH_AROUND:
            return {
                "ok": True,
                "results": [
                    {
                        "name": r.get("name"),
                        "amap_poi_id": r.get("amap_poi_id"),
                        "lng": r.get("lng"),
                        "lat": r.get("lat"),
                        "distance_m": r.get("distance_m"),
                        "source_ref": r.get("source_ref"),
                    }
                    for r in (data.get("results") or [])[:20]
                ],
            }
        if name == ToolName.PLACE_DETAIL:
            return {
                "ok": True,
                "name": data.get("name"),
                "address": data.get("address"),
                "tel": data.get("tel"),
                "business_time": data.get("business_time"),
                "rating": data.get("rating"),
                "source_ref": data.get("source_ref"),
            }
        if name == ToolName.WEB_SEARCH:
            return {
                "ok": True,
                "conclusion": (data.get("conclusion") or "")[:600],
                "results": [
                    {
                        "title": r.get("title"),
                        "url": r.get("url"),
                        "content": (r.get("content") or "")[:600],
                        "authority": r.get("authority"),
                        "date": r.get("date"),
                        "source_ref": r.get("source_ref"),
                    }
                    for r in (data.get("results") or [])[:4]
                ],
                "source_ref": data.get("source_ref"),
            }
        if name == ToolName.FETCH_PAGE:
            return {
                "ok": True,
                "url": data.get("url"),
                "title": data.get("title"),
                "content": (data.get("content") or "")[:2500],
                "source_ref": data.get("source_ref"),
            }
        if name == ToolName.PLAN_ROUTE:
            return {
                "ok": True,
                "distance_km": data.get("distance_km"),
                "minutes": data.get("minutes"),
                "mode": data.get("mode"),
                "tolls": data.get("tolls"),
                "toll_distance_km": data.get("toll_distance_km"),
                "has_toll_road": data.get("has_toll_road"),
                "source_ref": data.get("source_ref"),
            }
        if name == ToolName.GET_WEATHER:
            return {
                "ok": True,
                "city": data.get("city"),
                "date": data.get("date"),
                "summary": data.get("summary"),
                "high": data.get("high"),
                "low": data.get("low"),
                "status": data.get("status"),
                "source_ref": data.get("source_ref"),
            }
        if name in COMPOSITE_TOOLS:
            evidence = data.get("evidence") or []
            return {
                "ok": True,
                "status": data.get("status"),
                "conflict": data.get("conflict"),
                "value": data.get("value"),
                "authority": data.get("authority"),
                "source_refs": data.get("source_refs"),
                "evidence": [
                    {
                        "url": e.get("url"),
                        "title": e.get("title"),
                        "published_at": e.get("published_at"),
                        "source_type": e.get("source_type"),
                        "quote": (e.get("quote") or "")[:300],
                        "source_ref": e.get("source_ref"),
                    }
                    for e in evidence[:4]
                ],
                "note": (data.get("value") or {}).get("note"),
                "source_ref": data.get("source_ref"),
            }
        if name == ToolName.DISPATCH_RESEARCH:
            return {
                "ok": True,
                "results": [
                    {
                        "task_id": r.get("task_id"),
                        "role": r.get("role"),
                        "status": r.get("status"),
                        "summary": r.get("summary"),
                        "findings": [
                            {
                                "kind": f.get("kind"),
                                "claim": f.get("claim"),
                                "source_refs": f.get("source_refs"),
                                "evidence": [
                                    {
                                        "url": e.get("url"),
                                        "published_at": e.get("published_at"),
                                        "quote": (e.get("quote") or "")[:200],
                                    }
                                    for e in (f.get("evidence") or [])[:2]
                                ],
                                "confidence": f.get("confidence"),
                            }
                            for f in (r.get("findings") or [])[:6]
                        ],
                        "gaps": r.get("gaps"),
                    }
                    for r in (data.get("results") or [])
                ],
                "source_ref": data.get("source_ref"),
            }
        return {"ok": True, "data": data}
