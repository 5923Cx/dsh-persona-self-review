# 发布与维护

面向仓库维护者。给朋友的安装说明在 [README](./README.md)。

## 名字

- 仓库名与包名统一为 `dsh-persona-self-review`（2026-11-21 从 `dsh-persona-card` 改名，避免与另一位作者的 [5527sy/dsh-persona-card](https://github.com/5527sy/dsh-persona-card) 撞名）。
- 0.2.0 起内部标识也改成新名字：`cordis.patch.yml` 的行 id `persona-self-review`、Host 导出名、客户端插件名 `persona-self-review`。
- 仍保留旧名字的是数据路径与兼容项：slot id（`persona-card`、`persona-card-toast`、`persona-card-gate`、`persona-card-mismatch`）、`$DSH_HOME/persona-card/`、HTTP 前缀 `/persona-card`、自定义头 `x-persona-card`、localStorage 键 `persona-card.*`。这样升级不会丢卡、丢备份或丢面板位置。
- **0.2.0 移除了内置示例卡**：0.1.x 自带的 `card2-大肥鱼` 设定来自第三方社区二创，不再随插件分发。已装用户本机的这张卡是自己的数据，升级不会删除。
- npm 上的 `dsh-persona-self-review` 与 `dsh-persona-card` 都未被本仓库占用；本插件**不发 npm**（原因见下），该名字留作备用。

## 发布渠道

| 渠道 | 状态 | 说明 |
| --- | --- | --- |
| GitHub 仓库 | 主渠道 | `dsh plugin add github:5923Cx/dsh-persona-self-review` |
| GitHub Release 预构建包 | 主渠道 | 资产名固定 `dsh-persona-self-review.tgz`（不带版本号），供市场用 `latest/download/` 引用 |
| npm | **不发** | 收录不依赖 npm；发 npm 只多一个下载量数字，却要维护 `repository` 映射与 peer 范围 |
| awesome-dsh-plugin | 收录 PR | 见下，收录后才进 dshmarket / 市场列表 |

## 发一版

1. 改 `package.json` 的 `version`（如 `0.2.1`）。
2. 打包（`files` 决定内容，`dist/` 不会进包）：

   ```bash
   npm pack --pack-destination dist --cache .npm-cache-tmp
   # 产出 dist/dsh-persona-self-review-<version>.tgz
   ```

3. 复制成不带版本号的名字，作为 Release 资产上传：

   ```powershell
   Copy-Item dist\dsh-persona-self-review-<version>.tgz dist\dsh-persona-self-review.tgz -Force
   ```

4. 在 GitHub 建 Release，tag 用 `v<version>`（如 `v0.2.1`），附上 `dsh-persona-self-review.tgz`。
   资产名必须**不带版本号**：市场条目里的 `latest/download/dsh-persona-self-review.tgz` 只解析 `latest`，文件名是照字面取的，带版本号会在下一次发版时静默 404。
5. 同步 git tag 与仓库：`git push --follow-tags`。

## 进市场（awesome-dsh-plugin）

市场的插件列表来自 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的 `data/plugins/*.yml`，**不是**往 dshmarket 仓库提。

- 条目文件：`data/plugins/5923Cx__dsh-persona-self-review.yml`（一次 PR 只加这一个文件）。
- 内容见仓库外的 `publish/5923Cx__dsh-persona-self-review.yml`（已写好，含 `tarball` 字段）。
- 硬性条件：
  - 仓库公开、`package.json` 声明 `dsh.bundle`（本仓库已满足）；
  - 仓库创建**满 1 天**（CI 自动查，不到就等几小时再重提）；
  - 给仓库加 **`dsh-plugin`** topic；
  - `description.en` 必填、以句号结尾、只写功能不带营销词，且要与代码一致。
- 合并后站点与 dshmarket 会自动收录（通常一天内），无需再做什么。

## 改包名会动到本机的哪一处

本机 profile（`%USERPROFILE%\.dsh\profiles\desktop`）把本目录装成了本地链接，包名写在两个地方：

```json
"dependencies": { "dsh-persona-self-review": "link:E:/大肥鱼工作区/dsh-persona-card" },
"dsh": { "profile": { "bundles": [ ..., "dsh-persona-self-review" ] } }
```

改名后必须把这两处换成新包名并重装一次（`dsh plugin remove` + `dsh plugin add`，或在插件面板里删掉重加），否则 DSH 启动时找不到 `dsh-persona-card` 模块，角色卡面板会消失。

## 发版前自查

- `node test/*.test.mjs` 全绿（当前 28 项）。
- `npm pack` 出来的文件清单里没有 `state.json`、`cards/`、备份目录与任何本机路径。
- 插件运行时不联网、不上传数据；读写只在 `$DSH_HOME/persona-card/` 与用户配置的备份目录。
- 本地 HTTP 写接口要求 `x-persona-card: 1` 头，跨站页面无法伪造（这是 CSRF 缓解，不是访问控制）。
- 代码里不出现用户名、绝对路径、令牌。
- `locale/en.json` 与 `locale/zh.json` 的 `meta.title` / `meta.description` 描述的功能必须真实存在。
