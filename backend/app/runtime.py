"""Runtime-editable integration settings (single-user local app).

The `.env` file remains the deployment source of truth.  This store lets the
UI fill missing API keys / choose a provider without restarting the server, and
persists them to `backend/data/runtime_settings.json` (mode 600).

Security: secrets are never returned by the API.  `public()` exposes only
"configured + last four characters", which is enough for an operator UI and
safe to render in a browser.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from app.config import Settings

SECRET_FIELDS = {
    "deepseek_api_key",
    "qwen_api_key",
    "openai_api_key",
    "anthropic_api_key",
    "custom_api_key",
    "amap_web_key",
    "amap_js_key",
    "amap_js_security_code",
    "tavily_api_key",
    # Jev 工具路由（01 §2）
    "jev_api_key",
    # 社交线索抓取（01 §6）：登录墙平台默认关闭，部署者显式开启后才抓
    "crawl4ai_token",
}

VALUE_FIELDS = {
    "default_provider",
    "default_model",
    "deepseek_base_url",
    "qwen_base_url",
    "openai_base_url",
    "anthropic_base_url",
    "custom_base_url",
    "custom_model",
    "amap_base_url",
    "tavily_base_url",
    "map_provider",
    "jev_base_url",
    "jev_endpoint",
    "jev_model",
    "social_digest_enabled",
    "social_digest_login_enabled",
    "social_digest_platforms",
    "crawl4ai_base_url",
    "subagent_model",
    "deepseek_search_enabled",
    "demo_mode",
    "seed_demo",
    "http_trust_env",
}

BOOL_FIELDS = {
    "demo_mode",
    "seed_demo",
    "http_trust_env",
    "social_digest_enabled",
    "social_digest_login_enabled",
    "deepseek_search_enabled",
}
PROVIDERS = {"mock", "deepseek", "qwen", "openai", "anthropic", "custom"}
MAP_PROVIDERS = {"auto", "amap", "leaflet", "svg"}


class RuntimeSettingsError(ValueError):
    pass


class RuntimeSettingsStore:
    def __init__(self, path: Path):
        self.path = path
        self.overrides: dict[str, Any] = {}

    # ------------------------------------------------------------------
    def load(self, settings: Settings) -> None:
        if not self.path.exists():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if not isinstance(raw, dict):
            return
        self.overrides = {
            field: value
            for field, value in raw.items()
            if field in SECRET_FIELDS or field in VALUE_FIELDS
        }
        self._apply(settings)

    def _apply(self, settings: Settings) -> None:
        for field, value in self.overrides.items():
            if field in SECRET_FIELDS:
                if isinstance(value, str):
                    setattr(settings, field, value)
            elif field in VALUE_FIELDS:
                if field in BOOL_FIELDS and not isinstance(value, bool):
                    continue
                if field == "default_provider" and value not in PROVIDERS:
                    continue
                if field == "map_provider" and value not in MAP_PROVIDERS:
                    continue
                if field not in BOOL_FIELDS and not isinstance(value, str):
                    continue
                setattr(settings, field, value)

    # ------------------------------------------------------------------
    def update(self, settings: Settings, payload: dict[str, Any]) -> None:
        values = payload.get("values") or {}
        secrets = payload.get("secrets") or {}
        clear = payload.get("clear_secrets") or []
        if not isinstance(values, dict) or not isinstance(secrets, dict) or not isinstance(clear, list):
            raise RuntimeSettingsError("values/secrets/clear_secrets 格式不正确")

        next_overrides = dict(self.overrides)
        pending: dict[str, Any] = {}

        # Validate everything before mutating Settings so a rejected payload
        # never leaves the live process half-updated.
        for field, value in values.items():
            if field not in VALUE_FIELDS:
                raise RuntimeSettingsError(f"不允许运行时修改字段：{field}")
            if field in BOOL_FIELDS:
                if not isinstance(value, bool):
                    raise RuntimeSettingsError(f"{field} 必须是布尔值")
            elif field == "default_provider":
                if value not in PROVIDERS:
                    raise RuntimeSettingsError(f"未知 provider：{value}")
            elif field == "map_provider":
                if value not in MAP_PROVIDERS:
                    raise RuntimeSettingsError(f"未知地图 provider：{value}")
            elif not isinstance(value, str):
                raise RuntimeSettingsError(f"{field} 必须是字符串")
            next_overrides[field] = value
            pending[field] = value

        for field, value in secrets.items():
            if field not in SECRET_FIELDS:
                raise RuntimeSettingsError(f"不是可配置密钥字段：{field}")
            if value is None or value == "":
                continue
            if not isinstance(value, str):
                raise RuntimeSettingsError(f"{field} 必须是字符串")
            next_overrides[field] = value.strip()
            pending[field] = value.strip()

        for field in clear:
            if field not in SECRET_FIELDS:
                raise RuntimeSettingsError(f"不是可清除密钥字段：{field}")
            next_overrides[field] = ""
            pending[field] = ""

        next_provider = pending.get("default_provider", settings.default_provider)
        next_model = pending.get("default_model", settings.default_model)
        if next_provider not in PROVIDERS:
            raise RuntimeSettingsError("default_provider 不合法")
        if not isinstance(next_model, str) or not next_model.strip():
            raise RuntimeSettingsError("default_model 不能为空")

        for field, value in pending.items():
            setattr(settings, field, value)
        self.overrides = next_overrides
        self._persist()

    def _persist(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.overrides, ensure_ascii=False, indent=2), encoding="utf-8")
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        tmp.replace(self.path)

    # ------------------------------------------------------------------
    @staticmethod
    def public(settings: Settings) -> dict[str, Any]:
        def hint(value: str) -> str | None:
            if not value:
                return None
            return "••••" + value[-4:] if len(value) >= 4 else "••••"

        secrets = {
            field: {
                "configured": bool(getattr(settings, field, "")),
                "hint": hint(getattr(settings, field, "")),
            }
            for field in sorted(SECRET_FIELDS)
        }
        values = {
            field: getattr(settings, field)
            for field in sorted(VALUE_FIELDS)
            if field not in BOOL_FIELDS
        }
        values.update({field: bool(getattr(settings, field)) for field in BOOL_FIELDS})
        return {
            "values": values,
            "secrets": secrets,
            "llmConfigured": settings.llm_configured,
            "mapProvider": settings.effective_map_provider,
            "mapProviderSetting": settings.map_provider,
            "providerCatalog": settings.provider_catalog(),
            "demoMode": settings.demo_mode,
        }
