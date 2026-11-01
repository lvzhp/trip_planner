"""行程文档 schema —— 全项目脊柱。

对应 docs/01-architecture.md §1。

核心不变量（校验器负责强制，见 app/core/validator.py）：
1. 只有 Activity.time_window 是事实；Stop / Day 的窗口与时长全部由校验器推导，模型禁止写。
2. stop_id / activity_id 必须跨重规划存活。
3. 坐标与 amap_poi_id 必须带 source_ref（只能来自 search_poi 的真实返回）。
4. transit_from_prev 与 transit_detail 的时长/距离只能来自 plan_route，模型禁止估算。
"""

from __future__ import annotations

from datetime import date as date_t, time as time_t
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.opening_hours import OpeningHours


# --------------------------------------------------------------------------
# 枚举
# --------------------------------------------------------------------------


class ActivityType(StrEnum):
    """刻意压到 5 个值。类型越少，模型越学得会，校验规则越少。

    自驾不是独立 type —— 它是 long_transit 内部 transit_detail.mode 的一个分支。
    三者结构位置相同（占据数小时的长块），差异只在 detail 里。

    meal 是纯时间占位块（docs/07 §2）：只负责"留出吃饭时间"，不指定餐厅。
    具体吃什么属于攻略层，由 stop 详情按需检索，永不写回本文档。
    """

    VISIT = "visit"
    MEAL = "meal"
    STAY = "stay"
    LONG_TRANSIT = "long_transit"
    FREE = "free"


class TransportMode(StrEnum):
    """市内短驳的出行方式，对应高德路径规划 API 的 strategy。"""

    DRIVE = "drive"
    WALK = "walk"
    TRANSIT = "transit"


class LongTransitMode(StrEnum):
    FLIGHT = "flight"
    TRAIN = "train"
    SELF_DRIVE = "self_drive"


class TicketKind(StrEnum):
    """`HOTEL` 已废弃（docs/new-plan 01 §10）：住宿收缩到区域级，只写住在哪个地点，
    不再有酒店名/价格/渠道。枚举保留，只拒绝新写入，历史快照仍要能读出来。"""

    ATTRACTION = "attraction"
    TRANSPORT = "transport"
    HOTEL = "hotel"
    NONE = "none"


class ChannelStatus(StrEnum):
    """渠道的可信度（01 §5.1）。只有 verified 的官方渠道进开售提醒。"""

    VERIFIED = "verified"
    CLUE = "clue"
    UNVERIFIED = "unverified"


class SaleMode(StrEnum):
    """开售规则形态（01 §5.1）。日期比较全部由代码算，不交给模型或 Jev。"""

    ADVANCE_DAYS_AT_TIME = "advance_days_at_time"
    FIXED_DATE = "fixed_date"
    ROLLING_DAILY = "rolling_daily"
    LOTTERY_OR_RESERVATION = "lottery_or_reservation"
    ONSITE_ONLY = "onsite_only"


class ChannelType(StrEnum):
    """购票渠道类型。detail 字段专门装"哪个公众号"。"""

    WECHAT_MP = "wechat_mp"  # 微信公众号
    MINI_PROGRAM = "mini_program"  # 微信小程序
    APP = "app"
    WEB = "web"
    OTA = "ota"  # 美团 / 携程 / 飞猪等
    ONSITE = "onsite"  # 现场购票


class TripTransport(StrEnum):
    """整趟行程的主交通形态，决定是否需要 waypoints / 接驳。"""

    FLIGHT = "flight"
    TRAIN = "train"
    SELF_DRIVE = "self_drive"


class BudgetLevel(StrEnum):
    LOW = "low"
    MID = "mid"
    HIGH = "high"


class Pace(StrEnum):
    RELAXED = "relaxed"
    NORMAL = "normal"
    INTENSE = "intense"


# --------------------------------------------------------------------------
# 引用与基础结构
# --------------------------------------------------------------------------


