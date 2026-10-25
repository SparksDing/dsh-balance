# @local/dsh-balance

在 DeepSeek Harness Web UI 里直接看 DeepSeek 开放平台账户余额（`/user/balance`）的本地插件。

- **侧边栏底部胶囊**：常驻显示 `¥110.25`，点一下就刷新；侧边栏收起时只显示货币符号。
- **设置 → 通用 → DeepSeek API 余额** 一行：金额、更新时间、赠送金额提示、刷新按钮；没配 key / key 失效 / 网络失败时直接在这一行说明原因。
- **key 直接在界面上管**：点「设置 key」粘贴保存，保存前先用 `/user/balance` 校验一次，只有校验通过才写盘；已配置后可以「更换 key」或「清除」。不用 shell，key 也不经过浏览器之外的任何地方。
- 页面打开期间每 30 秒自动刷新，切回标签页时立即刷新一次。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：注册 `/api/deepseek-balance/state`（GET，读余额）、`/api/deepseek-balance/key`（POST，存/清 key）和 `/dsh-balance/ping`（只回插件名，无账户数据）。前两个走 Connection 的登录校验。 |
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

**当 bundle 装**：本目录本身就是一个 bundle（`package.json` 里有 `dsh.bundle` 和 `dsh.client`），用 Creator 模式 / 侧边栏 Plugins 页的 `install_bundle` 指向这个绝对目录即可，之后随 profile 一起持久化。

配置项都写在那一行的 `config:` 下，都是可选的：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `apiKey` | — | 直接给 key（会明文进 profile 配置，不推荐；界面写入的文件更合适） |
| `apiKeyFile` | `~/.config/deepseek/api_key` | 读写 key 的文件，支持 `~/` |
| `apiBase` | `https://api.deepseek.com` | 换网关/代理时改这里 |
| `timeoutMs` | `15000` | 单次请求超时 |
| `cacheMs` | `1500` | 并发请求合并窗口，避免多个页面同时打接口 |

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
node test/smoke.mjs                                   # 离线冒烟测试
curl -s http://127.0.0.1:13080/dsh-balance/ping       # Host 半边是否已加载
```

浏览器包是否已进模块图可以看 HMR 事件流（公开、只读）：

```sh
curl -sN http://127.0.0.1:13080/plugins/events | head -c 4000 | grep -o '"id":"@local/dsh-balance"[^}]*'
```
