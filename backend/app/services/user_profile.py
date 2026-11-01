"""用户长期口味档案（docs/07 §7）。

分层：**我自己的口味 = 稳定的 = 记忆一次永久生效；同行的人 = 每次不同 = 每次问。**
这解释了为什么 `constraints.diet` 一直是空的——它本该是两类信息的合成，而 prompt
从没让模型问。

- `diet` / `taste`：长期记忆，存这里，规划时合成进 `constraints.diet`，
  攻略层拿它做口味匹配。
- 同行人忌口：每次 `ask_user` 一次性 chips 提交，只进那一趟的
  `constraints.diet`，**不存这里**。

隐私：本档案**绝不进 Trip / 详情 / 分享任何响应**，只通过独立的
`GET/PUT /api/profile` 供设置弹窗与首屏问卷读写。

存储与 `runtime_settings.json` 同目录同权限（mode 600）：放服务端不放
localStorage，因为规划时后端要读它。
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.config import Settings

#: 首屏问卷的可选值。封闭集合——避免前端自由文本把档案写成垃圾场。
DIET_OPTIONS = ("不吃辣", "清真", "素食", "海鲜过敏", "不吃牛肉", "不吃猪肉", "少油少盐")
TASTE_OPTIONS = ("川菜", "湘菜", "粤菜", "西北菜", "新疆菜", "日料", "东南亚菜", "西餐", "小吃夜市", "咖啡甜品")


def _clean(values: Any, allowed: tuple[str, ...], limit: int = 12) -> list[str]:
    """只接受封闭集合内的值，去重保序。"""
    if not isinstance(values, (list, tuple)):
        return []
    out: list[str] = []
    for value in values:
        if not isinstance(value, str):
            continue
        item = value.strip()
        if item in allowed and item not in out:
            out.append(item)
        if len(out) >= limit:
            break
    return out


class UserProfile:
    """不可变视图。`dismissed=True` 表示用户跳过了首屏问卷，永不再弹。"""

    def __init__(
        self,
        diet: list[str] | None = None,
        taste: list[str] | None = None,
        dismissed: bool = False,
        updated_at: str | None = None,
    ):
        self.diet = diet or []
        self.taste = taste or []
        self.dismissed = bool(dismissed)
        self.updated_at = updated_at

    @property
    def exists(self) -> bool:
        """档案是否已被回答过（填了或明确跳过）。"""
        return self.dismissed or bool(self.diet) or bool(self.taste)

    def to_dict(self) -> dict[str, Any]:
        return {
            "diet": self.diet,
            "taste": self.taste,
            "dismissed": self.dismissed,
            "updated_at": self.updated_at,
        }

    def preferences(self) -> list[str]:
        """攻略层的口味匹配输入：忌口在前（硬约束），偏好在后。"""
        return [*self.diet, *self.taste]


class UserProfileStore:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._path: Path | None = None

    @property
    def path(self) -> Path:
        if self._path is None:
            self._path = self.settings.profile_path
        return self._path

    def load(self) -> UserProfile:
        path = self.path
        if not path.exists():
            return UserProfile()
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return UserProfile()
        if not isinstance(raw, dict):
            return UserProfile()
        return UserProfile(
            diet=_clean(raw.get("diet"), DIET_OPTIONS),
            taste=_clean(raw.get("taste"), TASTE_OPTIONS),
            dismissed=bool(raw.get("dismissed")),
            updated_at=raw.get("updated_at") if isinstance(raw.get("updated_at"), str) else None,
        )

    def save(self, payload: dict[str, Any]) -> UserProfile:
        """写入并返回规范化后的档案。

        `dismissed` 只在明确跳过时置真；一旦置真**永不再弹**首屏问卷
        （docs/07 §7），想重填走设置弹窗的「我的偏好」。
        """
        current = self.load()
        profile = UserProfile(
            diet=_clean(payload.get("diet", current.diet), DIET_OPTIONS),
            taste=_clean(payload.get("taste", current.taste), TASTE_OPTIONS),
            # 跳过即永久生效；填了内容也算已回答
            dismissed=bool(payload.get("dismissed", current.dismissed)) or bool(payload.get("skip")),
            updated_at=datetime.now(timezone.utc).isoformat(),
        )
        self._persist(profile)
        return profile

    def _persist(self, profile: UserProfile) -> None:
        path = self.path
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(profile.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        tmp.replace(path)

    @staticmethod
    def options() -> dict[str, list[str]]:
        """给前端渲染 chips 用。"""
        return {"diet": list(DIET_OPTIONS), "taste": list(TASTE_OPTIONS)}
