#!/usr/bin/env bash
# 从 n8n 官方镜像里原样导出全部节点说明,再精简成执行者能用的目录。
# 需要本机装有 Docker。原始导出放 .cache/n8n/(不入库),精简目录写到 fixtures/n8n/catalog.json(入库)。
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE="${N8N_IMAGE:-n8nio/n8n:latest}"
mkdir -p .cache/n8n && chmod 777 .cache/n8n
docker pull "$IMAGE" >/dev/null
docker run --rm -u root -v "$PWD/.cache/n8n":/out -v "$PWD/scripts/dump-n8n-nodes.cjs":/dump.cjs:ro --entrypoint sh "$IMAGE" -c '
NB=$(dirname $(find / -name "ScheduleTrigger.node.js" -path "*/n8n-nodes-base/dist/*" 2>/dev/null | head -1))/../../..
LC=$(dirname $(find / -name "InformationExtractor.node.js" -path "*/n8n-nodes-langchain/dist/*" 2>/dev/null | head -1))/../../../..
cd "$NB" && node /dump.cjs "$(pwd)" /out/nodes-base.json
cd "$LC" && node /dump.cjs "$(pwd)" /out/nodes-langchain.json
n8n --version > /out/n8n-version.txt'
node scripts/trim-n8n-nodes.mjs
