# v3.9.35

三条 wire 层提交:**一个 `DEVIN_CONNECT_REPLAY_REASONING` 开启时才可见的修复**(只带 reasoning 的
assistant 历史回合此前被整条丢弃),外加两处**行为零变化**的契约澄清(orphan 过滤器的作用域、
reasoning replay 的发射次数与别名优先级)。默认路径**逐字节不变** —— 270 组完整请求 Buffer
与 v3.9.34 对拍一致。无 API 破坏。ACU `^22` 仍默认关。

---

## 用户可感知

### replay 开启时,只带 reasoning 的 assistant 回合不再被吞(`e0143fd`)

设了 `DEVIN_CONNECT_REPLAY_REASONING=1`(或 `9`)的部署里,一条**只有 `reasoning` /
`reasoning_content`**、没有文本也没有工具调用的 assistant 历史,会被空回合过滤器在编码之前丢掉:
`messageText()` 对无文本内容返回空串,而过滤器排在 reasoning 分支之前。操作者打开了 replay 开关,
wire 上却看不到任何 #11 —— 开关看起来没生效。

本版只在"**该开关已打开、且确实有非空载荷**"时放行;tag=0(默认)短路,默认 wire 逐字节不变。

**影响面:仅限设了 `DEVIN_CONNECT_REPLAY_REASONING` 的部署。** 没设这个开关的用户,新旧
wire 完全一致(实测:同一确定性输入下 270 组完整请求 Buffer 与 v3.9.34 零差异;逐字节比较,
不是剔除 UUID 之后的投影)。

**没有顺手做的**:content **只有图片**的 assistant 回合仍按原样排除。图片发射(`tag=10`)默认开着,
放行它是**默认行为变化**,需要先测上游对「assistant 回合携带图片」的接受度 —— 见
[#272](https://github.com/dwgx/WindsurfAPI/issues/272)(附最小对照实验;修的时候必须同时替换
现有的兼容锁测试与其突变)。

## 工程

### orphan 过滤器:语义写准 + 行为守卫(`6b8762f`)

`stripOrphanedToolResults()` 判定的是「这段输入里**完全找不到**父 call」,不是函数头注释此前说的
"earlier in the conversation" —— 结果出现在它的 call **之前**时会被保留。这是**有意**的:改成
"seen-so-far" 会静默删掉一个父调用仍存在于后文的结果,并把一个待执行调用交还给客户端
(客户端可能重跑已经完成的动作)。本版**不改行为**,只把注释改成事实,并用 `direct` /
`normalize` / 显式 `strip` 三条入口的行为测试钉住(4 用例 + 5 条突变,全部可杀死)。

### reasoning replay:注释分离「抓包事实 / 当前政策 / 未证明的要求」(`40f2320`)

编码器注释此前读起来像「req022 要求每个 role=2 帧都带 #11」。那份抓包只证明**字段存在**
(59B–1470B),不证明同一逻辑回合拆出的各帧**载荷相等**,也不是「replay 默认应开」的依据。
本版不改任何可执行语句,把三处注释分开,并用 4 用例 + 11 条突变钉死实际行为:

- replay=1 时 raw builder 把同一段 reasoning 写到 preText 帧与**每个** call 帧(k+1 份,无 preText 为 k 份);
- 经过既有交错预处理(完整匹配的 batch)后,实际是 **2 份 / 1 份**;
- 别名优先级是 `reasoning || reasoning_content`(first-truthy),两个编码分支各自的 trim 行为不变。

逐帧相等性与「result 先于 call」的上游语义待现场校准 —— 见
[#273](https://github.com/dwgx/WindsurfAPI/issues/273)。

### 验证

- 新增 **23 条突变全部 CAUGHT**(7 + 5 + 11),`spec-static-check`:**52 specs / 611 mutations** exit 0;
- `npm test`:4328 条 / 4323 pass(5 条为 Windows real-Git 机器闸,非产品失败);
- 270 / 270 完整请求字节与 v3.9.34 一致;`secret-scan` clean;`git diff --check` clean。
