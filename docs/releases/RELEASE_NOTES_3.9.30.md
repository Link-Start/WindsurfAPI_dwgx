# v3.9.30

`/v1/models` 在 selector `glm-5-2` 上列出 `glm-5.2`，不再被更早的 `glm-5.1` 别名挡住。
无 API 破坏。升级不要求改配置。ACU `^22` 仍默认关。

---

## 用户可感知

### `/v1/models` 列出 glm-5.2，而不是 glm-5.1

Connect 目录里 `glm-5.1` 是 `glm-5-2` 的别名，而且排在 `glm-5.2` 前面。discovery
按 selector 去重时「先到先得」，公开 id 就停在过期的 `glm-5.1`。

本版是 **精确 overlay**：只对 selector `glm-5-2` 改成公开 id `glm-5.2`。不引入
按前缀打分的 representative 排序（那会把 `gpt-5.5` 改成 `gpt-5.5-low`）。

ACU `^22` 仍默认关。`FREE_TIER_SELECTOR` 仍是 `swe-1-6-slow`。不扩
`FREE_REACHABLE_SELECTORS`。

实测：`test/models-live-catalog.test.js` 含 glm-5.2 overlay 断言。
`node --check src/index.js`、`node src/dashboard/check-i18n.js`、
`npm run secret-scan` 在本机跑过。

---

## 工程

OTA 跟 annotated tag。v3.9.29 OTA 用户吃不到 `1b0e7a1` 的目录展示修正，本 tag
把它发出去。

#258 仍开：等报告者旱灾下 `swe-1-7` / `glm-5.2` 确认 200。#250 / #245 /
#236 / #239 / #208 球仍在报告者。#259 OrcaRouter 未合（closed, not planned）。

Windows `npm run test:release` 仍是机门：unix-git 夹具 + heading-slug 中文/emoji
误报；Linux CI 是权威。突变规格未在本机重跑。
