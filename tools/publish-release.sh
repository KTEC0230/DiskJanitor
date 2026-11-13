#!/bin/bash
# 发 release:创建 release + 上传 Setup exe(凭据从 GCM 取,token 不回显)
set -uo pipefail
cd "C:/Users/27025/Desktop/github/DiskJanitor"
PROXY="http://127.0.0.1:6234"
TOKEN=$(printf "protocol=https\nhost=github.com\nusername=KTEC0230\n\n" | git credential fill 2>/dev/null | grep "^password=" | cut -d= -f2-)
if [ -z "$TOKEN" ]; then echo "FAIL: 未取得 token"; exit 1; fi
echo "token ok (len ${#TOKEN})"

cat > build/release.json <<'EOF'
{"tag_name":"v0.1.0","name":"DiskJanitor v0.1.0","body":"分析只读、删除必可逆的磁盘清理桌面应用。\n\n- 五层架构:Scanner/RiskEngine/Planner/Executor/UndoManager,分析路径零写权限\n- 默认 staging 通道(可撤销),回收站可选;永久删除独立二次确认+审计\n- 规则引擎 v2(20 条内置规则)+ TOML 受限叠加覆盖(只能收紧)\n- 扫描暂停/继续/停止、虚拟滚动、建议清理平铺视图\n- 资源管理器式交互(单击选择/双击打开/全选)\n- 撤销面板+暂存区管理(永久删除批次/清空全部暂存)\n- 扫描报告导出(md+json,供 AI 二次分析未识别条目)\n- 内置 selftest 43 断言\n\n下载 DiskJanitor-Setup-0.1.0.exe 双击安装即可(按用户级安装,无需管理员)。","draft":false,"prerelease":false}
EOF

echo "--- 创建 release ---"
curl -s -x "$PROXY" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  https://api.github.com/repos/KTEC0230/DiskJanitor/releases -d @build/release.json > build/release-resp.json
if grep -q '"id"' build/release-resp.json; then
  echo "release 已创建/存在"
else
  echo "创建失败:"; head -c 400 build/release-resp.json; exit 1
fi

RELEASE_ID=$(node -e "const j=require('./build/release-resp.json');console.log(j.id)")
echo "release id: $RELEASE_ID"

echo "--- 上传 Setup exe (111MB, 经代理可能要几分钟) ---"
curl -s -x "$PROXY" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/octet-stream" \
  --data-binary @dist/DiskJanitor-Setup-0.1.0.exe \
  "https://uploads.github.com/repos/KTEC0230/DiskJanitor/releases/$RELEASE_ID/assets?name=DiskJanitor-Setup-0.1.0.exe" > build/asset-resp.json
if grep -q '"browser_download_url"' build/asset-resp.json; then
  node -e "const j=require('./build/asset-resp.json');console.log('asset 上传成功:', j.browser_download_url, Math.round(j.size/1048576)+'MB')"
else
  echo "上传失败:"; head -c 400 build/asset-resp.json; exit 1
fi
echo "--- 完成 ---"
