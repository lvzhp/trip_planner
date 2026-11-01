"""零外呼的确定性环境工具：日出日落、节假日与调休（docs/new-plan 01 §3、§8）。

这两个工具不需要任何 API Key，也不该由模型凭经验写：

- `sun_times`：本地天文计算（NOAA 近似公式），误差在分钟级，足够安排晨昏活动；
- `holiday_calendar`：内置静态放假安排表。**没有收录的年份如实返回 `unverified`**，
  不编造国务院办公厅的公告日期（01 §12 明确「数据源未定」）。
"""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta
from typing import Any

# --------------------------------------------------------------------------
# 日出日落
# --------------------------------------------------------------------------

CHINA_UTC_OFFSET = 8.0


def _julian_day(value: date) -> float:
    year, month, day = value.year, value.month, value.day
    if month <= 2:
        year -= 1
        month += 12
    a = year // 100
    b = 2 - a + a // 4
    return (
        math.floor(365.25 * (year + 4716))
        + math.floor(30.6001 * (month + 1))
        + day
        + b
        - 1524.5
    )


def _noaa_sun_times(lng: float, lat: float, value: date) -> dict[str, Any]:
    """NOAA / 「Sunrise equation」近似公式。返回儒略日形式的日出日落时刻。"""
    jd = _julian_day(value)
    # J2000 以 12:00 UT 为起点，所以 n 必须取整天数（ceil），不能直接用连续差值，
    # 否则整条时间轴会偏 12 小时，日出日落直接对调。
    n = math.ceil(jd - 2451545.0 + 0.0008)
    # J* = 平太阳时对应的儒略周期；经度修正不能丢，否则日出会偏差数小时
    j_star = n - lng / 360.0
    m = (357.5291 + 0.98560028 * j_star) % 360.0
    c = (
        1.9148 * math.sin(math.radians(m))
        + 0.02 * math.sin(math.radians(2 * m))
        + 0.0003 * math.sin(math.radians(3 * m))
    )
    lam = (m + c + 180.0 + 102.9372) % 360.0
    declination = math.degrees(
        math.asin(math.sin(math.radians(lam)) * math.sin(math.radians(23.4397)))
    )
    j_transit = (
        2451545.0 + j_star + 0.0053 * math.sin(math.radians(m)) - 0.0069 * math.sin(math.radians(2 * lam))
    )

    denominator = math.cos(math.radians(lat)) * math.cos(math.radians(declination))
    if abs(denominator) < 1e-9:
        return {"polar": "day"}
    hour_angle_arg = (
        math.sin(math.radians(-0.833))
        - math.sin(math.radians(lat)) * math.sin(math.radians(declination))
    ) / denominator
    if hour_angle_arg > 1:
        return {"polar": "night"}
    if hour_angle_arg < -1:
        return {"polar": "day"}
    hour_angle = math.degrees(math.acos(hour_angle_arg))
    omega = hour_angle / 360.0
    return {"sunrise_jd": j_transit - omega, "sunset_jd": j_transit + omega}


def _jd_to_hhmm(jd: float) -> str:
    """儒略日 → 北京时间 HH:MM（中国境内目的地统一用 UTC+8）。"""
    unix_days = jd - 2440587.5
    utc = datetime(1970, 1, 1) + timedelta(days=unix_days)
    local = utc + timedelta(hours=CHINA_UTC_OFFSET)
    return local.strftime("%H:%M")


