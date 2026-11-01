# 参与贡献 / Contributing

感谢你愿意花时间改进若道安全卫士。本文说明怎么提问题、怎么提交代码，以及几条必须守住的底线。

> Thanks for improving Ruodao Guard. This document covers reporting issues, submitting code, and the few non-negotiable rules.

---

## 🐛 报告问题 / Reporting issues

提 Issue 前请先搜索现有 Issue，很可能已经有人遇到过。

一个能被快速处理的问题报告通常包含：

| 信息 | 从哪来 |
| --- | --- |
| 操作系统版本 | 设置 → 应用信息 |
| 应用版本、Electron / Node 版本 | 设置 → 应用信息 |
| 是否以管理员身份运行 | 标题栏提示 |
| 复现步骤 | 越具体越好，1→2→3 |
| 期望结果 vs 实际结果 | 直接说明差异 |
| 截图或日志 | 界面问题必须带截图 |

**不要贴敏感信息**：真实姓名、完整文件路径中的用户名、API Key、公司内网地址。日志请先脱敏。

安全漏洞**不要**开公开 Issue，见 [SECURITY.md](SECURITY.md)。

---

## 💡 提交代码 / Submitting code

### 流程

```bash
# 1. Fork 本仓库，然后克隆你自己的 fork
git clone https://github.com/<you>/ruodao-guard-desktop.git
cd ruodao-guard-desktop

# 2. 从 main 切分支
git checkout -b feat/your-feature

# 3. 本地开发
npm install
npm run dev

# 4. 提交前必过
npm run typecheck
npm run build
```

5. 提交 PR，说明**改了什么、为什么改、怎么验证的**。

### 分支命名

| 前缀 | 用途 |
| --- | --- |
| `feat/` | 新功能 |
| `fix/` | 缺陷修复 |
| `refactor/` | 重构（行为不变） |
| `docs/` | 文档 |
| `perf/` | 性能 |

### 代码约定

- **TypeScript 严格模式**，不要用 `any` 绕类型检查；共享类型放 `src/shared/types.ts`，它是主进程与渲染进程的单一事实来源。
- **业务逻辑只在主进程**。渲染进程不直接调用系统能力，一律通过 `window.ruodao`。
- **新增 IPC 必须走 `src/main/ipc.ts`**，并使用现有的 `requireXxx` 系列函数做参数校验。渲染进程传入的一切都视为不可信输入。
- **统一返回结构**：`{ ok: true, data }` / `{ ok: false, error }`。错误信息用中文，写清楚用户能看懂的原因。
- **界面文案用中文**，语气简洁、说人话，不堆术语。
- **不要引入重型依赖**。当前界面没有任何 UI 框架，这是有意为之；能用 CSS 解决就不要加库。
- 提交信息用中文或英文都可以，但要说明**意图**，不要写 "update" "fix bug"。

### 新增一个系统操作时的检查清单

这是本项目最重要的约定。任何会改动系统的功能，都必须满足：

- [ ] **可回溯**：改动前保存原始状态（注册表备份、配置文件、清单）
- [ ] **可撤销**：用户能一键恢复，而不是只能靠系统还原点
- [ ] **要确认**：危险动作弹二次确认，写清楚改什么、影响什么
- [ ] **有日志**：写入 `risklog`，用户能查到"谁在什么时候改了什么"
- [ ] **最小权限**：非必要不请求管理员；需要提权时单独拉起辅助进程
- [ ] **失败可回滚**：中途失败要能恢复到操作前的状态，并给出明确错误

不满足以上任一条的 PR 会被要求修改——这不是洁癖，是这个应用敢动系统设置的前提。

### 新增检测规则的特别说明

如果你要加特征或启发式规则：

- 特征库在 `src/main/data/signatures.ts`；
- **不要在仓库里提交真实恶意软件样本**，也不要提交会触发他人杀软的二进制；
- 用 EICAR 或自建无害样本验证流程；
- 规则要写清 `description`，说明**为什么这条规则能识别威胁**，而不是只写个名字。

---

## ✅ 审查标准

PR 合并前会看：

1. 能否通过 `npm run typecheck` 与 `npm run build`；
2. 是否遵守上面的「新增系统操作检查清单」；
3. 是否有测试或可复现的验证步骤；
4. 是否引入不必要的依赖或复杂度；
5. 是否会破坏现有用户的数据（隔离区、备份、日志格式的向后兼容）。

---

## 📄 许可

提交 PR 即表示你同意以 [MIT](LICENSE) 协议授权你的贡献。

---

## English summary

- Search existing issues first; include OS version, app version, admin status, reproduction steps, expected vs. actual, and screenshots.
- Never paste secrets, usernames from full paths, or internal addresses. Do not open public issues for security vulnerabilities — see [SECURITY.md](SECURITY.md).
- Branch from `main` using `feat/`, `fix/`, `refactor/`, `docs/` or `perf/` prefixes. `npm run typecheck` and `npm run build` must pass.
- Business logic lives in the main process. The renderer talks to the system only through `window.ruodao`. New IPC handlers go in `src/main/ipc.ts` and must validate every argument — treat all renderer input as untrusted.
- Handlers return `{ ok: true, data }` or `{ ok: false, error }`. UI copy is Chinese, plain and non-technical.
- Avoid heavy dependencies; the UI intentionally has no framework.
- **Every system-modifying feature must be traceable, reversible, confirmation-gated, logged, least-privilege and rollback-safe.** PRs that skip this will be asked to change.
- Never commit real malware samples or binaries that trip other people's AV. Validate with EICAR or harmless custom samples.
- Contributions are accepted under the [MIT](LICENSE) license.
