"""Construct the request-scoped service graph from the current Settings.

Called once at startup and again after a runtime settings update, so the agent
loop, tool clients and plan service pick up new keys without a restart.
"""

from __future__ import annotations

from typing import Any

from app.agent.loop import AgentLoop
from app.config import Settings
from app.db import Database
from app.services.guide_service import GuideService
from app.services.plan_service import PlanService
from app.services.source_registry import SourceRegistry
from app.services.user_profile import UserProfileStore
from app.tools.registry import ToolRegistry


def wire_services(app: Any, settings: Settings, db: Database) -> None:
    registry = ToolRegistry(settings, db)
    # 主 Agent、子 Agent、写入管线共用同一份来源登记簿（02 §5）
    sources = registry.sources
    plan_service = PlanService(settings, db, sources)
    app.state.settings = settings
    app.state.tools = registry
    app.state.plan_service = plan_service
    app.state.sources = sources
    app.state.agent_loop = AgentLoop(settings, db, registry)
    # 攻略层与用户口味档案（docs/07 §7、§9），独立于主 agent loop
    app.state.guides = GuideService(settings, db)
    app.state.profile = UserProfileStore(settings)