class SeasonClosure(BaseModel):
    """季节性封路 / 开放窗口。五一独库公路大概率未开放 —— 校验器靠这个字段拦。"""

    model_config = ConfigDict(extra="forbid")

    open_from: str | None = Field(default=None, description="月-日，如 '06-01'；年际变化的用备注说明")
    open_to: str | None = Field(default=None, description="月-日，如 '10-15'")
    note: str | None = None
    source_ref: str | None = Field(
        default=None,
        description="时效性信息必须来自 web_search，不能靠模型先验（先验是训练截止日期之前的，封路日期年年变）",
    )


class PoiRef(BaseModel):
    """对 POI 的轻量引用，用于 must_go / waypoints_poi / fuel_stops 等。

    与 Stop.poi 的区别：PoiRef 不承诺已排入行程，可能只有名字没有坐标
    （用户说"我想去喀纳斯"时还没有 search_poi 过）。
    """

    model_config = ConfigDict(extra="forbid")

    name: str
    amap_poi_id: str | None = None
    lng: float | None = None
    lat: float | None = None
    city: str | None = None
    source_ref: str | None = None
    season_closure: SeasonClosure | None = Field(
        default=None,
        description="仅 must_go 有意义：该目标本身有季节性开放窗口（如独库公路）。",
    )


class Poi(BaseModel):
    """已确认的 POI。lng/lat/amap_poi_id 必须成对出现且带 source_ref。"""

    model_config = ConfigDict(extra="forbid")

    name: str
    amap_poi_id: str | None = None
    lng: float | None = None
    lat: float | None = None
    city: str | None = None
    address: str | None = None
    source_ref: str | None = Field(
        default=None,
        description="search_poi 返回时服务端发的 ref id。缺坐标时此字段必填，否则校验器拒绝写入。",
    )


class TimeWindow(BaseModel):
    """活动的时间窗。唯一权威时间源。

    start/end 用 time 而非 datetime —— 具体日期挂在 Day.date 上，
    且行程经常处于"未定具体日期"状态（用户只说"五一"）。
    跨天的活动（如夜车）允许 end < start。
    """

    model_config = ConfigDict(extra="forbid")

    start: time_t
    end: time_t


# --------------------------------------------------------------------------
# 交通
# --------------------------------------------------------------------------


class TransitLeg(BaseModel):
    """市内短驳（边）。全部字段由 plan_route 工具填写，模型只决定顺序。

    模型自己填 minutes 会导致误差累积放大：低估 1 小时 → 当天后续活动全部越界。
    """

    model_config = ConfigDict(extra="forbid")

    mode: TransportMode = TransportMode.DRIVE
    minutes: int | None = None
    distance_km: float | None = None
    source_ref: str | None = None


