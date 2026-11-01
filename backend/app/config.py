"""Runtime configuration.

All secrets and provider endpoints live here.  The app must boot with an empty
environment too: `demo_mode` then serves the acceptance trip with a scripted
agent, so the product can be reviewed without any external API key.

Env 文件按顺序加载，**后者覆盖前者**：

    .env  →  backend/.env  →  backend/.env.jev

`backend/.env.jev` 是 Jev / TypeSafe 决策模型的独立配置文件：部署时只填这一个
文件就能接管工具路由配置，不需要动主 .env。
"""

from __future__ import annotations

from datetime import date
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        # 顺序有意义：后面的文件覆盖前面的。
        # Jev 决策模型单独放 backend/.env.jev（模板见 backend/.env.jev.example）。
        env_file=(
            PROJECT_DIR / ".env",
            BACKEND_DIR / ".env",
            BACKEND_DIR / ".env.jev",
        ),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    app_name: str = "Trace Planner"
    debug: bool = False
    # Honour HTTP_PROXY / HTTPS_PROXY env vars. Off by default because some
    # local environments expose a malformed NO_PROXY entry that breaks httpx.
    http_trust_env: bool = False

    # ---- persistence -----------------------------------------------------
    # PostgreSQL in deployments; SQLite is the zero-setup local fallback.
    database_url: str = "sqlite:///./data/trace_planner.db"
    db_min_size: int = 1
    db_max_size: int = 10

    # ---- demo / acceptance case -----------------------------------------
    demo_mode: bool = True
    seed_demo: bool = True
    demo_today: date = Field(default=date(2026, 4, 26))
    mock_latency_ms: int = 120
    allow_origin: str = (
        "http://127.0.0.1:8010,http://localhost:8010,"
        "http://127.0.0.1:5180,http://localhost:5180,"
        "capacitor://localhost,https://localhost"
    )

    # ---- 高德 ------------------------------------------------------------
    amap_web_key: str = ""
    amap_js_key: str = ""
    amap_js_security_code: str = ""
    amap_base_url: str = "https://restapi.amap.com/v3"

    # ---- search ----------------------------------------------------------
    # DeepSeek 官方搜索 / Fetch（01 §4.1）。复用 DEEPSEEK_API_KEY；
    # 关掉它以后 web_search 只剩 Tavily 一个源，交叉核对自动降级。
    deepseek_search_enabled: bool = True
    tavily_api_key: str = ""
    tavily_base_url: str = "https://api.tavily.com"

    # ---- Jev 工具路由（01 §2）--------------------------------------------
    # Jev / TypeSafe System One 是**决策模型**，不是聊天模型：输入 state + 一组
    # 结构化问题，返回 choice / score / noul 的答案。客户端单独在 app/llm/jev.py。
    # 未配置时整体降级：常开档与强制档不受影响，第三档按 §2.4 收缩。
    jev_api_key: str = ""
    # 默认走 TypeSafe 兼容中转；官方地址可在接入配置里改。
    jev_base_url: str = "https://www.dmxapi.cn"
    jev_endpoint: str = "/typesafe/v1/systemone"
    # 固定带版本号的模型 ID，不用 jev-latest（01 §2.4）。
    jev_model: str = "jev-1.14.0"
    # 这是路由的延迟预算，不是接口本身的超时；超时就降级。
    jev_timeout_ms: int = 2500
    jev_intent_threshold: float = 0.45
    jev_tool_threshold: float = 0.55
    # 贵的工具阈值更高：同一输入上概率不可互换，所以按工具单独标定。
    jev_tool_threshold_expensive: float = 0.75

    # ---- 字段级事实补齐（02 §2.6 第 3 步）--------------------------------
    # 写完行程后，代码对每个景点并行调用营业时间/票务复合工具，把结果回填进 Trip。
    # 没有检索 Key 时自动跳过（不编造、不占额度）。
    fact_enrichment_enabled: bool = True
    fact_enrichment_max_calls: int = 6

    # ---- 子 Agent 调研（02 §2.4，全部为初值、待标定）------------------------
    subagent_max_steps: int = 6
    subagent_max_concurrency: int = 3
    subagent_timeout_seconds: int = 180
    subagent_retry_times: int = 2
    subagent_max_tool_calls: int = 14
    subagent_deny_expensive: bool = True
    #: 便宜模型；留空用 default_model。中文摘要质量需要自测（02 §8）。
    subagent_model: str = ""

    # ---- social_digest（01 §6）-------------------------------------------
    # 默认关闭：登录墙平台默认不抓，部署者明确开启后才抓公开文本平台。
    social_digest_enabled: bool = False
    #: 小红书/抖音/微博这类登录墙平台：默认关闭，部署者显式开启后才抓（01 §6.1）
    social_digest_login_enabled: bool = False
    social_digest_platforms: str = "zhihu,bilibili"
    crawl4ai_base_url: str = ""
    crawl4ai_token: str = ""

    # ---- map -------------------------------------------------------------
    # auto: AMap when AMAP_JS_KEY exists, otherwise real OSM tiles (Leaflet).
    # Other values: amap / leaflet / svg.
    map_provider: str = "auto"

    # Runtime-editable overrides live here (single-user local app).
    runtime_settings_path: str = "data/runtime_settings.json"
    # 用户长期口味档案（docs/07 §7）。与 runtime_settings 同目录同权限，
    # 因为规划时后端要读它合成 constraints.diet。绝不进任何行程接口响应。
    user_profile_path: str = "data/user_profile.json"

    # ---- LLM -------------------------------------------------------------
    # `mock` is a first-class provider: it runs the scripted acceptance flow.
    default_provider: str = "mock"
    default_model: str = "trace-mock-v1"

    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"

    qwen_api_key: str = ""
    qwen_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"

    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"

    anthropic_api_key: str = ""
    anthropic_base_url: str = "https://api.anthropic.com/v1"

    custom_api_key: str = ""
    custom_base_url: str = ""
    custom_model: str = ""

    # Loop guardrails
    agent_max_steps: int = 14
    tool_retry_times: int = 2

    # Tool cache TTL (seconds).  Docs §6.4
    cache_ttl_poi: int = 7 * 24 * 3600
    cache_ttl_route: int = 7 * 24 * 3600
    cache_ttl_weather: int = 6 * 3600
    cache_ttl_web: int = 3 * 24 * 3600
    # 复合工具（票务/封路/营业时间）：时效事实，缓存短一些
    cache_ttl_fact: int = 24 * 3600
    # 攻略层（stop 详情的美食/打卡段）缓存 3 天（docs/07 §9）
    cache_ttl_guide: int = 3 * 24 * 3600

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")

    @property
    def sqlite_path(self) -> Path:
        raw = self.database_url.split("sqlite:///", 1)[-1]
        path = Path(raw)
        if not path.is_absolute():
            path = (BACKEND_DIR / path).resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def jev_configured(self) -> bool:
        return bool(self.jev_api_key)

    @property
    def social_platforms(self) -> list[str]:
        return [p.strip() for p in (self.social_digest_platforms or "").split(",") if p.strip()]

    @property
    def llm_configured(self) -> bool:
        return bool(
            self.deepseek_api_key
            or self.qwen_api_key
            or self.openai_api_key
            or self.anthropic_api_key
            or self.custom_base_url
        )

    @property
    def runtime_path(self) -> Path:
        path = Path(self.runtime_settings_path)
        if not path.is_absolute():
            path = (BACKEND_DIR / path).resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def profile_path(self) -> Path:
        path = Path(self.user_profile_path)
        if not path.is_absolute():
            path = (BACKEND_DIR / path).resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def effective_map_provider(self) -> str:
        value = (self.map_provider or "auto").lower()
        if value == "auto":
            return "amap" if self.amap_js_key else "leaflet"
        if value not in {"amap", "leaflet", "svg"}:
            return "leaflet"
        return value

    def provider_catalog(self) -> list[dict]:
        """Provider/model options exposed to the UI. Only configured providers are
        marked available; the mock provider is always available."""
        def opt(pid: str, name: str, desc: str, models: list[tuple[str, str, str]], available: bool):
            return {
                "id": pid,
                "provider": name,
                "available": available,
                "models": [
                    {"id": mid, "name": mname, "desc": mdesc}
                    for mid, mname, mdesc in models
                ],
            }

        return [
            opt("mock", "Mock", "内置演示 Agent · 无需 Key", [
                ("trace-mock-v1", "Trace Mock Planner", "脚本化验收 case · 即时"),
            ], True),
            opt("deepseek", "DeepSeek", "默认推理后端", [
                ("deepseek-flash", "DeepSeek Flash", "V4.1 Flash · 快速 · 1M 上下文"),
                ("deepseek-v4-pro", "DeepSeek V4 Pro", "深度推理 · 强 Agent"),
            ], bool(self.deepseek_api_key)),
            opt("qwen", "Qwen", "阿里通义千问", [
                ("qwen-plus", "Qwen Plus", "轻量 · 中文强"),
                ("qwen-max", "Qwen Max", "更强规划"),
            ], bool(self.qwen_api_key)),
            opt("openai", "OpenAI", "GPT", [
                ("gpt-4.1", "GPT-4.1", "通用"),
                ("gpt-4.1-mini", "GPT-4.1 mini", "轻量"),
            ], bool(self.openai_api_key)),
            opt("anthropic", "Anthropic", "Claude", [
                ("claude-sonnet-4-20250514", "Claude Sonnet", "工具调用稳"),
            ], bool(self.anthropic_api_key)),
            opt("custom", "自定义兼容端点", "OpenAI-compatible · vLLM / Ollama", [
                (self.custom_model or "custom-model", self.custom_model or "自定义模型", "Base URL + Key"),
            ], bool(self.custom_base_url)),
        ]


@lru_cache
def get_settings() -> Settings:
    return Settings()
