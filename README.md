# @local/dsh-balance

在 DeepSeek Harness Web UI 里直接看 DeepSeek 开放平台账户余额（`/user/balance`）的本地插件。

- **侧边栏底部胶囊**：常驻显示 `¥110.25`，点一下就刷新；侧边栏收起时只显示货币符号。
- **设置 → 通用 → DeepSeek API 余额** 一行：金额、更新时间、赠送金额提示、刷新按钮；没配 key / key 失效 / 网络失败时直接在这一行说明原因。
- **key 直接在界面上管**：点「设置 key」粘贴保存，保存前先用 `/user/balance` 校验一次，只有校验通过才写盘；已配置后可以「更换 key」或「清除」。不用 shell，key 也不经过浏览器之外的任何地方。
- **设置 → 通用 → 系统状态** 一行：CPU 使用率、核数、负载、内存，以及文件系统的已用/总量与百分比（`/`、`/boot/efi` 等，按容量倒序取前 8 个）。
- 点这一行的「详情」展开：磁盘读/写速率、网络收/发速率、四张迷你趋势图（CPU、内存、磁盘写、网络收，各取最近 40 个采样点），以及全部挂载点的用量表。
- **设置 → 通用 → 消耗**：把每次调用的 token 用量折成钱——今日花费、缓存命中率、当前是高峰还是平峰，点「详情」按模型列出命中/未命中/输出 token 与各自花费。
- **侧边栏底部胶囊**：余额旁边再挂一个 `CPU 12.5%`，鼠标悬停看磁盘使用率；侧边栏收起时这个胶囊自动隐藏，只留余额符号。
- 余额每 30 秒、系统状态每 10 秒自动刷新；切回标签页时立即刷新一次。CPU 由 Host 每 3 秒读一次 `/proc/stat` 求差值。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：注册 `/api/deepseek-balance/state`（GET，读余额）、`/api/deepseek-balance/key`（POST，存/清 key）、`/api/deepseek-balance/sysmon`（GET，CPU/磁盘/负载）和 `/dsh-balance/ping`（只回插件名、版本与路由表，无账户数据）。前三个走 Connection 的登录校验。 |
| `sysmon.js` | 系统采样：`/proc/stat` 求 CPU 占用、`/proc/meminfo` 求内存、`/proc/diskstats` 求磁盘读写速率、`/proc/net/dev` 求网络速率、`/proc/mounts` + `statfs` 求各挂载点用量，另加负载均值和 40 点趋势环形缓存。全是累计计数器求差 + 可注入依赖，便于离线测试。 |
| `usage.js` | 花费核算：订阅 `session/event`，把每条带 `usage` 的 `assistant/message` 按模型单价折成美元/人民币，按本地自然日归零；含 DeepSeek 高峰（UTC 01:00–04:00、06:00–10:00 工作日，价格翻倍）判定。 |
| `http.js` | 各路由共用的 JSON 响应构造。 |
| `client.js` | 浏览器半边：`window.__ModuleLoader__.load` 注册懒工厂，注入 `settings.general.item` 与 `sidebar.footer.action` 两个槽位。 |
| `cordis.patch.yml` | 作为 bundle 安装时的默认补丁（`install_bundle` 用）。 |
| `test/smoke.mjs` | 不依赖 Harness 和浏览器的离线冒烟测试：Host 半边打本地 mock 余额接口（含 key 写入/清除/拒绝路径），Client 半边用合成状态渲染两个界面。 |

## 装到你的 profile

两条路，任选一条：

**手动插一行**：在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 末尾追加（路径按你的实际情况改成插件目录）：

```yaml
- insert:
    - id: dsh-balance
      name: ../../../studyDsh/dsh-balance/index.js
```

HMR 打开时保存文件即生效；没开 HMR 则重启 `dsh web`。

一个实测到的坑：只改文件内容、保持同一个模块路径时，运行中的 Host 不会重新导入（Node 的 ESM 缓存按 URL 复用），热替换只有在**模块 specifier 变化**时才真正生效。所以本地迭代可以像本仓库作者那样把 Host 入口放到版本化子目录（如 `./dsh-balance/0.3.0/index.js`）并改那一行，或者干脆重启一次 `dsh web`。

**当 bundle 装**：本目录本身就是一个 bundle（`package.json` 里有 `dsh.bundle` 和 `dsh.client`），用 Creator 模式 / 侧边栏 Plugins 页的 `install_bundle` 指向这个绝对目录即可，之后随 profile 一起持久化。

配置项都写在那一行的 `config:` 下，都是可选的：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `apiKey` | — | 直接给 key（会明文进 profile 配置，不推荐；界面写入的文件更合适） |
| `apiKeyFile` | `~/.config/deepseek/api_key` | 读写 key 的文件，支持 `~/` |
| `apiBase` | `https://api.deepseek.com` | 换网关/代理时改这里 |
| `timeoutMs` | `15000` | 单次请求超时 |
| `cacheMs` | `1500` | 并发请求合并窗口，避免多个页面同时打接口 |
| `sysmonIntervalMs` | `3000` | CPU/磁盘采样间隔；路由只读最近一次快照 |
| `usdToCny` | `7.1` | 花费面板的美元→人民币汇率 |
| `prices` | 内置 DeepSeek 价目 | 覆盖单价：`{ flash: { cacheHit, miss, output }, pro: {...} }`（USD / 1M tokens，平峰价；高峰自动 ×2） |

key 的解析顺序：`config.apiKey` → 环境变量 `DEEPSEEK_API_KEY` → `apiKeyFile`。前两者存在时，界面上的「更换/清除」不会改变解析结果，那一行会提示「当前 key 来自插件配置/环境变量」。

## 配置 key

在界面上点「设置 key」粘贴即可，等价于自己写文件：

```sh
mkdir -p ~/.config/deepseek
printf '%s' 'sk-...' > ~/.config/deepseek/api_key
chmod 600 ~/.config/deepseek/api_key
```

key 只在 Host 进程内使用，不进页面也不进仓库：状态接口只返回钱包金额、币种、key 尾 4 位和 key 文件路径；写入接口校验通过后以 600 权限落盘。

## 验证

```sh
node test/smoke.mjs                                   # 离线冒烟测试（余额 + key 写入 + 系统采样）
curl -s http://127.0.0.1:13080/dsh-balance/ping       # Host 半边是否已加载、版本与路由
```

ping 会回 `{"ok":true,"plugin":"@local/dsh-balance","version":"0.3.0","routes":[...]}`，`routes` 里能直接看出 sysmon 路由有没有注册上。

浏览器包是否已进模块图可以看 HMR 事件流（公开、只读）：

```sh
curl -sN http://127.0.0.1:13080/plugins/events | head -c 4000 | grep -o '"id":"@local/dsh-balance"[^}]*'
```
