# 发版流程

给自己看的清单，照着做就行。

## 1. 改版本号

两个地方要改，保持同一个数字：

- `manifest.json` 的 `"version"`
- `README.md` 徽章里的 `version-x.y.z`

页面上的版本号是从 `manifest.json` 读的，不用改代码。

版本号规则：`1.0.1` 修 bug，`1.1.0` 加功能，`2.0.0` 大改。

## 2. 打包并自测

```bash
# 在项目根目录
zip -qr ../firstlight-newtab-v<版本>.zip . -x '.DS_Store' 'weather-demo.html'
```

解压这个 zip，用「加载解压缩的扩展」装一遍，确认能正常打开新标签页、RSS 页能进。**先自测，再上传。**

## 3. 提交并推送

```bash
git add -A
git commit -m "版本 x.y.z：一句话说明改了什么"
git tag vx.y.z
git push
git push origin vx.y.z
```

推送失败多半是网络问题，重跑一次即可。

## 4. 发布 Release

```bash
gh release create vx.y.z ../firstlight-newtab-v<版本>.zip \
  --title "版本 x.y.z" \
  --notes "这个版本改了什么（分条写）"
```

没有 `gh` 命令，就在网页上：仓库 → Releases → Draft a new release → 选 tag → 写说明 → 拖入 zip。

## 5. 检查

打开仓库的 Releases 页，确认附件能下载、说明没有乱码。

---

## 常用命令备查

```bash
gh auth status                 # 确认还登录着
gh release list                # 看已发布的版本
gh release delete vx.y.z       # 发错了删掉（网页上也能删）
git tag -d vx.y.z              # 删本地 tag
git push origin :vx.y.z        # 删远端 tag
```
