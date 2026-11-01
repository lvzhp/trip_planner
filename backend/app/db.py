"""Persistence layer.

Docs §6.3 specifies three tables and PostgreSQL.  For zero-setup local
development this module also supports SQLite; both backends expose the same
small repository interface, and the plan is stored as JSONB on PostgreSQL /
JSON text on SQLite.

Tables
------
trips          current plan + monotonic event sequence
turns          one agent turn: messages, tool calls/results, events, plan snapshot
tool_cache     TTL cache for read-only tools
route_legs     距离行（mindtrip/06 §5）：相邻 stop 之间的一段路程
saved_places   收藏 / 想去层（§11）
trip_threads   同行人评论话题（P2-1）
thread_comments 话题下的评论；`@助手` 的回复也是评论
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import aiosqlite
import asyncpg

from app.config import Settings
from app.schemas.events import SseEvent
from app.schemas.plan import Trip

SCHEMA_SQLITE = """
CREATE TABLE IF NOT EXISTS trips (
    trip_id     TEXT PRIMARY KEY,
    user_id     TEXT,
    title       TEXT,
    plan        TEXT NOT NULL,
    version     INTEGER NOT NULL DEFAULT 0,
    last_seq    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT,
    updated_at  TEXT
);
CREATE TABLE IF NOT EXISTS turns (
    turn_id       TEXT PRIMARY KEY,
    trip_id       TEXT NOT NULL,
    seq           INTEGER NOT NULL DEFAULT 0,
    messages      TEXT,
    tool_calls    TEXT,
    tool_results  TEXT,
    events        TEXT,
    model         TEXT,
    plan_snapshot TEXT,
    status        TEXT NOT NULL DEFAULT 'running',
    error         TEXT,
    created_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_turns_trip ON turns(trip_id, created_at);
CREATE TABLE IF NOT EXISTS tool_cache (
    cache_key   TEXT PRIMARY KEY,
    tool_name   TEXT NOT NULL,
    params_hash TEXT,
    result      TEXT NOT NULL,
    fetched_at  TEXT,
    expires_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_cache_expiry ON tool_cache(expires_at);
CREATE TABLE IF NOT EXISTS route_legs (
    trip_id      TEXT NOT NULL,
    leg_id       TEXT NOT NULL,
    day_index    INTEGER,
    from_stop_id TEXT NOT NULL,
    to_stop_id   TEXT NOT NULL,
    mode         TEXT NOT NULL,
    distance_m   INTEGER,
    duration_min INTEGER,
    polyline     TEXT,
    source       TEXT,
    fetched_at   TEXT,
    PRIMARY KEY (trip_id, leg_id)
);
CREATE TABLE IF NOT EXISTS saved_places (
    user_id    TEXT NOT NULL,
    poi_id     TEXT NOT NULL,
    name       TEXT NOT NULL,
    category   TEXT,
    lat        REAL,
    lng        REAL,
    city       TEXT,
    address    TEXT,
    note       TEXT,
    created_at TEXT,
    PRIMARY KEY (user_id, poi_id)
);
CREATE TABLE IF NOT EXISTS trip_threads (
    thread_id  TEXT PRIMARY KEY,
    trip_id    TEXT NOT NULL,
    title      TEXT NOT NULL,
    created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_threads_trip ON trip_threads(trip_id, created_at);
CREATE TABLE IF NOT EXISTS thread_comments (
    comment_id         TEXT PRIMARY KEY,
    thread_id          TEXT NOT NULL,
    author             TEXT NOT NULL,
    body               TEXT NOT NULL,
    mentions_assistant INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT
);
CREATE TABLE IF NOT EXISTS source_registry (
    source_ref   TEXT PRIMARY KEY,
    trip_id      TEXT,
    tool         TEXT NOT NULL,
    origin       TEXT NOT NULL,
    url          TEXT,
    title        TEXT,
    published_at TEXT,
    snippet      TEXT,
    fetched_at   TEXT NOT NULL,
    authority    INTEGER,
    turn_id      TEXT,
    agent        TEXT NOT NULL DEFAULT 'main',
    payload      TEXT
);
CREATE INDEX IF NOT EXISTS idx_sources_trip ON source_registry(trip_id);
CREATE INDEX IF NOT EXISTS idx_sources_tool ON source_registry(tool);
CREATE INDEX IF NOT EXISTS idx_comments_thread ON thread_comments(thread_id, created_at);
"""

SCHEMA_POSTGRES = """
CREATE TABLE IF NOT EXISTS trips (
    trip_id     TEXT PRIMARY KEY,
    user_id     TEXT,
    title       TEXT,
    plan        JSONB NOT NULL,
    version     INTEGER NOT NULL DEFAULT 0,
    last_seq    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT,
    updated_at  TEXT
);
CREATE TABLE IF NOT EXISTS turns (
    turn_id       TEXT PRIMARY KEY,
    trip_id       TEXT NOT NULL,
    seq           INTEGER NOT NULL DEFAULT 0,
    messages      JSONB,
    tool_calls    JSONB,
    tool_results  JSONB,
    events        JSONB,
    model         TEXT,
    plan_snapshot JSONB,
    status        TEXT NOT NULL DEFAULT 'running',
    error         TEXT,
    created_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_turns_trip ON turns(trip_id, created_at);
CREATE TABLE IF NOT EXISTS tool_cache (
    cache_key   TEXT PRIMARY KEY,
    tool_name   TEXT NOT NULL,
    params_hash TEXT,
    result      JSONB NOT NULL,
    fetched_at  TEXT,
    expires_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_cache_expiry ON tool_cache(expires_at);
CREATE TABLE IF NOT EXISTS route_legs (
    trip_id      TEXT NOT NULL,
    leg_id       TEXT NOT NULL,
    day_index    INTEGER,
    from_stop_id TEXT NOT NULL,
    to_stop_id   TEXT NOT NULL,
    mode         TEXT NOT NULL,
    distance_m   INTEGER,
    duration_min INTEGER,
    polyline     JSONB,
    source       TEXT,
    fetched_at   TEXT,
    PRIMARY KEY (trip_id, leg_id)
);
CREATE TABLE IF NOT EXISTS saved_places (
    user_id    TEXT NOT NULL,
    poi_id     TEXT NOT NULL,
    name       TEXT NOT NULL,
    category   TEXT,
    lat        DOUBLE PRECISION,
    lng        DOUBLE PRECISION,
    city       TEXT,
    address    TEXT,
    note       TEXT,
    created_at TEXT,
    PRIMARY KEY (user_id, poi_id)
);
CREATE TABLE IF NOT EXISTS trip_threads (
    thread_id  TEXT PRIMARY KEY,
    trip_id    TEXT NOT NULL,
    title      TEXT NOT NULL,
    created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_threads_trip ON trip_threads(trip_id, created_at);
CREATE TABLE IF NOT EXISTS thread_comments (
    comment_id         TEXT PRIMARY KEY,
    thread_id          TEXT NOT NULL,
    author             TEXT NOT NULL,
    body               TEXT NOT NULL,
    mentions_assistant BOOLEAN NOT NULL DEFAULT FALSE,
    created_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_comments_thread ON thread_comments(thread_id, created_at);
CREATE TABLE IF NOT EXISTS source_registry (
    source_ref   TEXT PRIMARY KEY,
    trip_id      TEXT,
    tool         TEXT NOT NULL,
    origin       TEXT NOT NULL,
    url          TEXT,
    title        TEXT,
    published_at TEXT,
    snippet      TEXT,
    fetched_at   TEXT NOT NULL,
    authority    INTEGER,
    turn_id      TEXT,
    agent        TEXT NOT NULL DEFAULT 'main',
    payload      JSONB
);
CREATE INDEX IF NOT EXISTS idx_sources_trip ON source_registry(trip_id);
CREATE INDEX IF NOT EXISTS idx_sources_tool ON source_registry(tool);
"""


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _loads(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    return json.loads(value)


def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


class Database:
    """Thin async repository with a PostgreSQL and SQLite implementation."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.backend = "sqlite" if settings.is_sqlite else "postgres"
        self._sqlite: aiosqlite.Connection | None = None
        self._pg: asyncpg.Pool | None = None
        self._sqlite_lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------
    async def connect(self) -> None:
        if self.settings.is_sqlite:
            path = self.settings.sqlite_path
            self._sqlite = await aiosqlite.connect(path)
            self._sqlite.row_factory = aiosqlite.Row
            await self._sqlite.execute("PRAGMA journal_mode=WAL")
            await self._sqlite.execute("PRAGMA foreign_keys=ON")
            await self._sqlite.executescript(SCHEMA_SQLITE)
            await self._sqlite.commit()
        else:
            dsn = self.settings.database_url.replace("postgresql+asyncpg://", "postgresql://")
            self._pg = await asyncpg.create_pool(
                dsn=dsn,
                min_size=self.settings.db_min_size,
                max_size=self.settings.db_max_size,
                init=self._init_pg_connection,
            )
            assert self._pg is not None
            async with self._pg.acquire() as conn:
                await conn.execute(SCHEMA_POSTGRES)

    @staticmethod
    async def _init_pg_connection(conn: asyncpg.Connection) -> None:
        await conn.set_type_codec(
            "jsonb",
            encoder=lambda v: json.dumps(v, ensure_ascii=False, default=str),
            decoder=json.loads,
            schema="pg_catalog",
        )

    async def close(self) -> None:
        if self._sqlite is not None:
            await self._sqlite.close()
            self._sqlite = None
        if self._pg is not None:
            await self._pg.close()
            self._pg = None

    # ------------------------------------------------------------------
    # trips
    # ------------------------------------------------------------------
    async def upsert_trip(self, trip: Trip, last_seq: int | None = None) -> None:
        now = utcnow()
        payload = trip.model_dump(mode="json")
        title = trip.title
        created_at = trip.created_at or now
        updated_at = trip.updated_at or now
        async with self._write() as db:
            if self.backend == "sqlite":
                await db.execute(
                    """INSERT INTO trips (trip_id,user_id,title,plan,version,last_seq,created_at,updated_at)
                       VALUES (?,?,?,?,?,?,?,?)
                       ON CONFLICT(trip_id) DO UPDATE SET
                         title=excluded.title, plan=excluded.plan, version=excluded.version,
                         last_seq=CASE WHEN ? IS NULL THEN trips.last_seq ELSE excluded.last_seq END,
                         updated_at=excluded.updated_at""",
                    (
                        trip.trip_id,
                        None,
                        title,
                        _dumps(payload),
                        trip.version,
                        last_seq or 0,
                        created_at,
                        updated_at,
                        last_seq,
                    ),
                )
                await db.commit()
            else:
                await db.execute(
                    """INSERT INTO trips (trip_id,user_id,title,plan,version,last_seq,created_at,updated_at)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                       ON CONFLICT(trip_id) DO UPDATE SET
                         title=EXCLUDED.title, plan=EXCLUDED.plan, version=EXCLUDED.version,
                         last_seq=CASE WHEN $9::int IS NULL THEN trips.last_seq ELSE EXCLUDED.last_seq END,
                         updated_at=EXCLUDED.updated_at""",
                    trip.trip_id,
                    None,
                    title,
                    payload,
                    trip.version,
                    last_seq or 0,
                    created_at,
                    updated_at,
                    last_seq,
                )

    async def get_trip(self, trip_id: str) -> Trip | None:
        async with self._read() as db:
            if self.backend == "sqlite":
                cur = await db.execute("SELECT plan FROM trips WHERE trip_id=?", (trip_id,))
                row = await cur.fetchone()
                return Trip.model_validate(_loads(row["plan"])) if row else None
            row = await db.fetchrow("SELECT plan FROM trips WHERE trip_id=$1", trip_id)
            return Trip.model_validate(row["plan"]) if row else None

    async def get_trip_meta(self, trip_id: str) -> dict[str, Any] | None:
        async with self._read() as db:
            if self.backend == "sqlite":
                cur = await db.execute(
                    "SELECT trip_id,title,version,last_seq,created_at,updated_at FROM trips WHERE trip_id=?",
                    (trip_id,),
                )
                row = await cur.fetchone()
                return dict(row) if row else None
            row = await db.fetchrow(
                "SELECT trip_id,title,version,last_seq,created_at,updated_at FROM trips WHERE trip_id=$1",
                trip_id,
            )
            return dict(row) if row else None

    async def list_trips(self) -> list[dict[str, Any]]:
        async with self._read() as db:
            if self.backend == "sqlite":
                cur = await db.execute(
                    "SELECT trip_id,title,plan,version,last_seq,created_at,updated_at FROM trips ORDER BY updated_at DESC"
                )
                rows = await cur.fetchall()
                return [
                    {
                        **{k: r[k] for k in ("trip_id", "title", "version", "last_seq", "created_at", "updated_at")},
                        "plan": _loads(r["plan"]),
                    }
                    for r in rows
                ]
            rows = await db.fetch(
                "SELECT trip_id,title,plan,version,last_seq,created_at,updated_at FROM trips ORDER BY updated_at DESC"
            )
            return [dict(r) for r in rows]

    async def rename_trip(self, trip_id: str, title: str) -> None:
        async with self._write() as db:
            if self.backend == "sqlite":
                await db.execute(
                    "UPDATE trips SET title=?, updated_at=? WHERE trip_id=?",
                    (title, utcnow(), trip_id),
                )
                await db.commit()
            else:
                await db.execute(
                    "UPDATE trips SET title=$1, updated_at=$2 WHERE trip_id=$3",
                    title,
                    utcnow(),
                    trip_id,
                )

    async def reserve_seq(self, trip_id: str) -> int:
        """Atomically reserve the next per-trip event sequence number."""
        async with self._write() as db:
            if self.backend == "sqlite":
                cur = await db.execute(
                    "UPDATE trips SET last_seq=last_seq+1 WHERE trip_id=? RETURNING last_seq",
                    (trip_id,),
                )
                row = await cur.fetchone()
                await db.commit()
                return int(row["last_seq"])
            row = await db.fetchrow(
                "UPDATE trips SET last_seq=last_seq+1 WHERE trip_id=$1 RETURNING last_seq", trip_id
            )
            return int(row["last_seq"])

    # ------------------------------------------------------------------
    # turns
    # ------------------------------------------------------------------
    async def create_turn(
        self,
        trip_id: str,
        model: str,
        messages: list[dict[str, Any]] | None = None,
        turn_id: str | None = None,
    ) -> str:
        turn_id = turn_id or uuid.uuid4().hex
        now = utcnow()
        async with self._write() as db:
            if self.backend == "sqlite":
                await db.execute(
                    """INSERT INTO turns (turn_id,trip_id,seq,messages,tool_calls,tool_results,events,model,status,created_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    (
                        turn_id,
                        trip_id,
                        1,
                        _dumps(messages or []),
                        "[]",
                        "[]",
                        "[]",
                        model,
                        "running",
                        now,
                    ),
                )
                await db.commit()
            else:
                await db.execute(
                    """INSERT INTO turns (turn_id,trip_id,seq,messages,tool_calls,tool_results,events,model,status,created_at)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)""",
                    turn_id,
                    trip_id,
                    1,
                    messages or [],
                    [],
                    [],
                    [],
                    model,
                    "running",
                    now,
                )
        return turn_id

    async def append_event(self, turn_id: str, event: SseEvent) -> None:
        async with self._write() as db:
            if self.backend == "sqlite":
                cur = await db.execute("SELECT events FROM turns WHERE turn_id=?", (turn_id,))
                row = await cur.fetchone()
                events = _loads(row["events"]) if row else []
                events.append(event.model_dump(mode="json"))
                await db.execute(
                    "UPDATE turns SET events=? WHERE turn_id=?",
                    (_dumps(events), turn_id),
                )
                await db.commit()
            else:
                row = await db.fetchrow("SELECT events FROM turns WHERE turn_id=$1", turn_id)
                events = list(row["events"] or []) if row else []
                events.append(event.model_dump(mode="json"))
                await db.execute(
                    "UPDATE turns SET events=$1 WHERE turn_id=$2",
                    events,
                    turn_id,
                )

    async def finish_turn(
        self,
        turn_id: str,
        *,
        messages: list[dict[str, Any]] | None = None,
        tool_calls: list[dict[str, Any]] | None = None,
        tool_results: list[dict[str, Any]] | None = None,
        plan_snapshot: dict[str, Any] | None = None,
        status: str = "done",
        error: str | None = None,
    ) -> None:
        async with self._write() as db:
            if self.backend == "sqlite":
                await db.execute(
                    """UPDATE turns SET
                         messages=COALESCE(?,messages),
                         tool_calls=COALESCE(?,tool_calls),
                         tool_results=COALESCE(?,tool_results),
                         plan_snapshot=COALESCE(?,plan_snapshot),
                         status=?, error=?
                       WHERE turn_id=?""",
                    (
                        _dumps(messages) if messages is not None else None,
                        _dumps(tool_calls) if tool_calls is not None else None,
                        _dumps(tool_results) if tool_results is not None else None,
                        _dumps(plan_snapshot) if plan_snapshot is not None else None,
                        status,
                        error,
                        turn_id,
                    ),
                )
                await db.commit()
            else:
                await db.execute(
                    """UPDATE turns SET
                         messages=COALESCE($1,messages),
                         tool_calls=COALESCE($2,tool_calls),
                         tool_results=COALESCE($3,tool_results),
                         plan_snapshot=COALESCE($4,plan_snapshot),
                         status=$5, error=$6
                       WHERE turn_id=$7""",
                    messages,
                    tool_calls,
                    tool_results,
                    plan_snapshot,
                    status,
                    error,
                    turn_id,
                )

    async def get_events_after(self, trip_id: str, after_seq: int) -> list[SseEvent]:
        async with self._read() as db:
            if self.backend == "sqlite":
                cur = await db.execute(
                    "SELECT events FROM turns WHERE trip_id=? ORDER BY created_at, rowid", (trip_id,)
                )
                rows = await cur.fetchall()
            else:
                rows = await db.fetch(
                    "SELECT events FROM turns WHERE trip_id=$1 ORDER BY created_at, turn_id", trip_id
                )
        out: list[SseEvent] = []
        for row in rows:
            for raw in _loads(row["events"]) or []:
                if int(raw.get("seq", 0)) > after_seq:
                    out.append(SseEvent.model_validate(raw))
        out.sort(key=lambda e: e.seq)
        return out

    async def list_turns(self, trip_id: str) -> list[dict[str, Any]]:
        async with self._read() as db:
            if self.backend == "sqlite":
                cur = await db.execute(
                    "SELECT turn_id,trip_id,seq,messages,tool_calls,tool_results,events,model,plan_snapshot,status,error,created_at FROM turns WHERE trip_id=? ORDER BY created_at, rowid",
                    (trip_id,),
                )
                rows = await cur.fetchall()
                return [
                    {
                        **{k: r[k] for k in ("turn_id", "trip_id", "seq", "model", "status", "error", "created_at")},
                        "messages": _loads(r["messages"]),
                        "tool_calls": _loads(r["tool_calls"]),
                        "tool_results": _loads(r["tool_results"]),
                        "events": _loads(r["events"]),
                        "plan_snapshot": _loads(r["plan_snapshot"]),
                    }
                    for r in rows
                ]
            rows = await db.fetch(
                "SELECT turn_id,trip_id,seq,messages,tool_calls,tool_results,events,model,plan_snapshot,status,error,created_at FROM turns WHERE trip_id=$1 ORDER BY created_at, turn_id",
                trip_id,
            )
            return [dict(r) for r in rows]

    async def find_snapshot(self, trip_id: str, version: int) -> dict[str, Any] | None:
        async with self._read() as db:
            if self.backend == "sqlite":
                cur = await db.execute(
                    "SELECT plan_snapshot FROM turns WHERE trip_id=? AND plan_snapshot IS NOT NULL ORDER BY created_at DESC, rowid DESC",
                    (trip_id,),
                )
                rows = await cur.fetchall()
            else:
                rows = await db.fetch(
                    "SELECT plan_snapshot FROM turns WHERE trip_id=$1 AND plan_snapshot IS NOT NULL ORDER BY created_at DESC, turn_id DESC",
                    trip_id,
                )
        for row in rows:
            snap = _loads(row["plan_snapshot"])
            if snap and int(snap.get("version", -1)) == version:
                return snap
        return None

    # ------------------------------------------------------------------
    # tool cache
    # ------------------------------------------------------------------
    @staticmethod
    def _cache_key(tool: str, params: dict[str, Any]) -> str:
        import hashlib

        raw = json.dumps(params, sort_keys=True, ensure_ascii=False, default=str)
        return f"{tool}:{hashlib.sha256(raw.encode()).hexdigest()}"

    async def cache_get(self, tool: str, params: dict[str, Any]) -> dict[str, Any] | None:
        key = self._cache_key(tool, params)
        now = utcnow()
        async with self._read() as db:
            if self.backend == "sqlite":
                cur = await db.execute(
                    "SELECT result,expires_at FROM tool_cache WHERE cache_key=? AND expires_at>?",
                    (key, now),
                )
                row = await cur.fetchone()
                return _loads(row["result"]) if row else None
            row = await db.fetchrow(
                "SELECT result,expires_at FROM tool_cache WHERE cache_key=$1 AND expires_at>$2",
                key,
                now,
            )
            return row["result"] if row else None

    async def cache_set(
        self, tool: str, params: dict[str, Any], result: dict[str, Any], ttl_seconds: int
    ) -> None:
        key = self._cache_key(tool, params)
        now = datetime.now(timezone.utc)
        expires = (now + timedelta(seconds=ttl_seconds)).isoformat()
        import hashlib

        params_hash = hashlib.sha256(
            json.dumps(params, sort_keys=True, ensure_ascii=False, default=str).encode()
        ).hexdigest()
        async with self._write() as db:
            if self.backend == "sqlite":
                await db.execute(
                    """INSERT INTO tool_cache (cache_key,tool_name,params_hash,result,fetched_at,expires_at)
                       VALUES (?,?,?,?,?,?)
                       ON CONFLICT(cache_key) DO UPDATE SET
                         result=excluded.result,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at""",
                    (key, tool, params_hash, _dumps(result), now.isoformat(), expires),
                )
                await db.commit()
            else:
                await db.execute(
                    """INSERT INTO tool_cache (cache_key,tool_name,params_hash,result,fetched_at,expires_at)
                       VALUES ($1,$2,$3,$4,$5,$6)
                       ON CONFLICT(cache_key) DO UPDATE SET
                         result=EXCLUDED.result,fetched_at=EXCLUDED.fetched_at,expires_at=EXCLUDED.expires_at""",
                    key,
                    tool,
                    params_hash,
                    result,
                    now.isoformat(),
                    expires,
                )

    async def cache_cleanup(self) -> None:
        async with self._write() as db:
            if self.backend == "sqlite":
                await db.execute("DELETE FROM tool_cache WHERE expires_at<?", (utcnow(),))
                await db.commit()
            else:
                await db.execute("DELETE FROM tool_cache WHERE expires_at<$1", utcnow())

    # ------------------------------------------------------------------
    # source registry（来源登记簿 · new-plan/01 §9.1、02 §5）
    # ------------------------------------------------------------------
    @staticmethod
    def _source_row(entry: dict[str, Any]) -> tuple:
        return (
            entry["source_ref"],
            entry.get("trip_id"),
            entry.get("tool") or "",
            entry.get("origin") or "",
            entry.get("url"),
            entry.get("title"),
            entry.get("published_at"),
            entry.get("snippet"),
            entry.get("fetched_at") or utcnow(),
            entry.get("authority"),
            entry.get("turn_id"),
            entry.get("agent") or "main",
            _dumps(entry.get("payload")) if entry.get("payload") is not None else None,
        )

    async def record_sources(self, entries: list[dict[str, Any]]) -> None:
        """把工具真实发出过的 source_ref 记进登记簿。

        同一个 ref 重复登记时保留第一次的 `fetched_at`，只把 trip_id/turn_id/agent
        这些"谁在什么时候用过"的信息补全 —— 登记簿是 append 语义的证据表，
        不能因为第二次调用就改写第一次的事实。
        """
        if not entries:
            return
        rows = [self._source_row(e) for e in entries]
        async with self._write() as db:
            if self.backend == "sqlite":
                for row in rows:
                    await db.execute(
                        """INSERT INTO source_registry
                           (source_ref,trip_id,tool,origin,url,title,published_at,snippet,fetched_at,authority,turn_id,agent,payload)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                           ON CONFLICT(source_ref) DO UPDATE SET
                             trip_id=COALESCE(excluded.trip_id,source_registry.trip_id),
                             turn_id=COALESCE(excluded.turn_id,source_registry.turn_id),
                             agent=excluded.agent,
                             payload=COALESCE(excluded.payload,source_registry.payload)""",
                        row,
                    )
                await db.commit()
            else:
                for row in rows:
                    payload = _loads(row[12]) if row[12] else None
                    await db.execute(
                        """INSERT INTO source_registry
                           (source_ref,trip_id,tool,origin,url,title,published_at,snippet,fetched_at,authority,turn_id,agent,payload)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                           ON CONFLICT (source_ref) DO UPDATE SET
                             trip_id=COALESCE(EXCLUDED.trip_id,source_registry.trip_id),
                             turn_id=COALESCE(EXCLUDED.turn_id,source_registry.turn_id),
                             agent=EXCLUDED.agent,
                             payload=COALESCE(EXCLUDED.payload,source_registry.payload)""",
                        row[0], row[1], row[2], row[3], row[4], row[5], row[6],
                        row[7], row[8], row[9], row[10], row[11], payload,
                    )

    async def get_source(self, source_ref: str) -> dict[str, Any] | None:
        async with self._read() as db:
            if self.backend == "sqlite":
                cur = await db.execute(
                    "SELECT * FROM source_registry WHERE source_ref=?", (source_ref,)
                )
                row = await cur.fetchone()
                return {**dict(row), "payload": _loads(row["payload"])} if row else None
            row = await db.fetchrow(
                "SELECT * FROM source_registry WHERE source_ref=$1", source_ref
            )
            return dict(row) if row else None

    async def list_sources(
        self, trip_id: str | None = None, tool: str | None = None
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM source_registry"
        clauses: list[str] = []
        params: list[Any] = []
        if trip_id:
            clauses.append("(trip_id=? OR trip_id IS NULL)")
            params.append(trip_id)
        if tool:
            clauses.append("tool=?")
            params.append(tool)
        if clauses:
            where = " AND ".join(clauses)
            if self.backend == "sqlite":
                sql += f" WHERE {where}"
            else:
                for i in range(len(params)):
                    where = where.replace("?", f"${i + 1}", 1)
                sql += f" WHERE {where}"
        sql += " ORDER BY fetched_at"
        async with self._read() as db:
            if self.backend == "sqlite":
                cur = await db.execute(sql, tuple(params))
                rows = await cur.fetchall()
                return [{**dict(r), "payload": _loads(r["payload"])} for r in rows]
            rows = await db.fetch(sql, *params)
            return [dict(r) for r in rows]

    async def known_source_refs(self, trip_id: str | None = None) -> set[str]:
        async with self._read() as db:
            if self.backend == "sqlite":
                if trip_id:
                    cur = await db.execute(
                        "SELECT source_ref FROM source_registry WHERE trip_id=? OR trip_id IS NULL",
                        (trip_id,),
                    )
                else:
                    cur = await db.execute("SELECT source_ref FROM source_registry")
                rows = await cur.fetchall()
                return {r["source_ref"] for r in rows}
            if trip_id:
                rows = await db.fetch(
                    "SELECT source_ref FROM source_registry WHERE trip_id=$1 OR trip_id IS NULL",
                    trip_id,
                )
            else:
                rows = await db.fetch("SELECT source_ref FROM source_registry")
            return {r["source_ref"] for r in rows}

    # ------------------------------------------------------------------
    # route legs（距离行 · mindtrip/06 §5、§13.4）
    # ------------------------------------------------------------------
    async def replace_route_legs(self, trip_id: str, legs: list[dict[str, Any]]) -> None:
        async with self._write() as db:
            if self.backend == "sqlite":
                await db.execute("DELETE FROM route_legs WHERE trip_id=?", (trip_id,))
                for leg in legs:
                    await db.execute(
                        """INSERT INTO route_legs
                           (trip_id,leg_id,day_index,from_stop_id,to_stop_id,mode,distance_m,duration_min,polyline,source,fetched_at)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                        (
                            trip_id,
                            leg["leg_id"],
                            leg.get("day_index"),
                            leg["from_stop_id"],
                            leg["to_stop_id"],
                            leg.get("mode") or "drive",
                            leg.get("distance_m"),
                            leg.get("duration_min"),
                            _dumps(leg.get("polyline")) if leg.get("polyline") else None,
                            leg.get("source"),
                            leg.get("fetched_at"),
                        ),
                    )
                await db.commit()
            else:
                async with db.transaction():
                    await db.execute("DELETE FROM route_legs WHERE trip_id=$1", trip_id)
                    for leg in legs:
                        await db.execute(
                            """INSERT INTO route_legs
                               (trip_id,leg_id,day_index,from_stop_id,to_stop_id,mode,distance_m,duration_min,polyline,source,fetched_at)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)""",
                            trip_id,
                            leg["leg_id"],
                            leg.get("day_index"),
                            leg["from_stop_id"],
                            leg["to_stop_id"],
                            leg.get("mode") or "drive",
                            leg.get("distance_m"),
                            leg.get("duration_min"),
                            leg.get("polyline"),
                            leg.get("source"),
                            leg.get("fetched_at"),
                        )

    async def list_route_legs(self, trip_id: str) -> list[dict[str, Any]]:
        async with self._read() as db:
            if self.backend == "sqlite":
                cur = await db.execute(
                    "SELECT * FROM route_legs WHERE trip_id=? ORDER BY day_index, rowid", (trip_id,)
                )
                rows = await cur.fetchall()
                return [{**dict(r), "polyline": _loads(r["polyline"])} for r in rows]
            rows = await db.fetch(
                "SELECT * FROM route_legs WHERE trip_id=$1 ORDER BY day_index, leg_id", trip_id
            )
            return [dict(r) for r in rows]

    # ------------------------------------------------------------------
    # saved places（收藏 / 想去层 · mindtrip/06 §11）
    # ------------------------------------------------------------------
    async def list_saved(self, user_id: str) -> list[dict[str, Any]]:
        async with self._read() as db:
            if self.backend == "sqlite":
                cur = await db.execute(
                    "SELECT * FROM saved_places WHERE user_id=? ORDER BY created_at DESC", (user_id,)
                )
                rows = await cur.fetchall()
                return [dict(r) for r in rows]
            rows = await db.fetch(
                "SELECT * FROM saved_places WHERE user_id=$1 ORDER BY created_at DESC", user_id
            )
            return [dict(r) for r in rows]

    async def save_place(self, user_id: str, item: dict[str, Any]) -> None:
        now = utcnow()
        async with self._write() as db:
            if self.backend == "sqlite":
                await db.execute(
                    """INSERT INTO saved_places
                       (user_id,poi_id,name,category,lat,lng,city,address,note,created_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(user_id,poi_id) DO UPDATE SET
                         name=excluded.name, note=excluded.note, category=excluded.category,
                         lat=excluded.lat, lng=excluded.lng, city=excluded.city, address=excluded.address""",
                    (
                        user_id,
                        item["poi_id"],
                        item.get("name") or item["poi_id"],
                        item.get("category"),
                        item.get("lat"),
                        item.get("lng"),
                        item.get("city"),
                        item.get("address"),
                        item.get("note"),
                        now,
                    ),
                )
                await db.commit()
            else:
                await db.execute(
                    """INSERT INTO saved_places
                       (user_id,poi_id,name,category,lat,lng,city,address,note,created_at)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                       ON CONFLICT(user_id,poi_id) DO UPDATE SET
                         name=EXCLUDED.name, note=EXCLUDED.note, category=EXCLUDED.category,
                         lat=EXCLUDED.lat, lng=EXCLUDED.lng, city=EXCLUDED.city, address=EXCLUDED.address""",
                    user_id,
                    item["poi_id"],
                    item.get("name") or item["poi_id"],
                    item.get("category"),
                    item.get("lat"),
                    item.get("lng"),
                    item.get("city"),
                    item.get("address"),
                    item.get("note"),
                    now,
                )

    async def delete_saved(self, user_id: str, poi_id: str) -> None:
        async with self._write() as db:
            if self.backend == "sqlite":
                await db.execute(
                    "DELETE FROM saved_places WHERE user_id=? AND poi_id=?", (user_id, poi_id)
                )
                await db.commit()
            else:
                await db.execute(
                    "DELETE FROM saved_places WHERE user_id=$1 AND poi_id=$2", user_id, poi_id
                )

    # ------------------------------------------------------------------
    # trip threads / comments（同行人评论 · P2-1）
    # ------------------------------------------------------------------
    async def list_threads(self, trip_id: str) -> list[dict[str, Any]]:
        async with self._read() as db:
            if self.backend == "sqlite":
                cur = await db.execute(
                    "SELECT * FROM trip_threads WHERE trip_id=? ORDER BY created_at, rowid", (trip_id,)
                )
                rows = await cur.fetchall()
                return [dict(r) for r in rows]
            rows = await db.fetch(
                "SELECT * FROM trip_threads WHERE trip_id=$1 ORDER BY created_at, thread_id", trip_id
            )
            return [dict(r) for r in rows]

    async def create_thread(self, thread_id: str, trip_id: str, title: str) -> None:
        async with self._write() as db:
            if self.backend == "sqlite":
                await db.execute(
                    "INSERT INTO trip_threads (thread_id,trip_id,title,created_at) VALUES (?,?,?,?)",
                    (thread_id, trip_id, title, utcnow()),
                )
                await db.commit()
            else:
                await db.execute(
                    "INSERT INTO trip_threads (thread_id,trip_id,title,created_at) VALUES ($1,$2,$3,$4)",
                    thread_id,
                    trip_id,
                    title,
                    utcnow(),
                )

    async def get_thread(self, thread_id: str) -> dict[str, Any] | None:
        async with self._read() as db:
            if self.backend == "sqlite":
                cur = await db.execute("SELECT * FROM trip_threads WHERE thread_id=?", (thread_id,))
                row = await cur.fetchone()
                return dict(row) if row else None
            row = await db.fetchrow("SELECT * FROM trip_threads WHERE thread_id=$1", thread_id)
            return dict(row) if row else None

    async def get_comment(self, comment_id: str) -> dict[str, Any] | None:
        async with self._read() as db:
            if self.backend == "sqlite":
                cur = await db.execute(
                    "SELECT * FROM thread_comments WHERE comment_id=?", (comment_id,)
                )
                row = await cur.fetchone()
                data = dict(row) if row else None
            else:
                row = await db.fetchrow(
                    "SELECT * FROM thread_comments WHERE comment_id=$1", comment_id
                )
                data = dict(row) if row else None
        if data:
            data["mentions_assistant"] = bool(data.get("mentions_assistant"))
        return data

    async def list_comments(self, thread_id: str) -> list[dict[str, Any]]:
        async with self._read() as db:
            if self.backend == "sqlite":
                cur = await db.execute(
                    "SELECT * FROM thread_comments WHERE thread_id=? ORDER BY created_at, rowid",
                    (thread_id,),
                )
                rows = await cur.fetchall()
                out = []
                for row in rows:
                    item = dict(row)
                    item["mentions_assistant"] = bool(item.get("mentions_assistant"))
                    out.append(item)
                return out
            rows = await db.fetch(
                "SELECT * FROM thread_comments WHERE thread_id=$1 ORDER BY created_at, comment_id",
                thread_id,
            )
            return [dict(r) for r in rows]

    async def add_comment(
        self,
        comment_id: str,
        thread_id: str,
        author: str,
        body: str,
        mentions_assistant: bool = False,
    ) -> None:
        async with self._write() as db:
            if self.backend == "sqlite":
                await db.execute(
                    """INSERT INTO thread_comments
                       (comment_id,thread_id,author,body,mentions_assistant,created_at)
                       VALUES (?,?,?,?,?,?)""",
                    (comment_id, thread_id, author, body, 1 if mentions_assistant else 0, utcnow()),
                )
                await db.commit()
            else:
                await db.execute(
                    """INSERT INTO thread_comments
                       (comment_id,thread_id,author,body,mentions_assistant,created_at)
                       VALUES ($1,$2,$3,$4,$5,$6)""",
                    comment_id,
                    thread_id,
                    author,
                    body,
                    mentions_assistant,
                    utcnow(),
                )

    # ------------------------------------------------------------------
    # connection helpers
    # ------------------------------------------------------------------
    class _Ctx:
        def __init__(self, db: "Database", write: bool):
            self.db = db
            self.write = write
            self.conn: Any = None

        async def __aenter__(self):
            if self.db.backend == "sqlite":
                assert self.db._sqlite is not None
                self.conn = self.db._sqlite
                if self.write:
                    await self.db._sqlite_lock.acquire()
                return self.conn
            assert self.db._pg is not None
            self.conn = await self.db._pg.acquire()
            if self.write:
                self.tx = self.conn.transaction()
                await self.tx.start()
            return self.conn

        async def __aexit__(self, exc_type, exc, tb):
            if self.db.backend == "sqlite":
                if self.write:
                    self.db._sqlite_lock.release()
                return False
            if self.write:
                if exc_type is None:
                    await self.tx.commit()
                else:
                    await self.tx.rollback()
            await self.db._pg.release(self.conn)
            return False

    def _read(self):
        return Database._Ctx(self, False)

    def _write(self):
        return Database._Ctx(self, True)


_db: Database | None = None


async def get_db() -> Database:
    global _db
    if _db is None:
        raise RuntimeError("database not initialised")
    return _db


def set_db(db: Database) -> None:
    global _db
    _db = db