class FlightDetail(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal[LongTransitMode.FLIGHT] = LongTransitMode.FLIGHT
    flight_no: str | None = None
    airline: str | None = None
    airport_from: str | None = None
    airport_to: str | None = None
    dep_time: time_t | None = None
    arr_time: time_t | None = None
    source_ref: str | None = None


class TrainDetail(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal[LongTransitMode.TRAIN] = LongTransitMode.TRAIN
    train_no: str | None = None
    station_from: str | None = None
    station_to: str | None = None
    seat_class: str | None = None
    dep_time: time_t | None = None
    arr_time: time_t | None = None
    source_ref: str | None = None


class SelfDriveDetail(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal[LongTransitMode.SELF_DRIVE] = LongTransitMode.SELF_DRIVE
    distance_km: float | None = None
    drive_minutes: int | None = Field(
        default=None,
        description="必须由 plan_route 返回，模型禁止估算",
    )
    waypoints_poi: list[PoiRef] = Field(default_factory=list)
    road_refs: list[str] = Field(default_factory=list, description="如 '独库公路 G217'")
    road_condition: str | None = None
    season_closure: SeasonClosure | None = None
    fuel_stops: list[PoiRef] = Field(default_factory=list)
    parking: str | None = None
    permit_required: bool = False
    permit_note: str | None = Field(default=None, description="如边防证办理地点与提前天数")
    source_ref: str | None = None


TransitDetail = Annotated[
    FlightDetail | TrainDetail | SelfDriveDetail,
    Field(discriminator="mode"),
]
"""长途交通明细。discriminated union —— 不新增 self_drive 这个 activity type。"""


# --------------------------------------------------------------------------
# 门票 / 预订
# --------------------------------------------------------------------------


class BookingChannel(BaseModel):
    """购票渠道。detail 专门装"哪个公众号"—— 功能2 的硬需求，
    所以它是独立字段而不是自由文本 note。"""

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def _accept_kind_and_url(cls, data):
        if not isinstance(data, dict):
            return data
        data = dict(data)
        if "type" not in data and "kind" in data:
            data["type"] = data["kind"]
        if "detail" not in data and isinstance(data.get("url"), str):
            data["detail"] = data["url"]
        allowed = {
            "name", "type", "detail", "note", "official", "status",
            "evidence_url", "how_to_find", "source_ref",
        }
        data = {k: v for k, v in data.items() if k in allowed}
        alias = {
            "online": "ota",
            "ticket": "ota",
            "official": "web",
            "wechat": "wechat_mp",
            "miniProgram": "mini_program",
        }
        data["type"] = alias.get(str(data.get("type")), data.get("type", "ota"))
        return data

    name: str = Field(description="如 '喀纳斯景区' / '12306'")
    type: ChannelType
    detail: str | None = Field(
        default=None, description="公众号全名 / 小程序名 / App 名 / 网址"
    )
    note: str | None = None
    official: bool | None = Field(default=None, description="是否景区官方渠道")
    status: ChannelStatus = Field(
        default=ChannelStatus.UNVERIFIED,
        description="verified 必须有官方域名或官方公告作为 evidence_url",
    )
    evidence_url: str | None = Field(default=None, description="渠道的出处链接")
    how_to_find: str | None = Field(
        default=None, description="例如：微信搜索某某，底部菜单进入购票；仅来源页明确写了才填"
    )
    source_ref: str | None = Field(default=None, description="该渠道的来源 ref")


class RecommendedPurchase(BaseModel):
    """"买什么时间的"必须落到字段上，不能只在 note 里飘着。"""

    model_config = ConfigDict(extra="forbid")

    target_date: date_t | None = Field(default=None, description="建议下单日期")
    session: str | None = Field(default=None, description="场次，如 '上午场' / 'G3015 二等座'")
    lead_time_days: int | None = None
    note: str | None = None


class SaleRule(BaseModel):
    """开售规则（01 §5.1）。`开售日 = 游玩日 - advance_days` 由代码算进 booking_timeline。"""

    model_config = ConfigDict(extra="forbid")

    mode: SaleMode = SaleMode.ONSITE_ONLY
    advance_days: int | None = Field(default=None, ge=0)
    release_time: str | None = Field(default=None, description="HH:MM，如 20:00")
    fixed_date: date_t | None = Field(default=None, description="fixed_date 模式的开售日")
    source_ref: str | None = Field(default=None, description="必须能在来源登记簿里找到")


class LimitedQuota(BaseModel):
    """稀缺度只记证据里有的（限流公告、售罄报道），不允许模型自己下结论。"""

    model_config = ConfigDict(extra="forbid")

    quote: str
    source_ref: str | None = None


class Ticket(BaseModel):
    """activity 级统一结构。景点门票、火车票、机票、酒店都是"票"，只是 kind 不同。

    系统不做任何真实下单 —— 只告诉用户去哪儿买、买哪个场次。
    """

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def _accept_price_aliases(cls, data):
        if not isinstance(data, dict):
            return data
        data = dict(data)
        if data.get("price_range") is None:
            for key in ("adult_price", "ticket_price", "face_price", "fee", "amount", "cost", "fare", "price"):
                value = data.get(key)
                if isinstance(value, (int, float)):
                    data["price_range"] = [float(value), float(value)]
                    break
        allowed = {
            "kind", "price_range", "currency", "lead_time_days", "real_name_required",
            "channels", "recommended_purchase", "note", "source_ref",
            "sale_rule", "limited_quota",
        }
        return {k: v for k, v in data.items() if k in allowed}

    kind: TicketKind = TicketKind.NONE
    price_range: tuple[float, float] | None = Field(default=None, description="(min, max)")
    currency: str = "CNY"
    lead_time_days: int | None = Field(default=None, description="需提前几天订")
    real_name_required: bool = False
    channels: list[BookingChannel] = Field(default_factory=list)
    recommended_purchase: RecommendedPurchase | None = None
    note: str | None = None
    source_ref: str | None = None
    sale_rule: SaleRule | None = Field(default=None, description="开售规则；有值必须带登记簿里的 source_ref")
    limited_quota: LimitedQuota | None = None


# --------------------------------------------------------------------------
# Activity / Stop / Day
# --------------------------------------------------------------------------


class Activity(BaseModel):
    """行程的原子单元。比 stop 更细：一个 stop（地理位置）下挂多个 activity。"""

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def _accept_description(cls, data):
        # Models often invent `description`; map it to the real `note` field.
        if isinstance(data, dict) and "description" in data:
            data = dict(data)
            desc = data.pop("description")
            data.setdefault("note", desc)
        return data

    @model_validator(mode="before")
    @classmethod
    def _drop_legacy_food(cls, data):
        # v2 删除了 food_detail（docs/07 §2），但库里已有行仍带该键。
        # extra="forbid" 会让旧行程读取时直接 ValidationError，故在此剥离。
        if isinstance(data, dict) and "food_detail" in data:
            data = dict(data)
            data.pop("food_detail", None)
        return data

    activity_id: str = Field(description="稳定 ID，跨重规划必须存活")
    seq: int = Field(default=0, description="stop 内顺序；day 内全局顺序由 time_window 决定")
    type: ActivityType
    title: str
    time_window: TimeWindow
    note: str | None = None
    tips: list[str] = Field(default_factory=list, description="注意事项")

    transit_from_prev: TransitLeg | None = Field(
        default=None, description="市内短驳（边），工具填写。第一个活动为 None"
    )
    transit_detail: TransitDetail | None = Field(
        default=None, description="仅当 type == long_transit"
    )
    ticket: Ticket | None = None

    source_refs: list[str] = Field(
        default_factory=list,
        description="服务端自动打标，模型只需引用。保证每个事实可追溯到某次工具调用",
    )


class Stop(BaseModel):
    """一个地理位置（POI），仅做地图锚点与分组。

    地图 marker 打在这一层，不按 activity 打 —— 同一 POI 的多个 activity
    坐标完全相同，按 activity 打点会有 3 个 marker 叠在一个像素上。
    """

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def _drop_legacy_food(cls, data):
        # 同 Activity：v2 删了 nearby_food，剥离旧库行里的遗留键。
        if isinstance(data, dict) and "nearby_food" in data:
            data = dict(data)
            data.pop("nearby_food", None)
        return data

    stop_id: str = Field(description="稳定 ID，跨重规划必须存活")
    seq: int = Field(default=0, description="day 内顺序")
    poi: Poi
    activities: list[Activity] = Field(default_factory=list)
    opening_hours: OpeningHours | None = Field(
        default=None,
        description="景区营业时间（02 §3）。模型只引用 source_ref，值由服务端从来源登记簿回填。",
    )


class Day(BaseModel):
    model_config = ConfigDict(extra="forbid")

    day_index: int = Field(ge=1)
    date: date_t | None = Field(default=None, description="未定具体日期时为空（用户只说「五一」）")
    theme: str | None = None
    rhythm: Rhythm = Field(
        default_factory=lambda: Rhythm(),
        description="作息窗口，一等字段 —— 功能3「我起晚了」的主要修改目标",
    )
    stops: list[Stop] = Field(default_factory=list)


class Rhythm(BaseModel):
    """作息约束。rhythm 是约束，activity.time_window 是事实，校验器负责判二者是否冲突。

    这正是功能3 的因果链：用户说"我起晚了" → agent 发 set_day_rhythm(wake=13:00)
    → 校验器报出"N 个 activity 越界" → agent 逐个修。
    """

    model_config = ConfigDict(extra="forbid")

    wake: time_t = Field(default_factory=lambda: time_t(9, 0))
    sleep: time_t = Field(default_factory=lambda: time_t(23, 0))


# 前向引用解析（Day 引用了定义在其后的 Rhythm）
Day.model_rebuild()


# --------------------------------------------------------------------------
# Constraints
# --------------------------------------------------------------------------


class VehiclePlan(BaseModel):
    """仅 self_drive 时有值。取还车/办证不进时间轴（已砍掉 logistics 类型），
    塞在 constraints 里，由卡片面板在 day 边界渲染。"""

    model_config = ConfigDict(extra="forbid")

    pickup: dict | None = Field(default=None, description="{poi, date, time}")
    dropoff: dict | None = None
    rental_channel: BookingChannel | None = None
    permits: list[PermitRequirement] = Field(default_factory=list)


class PermitRequirement(BaseModel):
    """边防证之类。塔县、白哈巴需要，办证占时间且要提前。"""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(description="如 '边境管理区通行证'")
    where_to_apply: str | None = None
    lead_time_days: int | None = None
    applies_to: list[str] = Field(default_factory=list, description="适用的目的地")
    source_ref: str | None = None


VehiclePlan.model_rebuild()


class Budget(BaseModel):
    model_config = ConfigDict(extra="forbid")

    total: float | None = None
    level: BudgetLevel = BudgetLevel.MID
    per_person_est: float | None = None


class Constraints(BaseModel):
    """用户画像 / 硬约束。缺失项用默认值，并在卡片上标注假设
    （如"按 2 人 / 中等预算估算，可修改"）。"""

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def _accept_name_only_refs(cls, data):
        if not isinstance(data, dict):
            return data
        data = dict(data)
        for key in ("must_go", "must_avoid"):
            values = data.get(key)
            if isinstance(values, list):
                data[key] = [
                    {"name": v} if isinstance(v, str) else v for v in values
                ]
        return data

    origin: str | None = Field(default=None, description="出发城市")
    destination: str | None = Field(
        default=None,
        description="目的地（参数条 chips 用：地图顶栏显示「京都 / 11月2–6 / 2人」）",
    )
    date_range: DateRange | None = None
    travelers: int = Field(default=2, ge=1)
    budget: Budget = Field(default_factory=Budget)
    transport_mode: TripTransport | None = None
    vehicle: VehiclePlan | None = None
    pace: Pace = Pace.NORMAL
    diet: list[str] = Field(default_factory=list, description="忌口 / 偏好")
    must_go: list[PoiRef] = Field(default_factory=list)
    must_avoid: list[PoiRef] = Field(default_factory=list)
    assumptions: list[str] = Field(
        default_factory=list,
        description="模型自行填的默认值说明，前端展示为「按 X 估算，可修改」",
    )


class DateRange(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start: date_t | None = None
    end: date_t | None = None
    note: str | None = Field(default=None, description="如 '五一假期，具体日期待定'")


Constraints.model_rebuild()


# --------------------------------------------------------------------------
# 校验器推导结果（模型禁止写）
# --------------------------------------------------------------------------


class AskUserOption(BaseModel):
    """一个快捷选项。note_hint 是备注框的 placeholder。"""

    model_config = ConfigDict(extra="forbid")

    id: str
    label: str
    note_hint: str | None = None


class AskUserQuestion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str
    multi: bool = False
    options: list[AskUserOption] = Field(default_factory=list)
    note_hint: str | None = None
    #: 输入控件：chips（默认）/ city（城市选择器）/ date（日期选择器）。
    #: 城市、日期这类题光给 chips 不够用，前端按这个字段渲染对应的选择器。
    input: Literal["chips", "city", "date"] = "chips"


class AskUser(BaseModel):
    """ask_user 是消息的一部分，不是工具（docs §4.2）。

    `purpose` 区分这张卡在协作流程里的位置：开场信息收集 / 路线方案确认 /
    冲突抉择 / 其他。服务端用 `outline` 卡做「先给方案、再排行程」的门禁。
    """

    model_config = ConfigDict(extra="forbid")

    ask_id: str | None = None
    intro: str | None = None
    purpose: Literal["opening", "outline", "conflict", "other"] = "other"
    questions: list[AskUserQuestion] = Field(default_factory=list)
    allow_note: bool = True
    allow_skip: bool = True


class AskUserAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question_index: int = 0
    option_ids: list[str] = Field(default_factory=list)
    note: str = ""
    free_text: str | None = None
    #: 选择器（城市/日期）里填的值；和选项、备注分开存，便于模型区分
    value: str | None = None


class ConflictSeverity(StrEnum):
    ERROR = "error"  # 必须修：时间重叠、封路撞期、坐标无来源
    WARNING = "warning"  # 应该修：略超预算、强度过高


class ConflictType(StrEnum):
    DAY_OVERLOAD = "day_overload"  # 当天总时长（活动+路程）超出可用时间
    RHYTHM_VIOLATION = "rhythm_violation"  # 活动越出 rhythm 窗口
    BUDGET_EXCEEDED = "budget_exceeded"
    SEASON_CLOSED = "season_closed"  # 撞 season_closure（五一独库公路）
    TIME_OVERLAP = "time_overlap"
    INSUFFICIENT_TRANSIT = "insufficient_transit"  # 两活动间隔 < 路程时间
    MUST_GO_MISSING = "must_go_missing"
    MISSING_COORD_SOURCE = "missing_coord_source"  # 坐标无 source_ref
    INSUFFICIENT_TRANSIT_INFO = "insufficient_transit_info"  # 长途段缺工具来源的时长
    MISSING_MEAL_BLOCK = "missing_meal_block"  # 当天活动跨度长却没留用餐时间
    # 营业时间（02 §3.3）：只有 verified 证据才会产生这三类冲突
    OPENING_HOURS_CLOSED = "opening_hours_closed"
    OPENING_HOURS_OUTSIDE = "opening_hours_outside"
    OPENING_HOURS_LAST_ENTRY = "opening_hours_last_entry"


class Conflict(BaseModel):
    """校验器输出。结果拼回 tool_result 返回模型 —— 校验不是工具，是自动后处理，
    模型不需要"想起来"去检查。"""

    model_config = ConfigDict(extra="forbid")

    id: str | None = Field(default=None, description="前端稳定 key")
    type: ConflictType
    severity: ConflictSeverity
    day_index: int | None = None
    stop_id: str | None = None
    activity_id: str | None = None
    message: str = Field(description="给人看的话，也是 agent 决定怎么修的依据")
    suggested_fix: str | None = Field(
        default=None,
        description="如 '独库公路 5 月初未开放，改成 6 月还是换赛里木湖？'。"
        "同一冲突自动修 3 轮仍不过 → 把这句话交还用户决定，不许硬改也不许假装冲突不存在",
    )
    ask_user: AskUser | None = Field(
        default=None,
        description="校验器修不好时交还用户的决策题，前端复用提问卡样式",
    )


class DerivedWindow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    first_start: time_t | None = None
    last_end: time_t | None = None
    total_hours: float = 0.0
    transit_hours: float = 0.0


class DayDerived(BaseModel):
    """挂在 Day 上但不属于 Day 定义 —— 单独存，避免模型误以为自己能写。"""

    model_config = ConfigDict(extra="forbid")

    day_index: int
    window: DerivedWindow = Field(default_factory=DerivedWindow)
    load_hours: float = 0.0
    conflicts: list[Conflict] = Field(default_factory=list)


class BookingItem(BaseModel):
    """booking_timeline 的一项：把全程所有需预订项按"应在哪个日期下单"倒排。

    五一的票提前 7 天放，一趟 8 天可能有十来张票，没有这个清单用户必漏。
    校验器已算出 lead_time_days，此清单零额外成本。
    """

    model_config = ConfigDict(extra="forbid")

    id: str | None = None
    order_by: date_t | None = Field(default=None, description="最迟下单日期")
    mode: str | None = Field(default=None, description="flight/train/self_drive，用于前端图标")
    activity_id: str | None = None
    day_index: int | None = None
    title: str
    kind: TicketKind
    channel_hint: str | None = Field(default=None, description="首选渠道，如 '微信公众号：喀纳斯景区'")
    channel_status: str | None = Field(
        default=None, description="verified / clue / unverified；只有 verified 才进开售提醒"
    )
    price_range: tuple[float, float] | None = None
    lead_time_days: int | None = None
    real_name_required: bool = False
    sale_date: date_t | None = Field(default=None, description="开售日期，由代码按规则计算")
    sale_time: str | None = Field(default=None, description="开售时刻 HH:MM")
    sale_hint: str | None = Field(default=None, description="如 '3 月 28 日 20:00 开售，建议提前盯'")


class BudgetSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tickets_total: float = 0.0
    #: 已废弃（01 §10）：住宿收缩为区域级，预算不含住宿，恒为 0。保留字段只为兼容旧快照。
    hotels_total: float = 0.0
    food_est_total: float = 0.0
    transit_est_total: float = 0.0
    grand_total: float = 0.0
    per_person: float = 0.0
    budget_total: float | None = None
    over_budget_by: float = 0.0
    #: 预算不含住宿（01 §9.5、§10）：住宿只排住在哪个地点，不计价
    lodging_included: bool = False


class Derived(BaseModel):
    """校验器的全部推导产物。与 Plan 分开存储/传输，模型看不到也不该改。"""

    model_config = ConfigDict(extra="forbid")

    days: list[DayDerived] = Field(default_factory=list)
    booking_timeline: list[BookingItem] = Field(default_factory=list)
    budget_summary: BudgetSummary = Field(default_factory=BudgetSummary)
    conflicts: list[Conflict] = Field(default_factory=list, description="全行程冲突汇总，按严重度排序")
    ok: bool = True
    today: date_t = Field(default_factory=date_t.today, description="服务端「今天」，用于预订逾期判断")


# --------------------------------------------------------------------------
# 修订历史
# --------------------------------------------------------------------------


class Revision(BaseModel):
    """每次 update_itinerary 留痕。上下文里只留最近 5 条（§4.7），磁盘上完整保留。"""

    model_config = ConfigDict(extra="forbid")

    version: int
    turn_seq: int | None = None
    summary: str | None = Field(default=None, description="如 '第3天 wake 09:00→13:00，后移 4 个活动'")
    user_request: str | None = Field(default=None, description="触发本次修订的用户原话")
    op_count: int = 0
    changed_stop_ids: list[str] = Field(default_factory=list)
    changed_activity_ids: list[str] = Field(default_factory=list)
    created_at: str | None = None


# --------------------------------------------------------------------------
# Trip
# --------------------------------------------------------------------------


class Trip(BaseModel):
    """服务端持久状态，前端订阅。对话是协商通道，地图是渲染层，两者都读这一份。"""

    model_config = ConfigDict(extra="forbid")

    trip_id: str
    title: str | None = None
    version: int = 0
    constraints: Constraints = Field(default_factory=Constraints)
    days: list[Day] = Field(default_factory=list)
    revision_log: list[Revision] = Field(default_factory=list)
    created_at: str | None = None
    updated_at: str | None = None

    @model_validator(mode="after")
    def _normalize_order(self):
        """Array order is authoritative for display sequence.

        LLMs frequently omit seq (default 0), which made every map marker show
        "0".  Normalize on every validation, including reads from old rows.
        """
        for i, day in enumerate(self.days, start=1):
            day.day_index = i
            for j, stop in enumerate(day.stops, start=1):
                stop.seq = j
                for k, act in enumerate(stop.activities, start=1):
                    act.seq = k
        return self

    # ---- 便捷遍历 ----

    def iter_stops(self):
        for day in self.days:
            for stop in day.stops:
                yield day, stop

    def iter_activities(self):
        for day in self.days:
            for stop in day.stops:
                for act in stop.activities:
                    yield day, stop, act

    def find_stop(self, stop_id: str) -> tuple[Day, Stop] | None:
        for day, stop in self.iter_stops():
            if stop.stop_id == stop_id:
                return day, stop
        return None

    def find_activity(self, activity_id: str) -> tuple[Day, Stop, Activity] | None:
        for day, stop, act in self.iter_activities():
            if act.activity_id == activity_id:
                return day, stop, act
        return None


# --------------------------------------------------------------------------
# 地图层契约（docs/research/mindtrip/06 §3.4、§13.1）
#
# 这三个模型**不进 Trip 文档**：RouteLeg 落 route_legs 表，PlaceRef 用于浮卡与
# 候选点，TripConstraints 是参数条 chips 的 REST 入参（PATCH constraints）。
# --------------------------------------------------------------------------


class PlaceRef(BaseModel):
    """浮卡 / 候选点 / 收藏共用的轻量地点引用（maps 到前端 PlaceDetail）。"""

    model_config = ConfigDict(extra="forbid")

    poi_id: str
    name: str
    category: str = "place"
    city: str | None = None
    address: str | None = None
    lat: float | None = None
    lng: float | None = None
    stop_id: str | None = None
    day_index: int | None = None
    in_trip: bool = False


class RouteLeg(BaseModel):
    """相邻 stop 之间的一段路程（P0「距离行」的唯一事实来源）。

    没有真实数据时 `distance_m` / `duration_min` 保持 None，前端显示
    「距离待算」。**禁止**用直线距离假装高德路径 —— 04-replicate 的教训。
    """

    model_config = ConfigDict(extra="forbid")

    leg_id: str
    trip_id: str | None = None
    day_index: int | None = None
    from_stop_id: str
    to_stop_id: str
    from_name: str | None = None
    to_name: str | None = None
    mode: Literal["walk", "drive", "bike", "transit", "train", "flight", "ferry"] = "drive"
    distance_m: int | None = None
    duration_min: int | None = None
    polyline: list[list[float]] | None = Field(
        default=None, description="[[lng, lat], ...]；可选，不写进 Trip 文档"
    )
    source: Literal["amap", "estimate"] | None = None
    fetched_at: str | None = None
    disclaimer: bool = False


class TripConstraints(BaseModel):
    """参数条 chips 的 REST 入参（地图顶栏「京都 / 11月2–6 / 2人 / ¥8k / 轻松」）。"""

    model_config = ConfigDict(extra="forbid")

    destination: str | None = None
    origin: str | None = None
    start_date: date_t | None = None
    end_date: date_t | None = None
    travelers: int | None = Field(default=None, ge=1, le=30)
    budget: float | None = Field(default=None, ge=0)
    pace: Literal["relaxed", "normal", "packed"] | None = None
    sync_days: Literal["shift", "trim"] | None = Field(
        default=None,
        description="日期变化时如何处理已有天：shift=按新起始日平移，trim=删除超出新结束日的天",
    )


class TripWithDerived(BaseModel):
    """API 返回给前端的形态：Plan + 校验器推导结果。"""

    model_config = ConfigDict(extra="forbid")

    trip: Trip
    derived: Derived = Field(default_factory=Derived)
