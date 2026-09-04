# v3.9.31

Connect 路径上，allowlist/blocklist 里的 `glm-5.1` 与 `glm-5.2` 视为同一条。
无 API 破坏。ACU `^22` 仍默认关。

---

## 用户可感知

### 名单里的 glm-5.1 仍挡住（或放行）glm-5.2

v3.9.30 把 `/v1/models` 的公开 id 从 `glm-5.1` 改成 `glm-5.2`。访问控制按**原文字符串**匹配，只继承 `-thinking`。自动发现客户端会去请求 `glm-5.2`：

- **blocklist** 写着 `glm-5.1`：挡不住，付费用量漏过去
- **allowlist** 写着 `glm-5.1`：无 default 时 403；有 default 时静默落到别的模型

本版只在 **DEVIN_CONNECT** 上把 `glm-5.1` ↔ `glm-5.2` 当同一条。Cascade 的 uid
（`glm-5-1` / `glm-5-2`）仍分开。不把整张名单丢进 `resolveConnectSelector`。

ACU `^22` 仍默认关。`FREE_TIER_SELECTOR` 仍是 `swe-1-6-slow`。

实测：`test/model-access-glm52-connect.test.js` + thinking/default-model 共 21/21。

---

## 工程

OTA 跟 annotated tag。v3.9.30 的「无 API 破坏 / 升级不要求改配置」对带着
`glm-5.1` 名单的运营者不成立；那份 notes 钉在 tag 上不改。本 tag 修门。

Windows 轻门：`node --check src/index.js`、i18n、secret-scan。突变规格未在本机重跑。
