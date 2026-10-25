# @local/dsh-balance

在 DeepSeek Harness Web UI 里直接看 DeepSeek 开放平台账户余额（`/user/balance`）的本地插件。

- **侧边栏底部胶囊**：常驻显示 `¥110.25`，点一下就刷新；侧边栏收起时只显示货币符号。
- **设置 → 通用 → DeepSeek API 余额** 一行：金额、更新时间、赠送金额提示、刷新按钮；没配 key / key 失效 / 网络失败时直接在这一行说明原因和 key 文件路径。
- 页面打开期间每 30 秒自动刷新，切回标签页时立即刷新一次。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：注册 `/api/deepseek-balance/state`（走 Connection 的登录校验）和 `/dsh-balance/ping`（只回插件名，无账户数据）。读取 key 并请求 `https://api.deepseek.com/user/balance`。 |
| `client.js` | 浏览器半边：`window.__ModuleLoader__.load` 注册懒工厂，注入 `settings.general.item` 与 `sidebar.footer.action` 两个槽位。 |
| `cordis.patch.yml` | 作为 bundle 安装时的默认补丁（`install_bundle` 用）。 |
| `test/smoke.mjs` | 不依赖 Harness 和浏览器的离线冒烟测试：Host 半边打本地 mock 余额接口，Client 半边用合成状态渲染两个界面。 |

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
| `apiKey` | — | 直接给 key（会明文进 profile 配置，不推荐） |
| `apiKeyFile` | `~/.config/deepseek/api_key` | 从文件读 key，支持 `~/` |
| `apiBase` | `https://api.deepseek.com` | 换网关/代理时改这里 |
| `timeoutMs` | `15000` | 单次请求超时 |
| `cacheMs` | `1500` | 并发请求合并窗口，避免多个页面同时打接口 |

key 的解析顺序：`config.apiKey` → 环境变量 `DEEPSEEK_API_KEY` → `apiKeyFile`。

## 配置 key

```sh
mkdir -p ~/.config/deepseek
printf '%s' 'sk-...' > ~/.config/deepseek/api_key
chmod 600 ~/.config/deepseek/api_key
```

key 只在 Host 进程内使用，不会进页面：状态接口只返回钱包金额、币种、key 尾 4 位和 key 文件路径。

## 验证

```sh
node test/smoke.mjs                                   # 离线冒烟测试
curl -s http://127.0.0.1:13080/dsh-balance/ping       # Host 半边是否已加载
curl -s http://127.0.0.1:13080/plugins/@local/dsh-balance/client.js | head  # 浏览器包是否已纳入模块图
```
