.PHONY: backend frontend build test dev docker hooks verify-clean

# 启用仓库 hook：拦截 .env / *.md 入库与推送
hooks:
	git config core.hooksPath .githooks
	chmod +x .githooks/pre-commit .githooks/pre-push 2>/dev/null || true
	@echo "hooks enabled: core.hooksPath=.githooks"

# 全量自检：扫描全部历史，确认没有任何 .env / *.md
verify-clean:
	@sh .githooks/verify-clean.sh

backend:
	cd backend && uv run uvicorn app.main:app --reload --port 8010

frontend:
	cd frontend && pnpm dev

build:
	cd frontend && pnpm build

test:
	cd backend && uv run pytest -q

docker:
	docker compose up -d --build

dev:
	@echo "Run 'make backend' and 'make frontend' in two terminals."