def sun_times(lng: float, lat: float, day: str | None = None) -> dict[str, Any]:
    value = date.fromisoformat(day[:10]) if day else date.today()
    raw = _noaa_sun_times(float(lng), float(lat), value)
    if raw.get("polar") == "night":
        return {
            "date": value.isoformat(),
            "lng": lng,
            "lat": lat,
            "sunrise": None,
            "sunset": None,
            "daylight_hours": 0.0,
            "note": "极夜：当天没有日出日落",
            "source": "local:noaa",
        }
    if raw.get("polar") == "day":
        return {
            "date": value.isoformat(),
            "lng": lng,
            "lat": lat,
            "sunrise": None,
            "sunset": None,
            "daylight_hours": 24.0,
            "note": "极昼：当天没有日出日落",
            "source": "local:noaa",
        }
    sunrise = _jd_to_hhmm(raw["sunrise_jd"])
    sunset = _jd_to_hhmm(raw["sunset_jd"])

    def minutes(value_: str) -> int:
        hour, minute = value_.split(":")
        return int(hour) * 60 + int(minute)

    daylight = (minutes(sunset) - minutes(sunrise)) / 60
    return {
        "date": value.isoformat(),
        "lng": float(lng),
        "lat": float(lat),
        "sunrise": sunrise,
        "sunset": sunset,
        "daylight_hours": round(daylight, 2),
        "note": "本地天文计算，分钟级误差；不含地形遮挡",
        "source": "local:noaa",
    }


# --------------------------------------------------------------------------
# 节假日与调休
# --------------------------------------------------------------------------

#: 只收录能核对到的年份。数据源未定（01 §12），没收录就如实说「未收录」。
HOLIDAYS: dict[int, dict[str, Any]] = {
    2025: {
        "source": "国务院办公厅《关于2025年部分节假日安排的通知》",
        "holidays": [
            {"name": "元旦", "start": "2025-01-01", "end": "2025-01-01"},
            {"name": "春节", "start": "2025-01-28", "end": "2025-02-04"},
            {"name": "清明节", "start": "2025-04-04", "end": "2025-04-06"},
            {"name": "劳动节", "start": "2025-05-01", "end": "2025-05-05"},
            {"name": "端午节", "start": "2025-05-31", "end": "2025-06-02"},
            {"name": "国庆节、中秋节", "start": "2025-10-01", "end": "2025-10-08"},
        ],
        "adjusted_workdays": ["2025-01-26", "2025-02-08", "2025-04-27", "2025-09-28", "2025-10-11"],
    }
}


def _parse(raw: str | None) -> date | None:
    if not raw:
        return None
    try:
        return date.fromisoformat(str(raw)[:10])
    except ValueError:
        return None


def holiday_calendar(
    start: str | None = None, end: str | None = None
) -> dict[str, Any]:
    start_date = _parse(start)
    end_date = _parse(end) or start_date
    if start_date is None and end_date is None:
        start_date = end_date = date.today()
    if start_date is None:
        start_date = end_date
    if end_date is None:
        end_date = start_date
    if start_date and end_date and end_date < start_date:
        start_date, end_date = end_date, start_date

    years = sorted({start_date.year, end_date.year}) if start_date and end_date else []
    holidays: list[dict[str, Any]] = []
    adjusted: list[str] = []
    covered_years: list[int] = []
    missing_years: list[int] = []
    for year in years:
        entry = HOLIDAYS.get(year)
        if entry is None:
            missing_years.append(year)
            continue
        covered_years.append(year)
        adjusted.extend(entry["adjusted_workdays"])
        for item in entry["holidays"]:
            item_start = _parse(item["start"])
            item_end = _parse(item["end"])
            if item_start is None or item_end is None:
                continue
            if item_end < start_date or item_start > end_date:
                continue
            holidays.append(
                {
                    **item,
                    "days": (item_end - item_start).days + 1,
                    "source": entry["source"],
                }
            )

    in_range_adjusted = [
        value for value in adjusted if start_date <= (_parse(value) or start_date) <= end_date
    ]
    status = "reference" if holidays or covered_years else "unverified"
    note = None
    if missing_years:
        note = (
            f"内置静态表没有 {'、'.join(str(y) for y in missing_years)} 年的放假安排，"
            "请以当年度国务院办公厅公告为准；本工具不编造未核实的日期。"
        )
    return {
        "range": {
            "start": start_date.isoformat() if start_date else None,
            "end": end_date.isoformat() if end_date else None,
        },
        "holidays": holidays,
        "adjusted_workdays": in_range_adjusted,
        "covered_years": covered_years,
        "missing_years": missing_years,
        "status": status,
        "note": note,
        "source": "builtin:state-council-calendar",
    }
