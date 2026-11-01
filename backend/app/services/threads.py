"""同行人评论 + `@助手` threads（P2-1）。

边界（mindtrip/06 §12）：
- 一个 trip 下按主题开 thread，**评论不触发 AI**，只有 `@助手` 才触发。
- 不是 IM：没有已读、没有在线状态、没有推送。
- `@助手` 的回复只读 Trip 事实（天数/地点/预算/预订），改行程仍然只能走主对话或抽屉。
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from app.config import Settings
from app.core.validator import validate_and_derive
from app.db import Database
from app.llm.providers import ProviderError, build_provider
from app.schemas.plan import Trip
from app.schemas.places import Thread, ThreadComment

MENTION_RE = ("@助手", "@assistant", "@trace", "@Trace")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _to_comment(row: dict[str, Any]) -> ThreadComment:
    return ThreadComment(
        comment_id=row["comment_id"],
        thread_id=row["thread_id"],
        author=row.get("author") or "me",  # type: ignore[arg-type]
        body=row.get("body") or "",
        mentions_assistant=bool(row.get("mentions_assistant")),
        created_at=row.get("created_at"),
    )


class ThreadService:
    def __init__(self, settings: Settings, db: Database):
        self.settings = settings
        self.db = db

    async def list(self, trip_id: str) -> list[Thread]:
        rows = await self.db.list_threads(trip_id)
        out: list[Thread] = []
        for row in rows:
            comments = await self.db.list_comments(row["thread_id"])
            out.append(
                Thread(
                    thread_id=row["thread_id"],
                    trip_id=row["trip_id"],
                    title=row["title"],
                    created_at=row.get("created_at"),
                    comments=[_to_comment(c) for c in comments],
                )
            )
        return out

    async def get(self, thread_id: str) -> Thread | None:
        row = await self.db.get_thread(thread_id)
        if row is None:
            return None
        comments = await self.db.list_comments(thread_id)
        return Thread(
            thread_id=row["thread_id"],
            trip_id=row["trip_id"],
            title=row["title"],
            created_at=row.get("created_at"),
            comments=[_to_comment(c) for c in comments],
        )

    async def create(self, trip_id: str, title: str) -> Thread:
        thread_id = "thr_" + uuid.uuid4().hex[:10]
        await self.db.create_thread(thread_id, trip_id, title.strip()[:80])
        thread = await self.get(thread_id)
        assert thread is not None
        return thread

    async def comment(
        self, trip: Trip, thread_id: str, body: str, author: str = "me"
    ) -> tuple[ThreadComment, ThreadComment | None]:
        text = body.strip()
        mentions = any(token in text for token in MENTION_RE)
        comment_id = "cmt_" + uuid.uuid4().hex[:10]
        await self.db.add_comment(comment_id, thread_id, author, text, mentions)
        comment = _to_comment(await self._require_comment(comment_id))
        if not mentions:
            return comment, None
        reply_text = await self._assistant_reply(trip, thread_id, text)
        reply_id = "cmt_" + uuid.uuid4().hex[:10]
        await self.db.add_comment(reply_id, thread_id, "assistant", reply_text, False)
        return comment, _to_comment(await self._require_comment(reply_id))

    async def _require_comment(self, comment_id: str) -> dict[str, Any]:
        row = await self.db.get_comment(comment_id)
        if row is None:  # 理论上不会发生；发生也不能让线程挂掉
            return {
                "comment_id": comment_id,
                "thread_id": "",
                "author": "me",
                "body": "",
                "mentions_assistant": False,
                "created_at": _now(),
            }
        return row

    # ------------------------------------------------------------------
    # @助手 回复
    # ------------------------------------------------------------------
    async def _assistant_reply(self, trip: Trip, thread_id: str, text: str) -> str:
        facts = self._facts(trip)
        llm = await self._try_llm(trip, thread_id, text, facts)
        if llm:
            return llm
        return self._rule_reply(trip, text, facts)

    def _facts(self, trip: Trip) -> dict[str, Any]:
        derived = validate_and_derive(
            trip, self.settings.demo_today if self.settings.demo_mode else None
        )
        stops = [stop for _day, stop in trip.iter_stops()]
        return {
            "title": trip.title or "未命名行程",
            "version": trip.version,
            "days": len(trip.days),
            "stops": len(stops),
            "travelers": trip.constraints.travelers,
            "origin": trip.constraints.origin,
            "destination": trip.constraints.destination,
            "grand_total": derived.budget_summary.grand_total,
            "per_person": derived.budget_summary.per_person,
            "budget": derived.budget_summary.budget_total,
            "booking": len(derived.booking_timeline),
            "conflicts": len(derived.conflicts),
            "errors": sum(1 for c in derived.conflicts if c.severity.value == "error"),
            "first_day": trip.days[0].day_index if trip.days else None,
            "last_day": trip.days[-1].day_index if trip.days else None,
            "places": "、".join(stop.poi.name.split(" · ")[-1] for stop in stops[:8]),
        }

    async def _try_llm(self, trip: Trip, thread_id: str, text: str, facts: dict[str, Any]) -> str | None:
        if not self.settings.llm_configured:
            return None
        try:
            provider = build_provider(self.settings, self.settings.default_provider)
        except Exception:  # noqa: BLE001
            return None
        context = (
            f"行程：{facts['title']} · v{facts['version']} · {facts['days']} 天 · {facts['stops']} 个地点 · "
            f"{facts['travelers']} 人 · 预算约 ¥{facts['grand_total']:,.0f}（人均 ¥{facts['per_person']:,.0f}）· "
            f"待预订 {facts['booking']} 项 · 校验冲突 {facts['conflicts']} 项。"
            f"主要地点：{facts['places']}。"
        )
        messages = [
            {
                "role": "system",
                "content": (
                    "你是行程的同行助手。只根据给定行程事实回答，最多 3 句、120 字以内。"
                    "不要编造营业时间/价格/评分：只能引用行程里已核实的数据，没有就直说「待核实」。不能修改行程——需要改动时提示用户去主对话或行程抽屉。"
                ),
            },
            {"role": "user", "content": context + "\n\n同行人提问：" + text},
        ]
        try:
            response = await provider.chat(messages, [], self.settings.default_model)
            content = (response.content or "").strip()
            return content[:400] or None
        except ProviderError:
            return None
        except Exception:  # noqa: BLE001
            return None

    def _rule_reply(self, trip: Trip, text: str, facts: dict[str, Any]) -> str:
        head = (
            f"（未配置模型，以下按行程事实直答）{facts['title']} v{facts['version']}："
            f"{facts['days']} 天 · {facts['stops']} 个地点 · {facts['travelers']} 人。"
        )
        answer: str
        if any(key in text for key in ("预算", "多少钱", "花费", "人均")):
            answer = f"当前估算合计约 ¥{facts['grand_total']:,.0f}，人均 ¥{facts['per_person']:,.0f}。"
            if facts["budget"]:
                answer += f" 预算上限 ¥{facts['budget']:,.0f}。"
        elif any(key in text for key in ("订", "门票", "票")):
            answer = f"待预订项共 {facts['booking']} 条，按最迟下单日期排在「预订」抽屉里。"
        elif any(key in text for key in ("吃饭", "吃", "餐", "餐厅")):
            answer = "餐饮在行程里只是时间块；具体吃什么请在地点详情·美食段按需查看，不写进行程文档。"
        elif any(key in text for key in ("冲突", "检查", "校验", "问题")):
            answer = f"校验发现 {facts['conflicts']} 项冲突，其中 {facts['errors']} 项是错误。"
        elif any(key in text for key in ("路线", "顺序", "几天", "哪天")):
            answer = (
                f"今天是 Day {facts['first_day']}–Day {facts['last_day']}，主要地点：{facts['places']}。"
                "打开行程抽屉可以按天查看与拖拽排序。"
            )
        else:
            answer = f"主要地点：{facts['places']}。要改行程请在主对话里说明，或打开行程抽屉手动调整。"
        return head + answer + " 评论不会自动改行程。"
