#!/bin/sh
# 全量自检：遍历所有分支/标签的全部提交，确认没有任何 .env / *.md 文件。
banned='(^|/)\.env($|\.)|\.env$|\.md$'

paths=$(git log --all --pretty=format: --name-only | sort -u | sed '/^$/d')
hits=$(printf '%s\n' "$paths" | grep -Ei "$banned" || true)

if [ -n "$hits" ]; then
  echo "✖ 违规：历史中存在 env / markdown 文件"
  printf '%s\n' "$hits" | sed 's/^/    - /'
  exit 1
fi

echo "✅ 历史中无任何 env / markdown 文件"
exit 0
