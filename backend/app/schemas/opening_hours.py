"""景区营业时间（docs/new-plan 02 §3）。

营业时间不是一个字符串：要拆成日常时段、最后入园时间、闭馆日、季节差异、
是否需预约。默认挂在 `Stop` 上，因为位置属于 stop。

模型只引用 `source_ref`，值由服务端从来源登记簿取出填入；`status` 决定校验器
是否把它当硬约束（只有 `verified` 会报 error）。
"""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.sources import Evidence, EvidenceStatus

WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def weekday_code(value: date) -> str:
    return WEEKDAYS[value.weekday()]


def hm_to_minutes(value: str | None) -> int | None:
    if not value:
        return None
    try:
        hour, minute = str(value).split(":")[:2]
        return int(hour) * 60 + int(minute)
    except (ValueError, AttributeError):
        return None


class OpeningPeriod(BaseModel):
    """一段日常营业时段。`days` 是星期短码，空表示每天。"""

    model_config = ConfigDict(extra="forbid")

    days: list[str] = Field(default_factory=list, description="mon..sun；空 = 每天")
    open: str = Field(description="HH:MM")
    close: str = Field(description="HH:MM")
    last_entry: str | None = Field(default=None, description="最后入园时间 HH:MM")

    def normalized_days(self) -> list[str]:
        days = [d.strip().lower()[:3] for d in self.days if d]
        days = [d for d in days if d in WEEKDAYS]
        return days or list(WEEKDAYS)

    def covers(self, weekday: str) -> bool:
        return weekday in self.normalized_days()

    def contains(self, minute: int) -> bool:
        """`minute` 是否落在 [open, close] 内。跨零点按加一天处理。"""
        start = hm_to_minutes(self.open)
        end = hm_to_minutes(self.close)
        if start is None or end is None:
            return False
        if end < start:
            end += 24 * 60
        value = minute
        if value < start and end >= 24 * 60:
            value += 24 * 60
        return start <= value <= end


class SeasonalOpening(BaseModel):
    """季节段：月-日区间内的营业时段覆盖日常时段。

    `from` 是 Python 关键字，字段名用 `from_` + 别名；序列化也走别名，
    否则 Trip JSON 里会出现 `from_`，前端读 `from` 就永远为空。
    """

    model_config = ConfigDict(
        extra="forbid", populate_by_name=True, serialize_by_alias=True
    )

    from_: str = Field(alias="from", description="MM-DD")
    to: str = Field(description="MM-DD")
    regular: list[OpeningPeriod] = Field(default_factory=list)

    def matches(self, value: date) -> bool:
        start = _month_day(self.from_)
        end = _month_day(self.to)
        if start is None or end is None:
            return False
        current = (value.month, value.day)
        if start <= end:
            return start <= current <= end
        return current >= start or current <= end


class OpeningHours(BaseModel):
    """一个景点的营业时间。`status != verified` 时卡片显示「营业时间待核实」。"""

    model_config = ConfigDict(extra="forbid")

    status: EvidenceStatus = EvidenceStatus.UNVERIFIED
    regular: list[OpeningPeriod] = Field(default_factory=list)
    closed_days: list[str] = Field(default_factory=list, description="周几闭馆（mon..sun）")
    closed_dates: list[date] = Field(default_factory=list, description="具体闭馆日期")
    seasonal: list[SeasonalOpening] = Field(default_factory=list)
    reservation_required: bool | None = None
    note: str | None = None
    evidence: list[Evidence] = Field(default_factory=list)
    source_refs: list[str] = Field(default_factory=list)
    authority: int | None = None

    def normalized_closed_days(self) -> set[str]:
        return {d.strip().lower()[:3] for d in self.closed_days if d}

    def periods_for(self, value: date) -> list[OpeningPeriod] | None:
        """当天适用的营业时段。

        - 命中季节段：返回该季节段里属于当天星期的时段（可能为空 = 当天不营业）；
        - 有季节段但一个都不匹配：返回 None，调用方按「未核实」处理（02 §3.3）。
        """
        if self.seasonal:
            matched = [s for s in self.seasonal if s.matches(value)]
            if not matched:
                return None
            periods: list[OpeningPeriod] = []
            for season in matched:
                periods.extend(p for p in season.regular if p.covers(weekday_code(value)))
            return periods
        return [p for p in self.regular if p.covers(weekday_code(value))]


def _month_day(raw: str | None) -> tuple[int, int] | None:
    if not raw:
        return None
    parts = str(raw).split("-")
    if len(parts) < 2:
        parts = str(raw).split("/")
    if len(parts) < 2:
        return None
    try:
        return int(parts[-2]), int(parts[-1])
    except ValueError:
        return None
