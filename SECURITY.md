# 安全策略 / Security Policy

## 支持范围

| 版本 | 是否接受安全报告 |
| --- | --- |
| 最新 Release | ✅ |
| `main` 分支 | ✅ |
| 更早版本 | ❌ 请先升级 |

## 报告安全问题

**请不要开公开 Issue。** 安全问题的价值在于被修复之前不为人知。

请通过以下任一渠道私下联系：

- 发送邮件至项目维护者（见仓库提交记录中的联系方式）；
- 或在 GitHub 上使用 **Security → Report a vulnerability**（私有漏洞报告）。

请尽量包含：

1. 受影响的版本与操作系统；
2. 问题的类型（例如：IPC 参数校验绕过、路径穿越、任意命令执行、信息泄露）；
3. 复现步骤或 PoC（**请不要附带真实恶意样本**）；
4. 影响评估：能读到什么、能改什么、需要什么前置条件（例如是否需要用户交互、是否需要管理员）。

### 我们会怎么做

- **3 个工作日内**确认收到；
- 评估影响并给出修复计划；
- 修复发布后，如果你愿意，会在 Release Notes 中致谢。

### 请负责任地测试

- 只在你自己的机器和你拥有授权的环境上测试；
- 不要在测试中读取、修改或外传他人的数据；
- 不要做拒绝服务、社工或物理攻击类测试。

---

## 本项目已知的安全设计边界

了解这些能帮你判断"某个行为是不是漏洞"：

| 设计 | 说明 |
| --- | --- |
| 以用户权限运行为默认 | 应用不以管理员身份启动；需要提权的操作单独请求 |
| 渲染进程无系统能力 | 全部系统调用在主进程，渲染进程只能调 `window.ruodao` 暴露的白名单 API |
| IPC 参数强校验 | 类型、长度、枚举、路径、PID 范围、GUID 格式全部校验，非法输入直接拒绝 |
| 外链白名单 | 只允许打开 `https://ruodao.com` 域的链接 |
| 权限请求全拒 | Web 权限（摄像头、定位等）一律拒绝 |
| 不驻留、无驱动 | 没有常驻服务、没有内核驱动，攻击面显著小于传统安全软件 |
| API Key 加密存储 | 使用 Windows DPAPI（Electron `safeStorage`），无法从界面回读明文 |

**不属于漏洞的情况**：应用以用户身份执行了你明确点击的操作（例如你点了"结束进程"）；应用读取了你本机已有的系统信息并在界面上展示给你自己；内置特征库只能识别 EICAR 与启发式规则（这是项目定位，已在 README 中明确声明）。

---

## English summary

- Supported: latest release and `main`. Older versions: upgrade first.
- **Do not open a public issue for security problems.** Use GitHub's private *Report a vulnerability* flow, or email the maintainer listed in the commit history.
- Include affected version, OS, vulnerability class, reproduction steps or PoC (never attach real malware), and an impact assessment.
- We acknowledge within 3 business days. Reporter credit is offered in the release notes.
- Test only on machines you own or are authorized to test, never touch other people's data, and no DoS, social engineering or physical attacks.
- Known design boundaries: the app runs unelevated by default, the renderer has no system access, all IPC arguments are validated, external links are allowlisted to `ruodao.com`, web permissions are denied, there is no resident service or kernel driver, and API keys are encrypted with Windows DPAPI. A user-confirmed action executing as the user is not a vulnerability. The limited signature database (EICAR + heuristics) is a documented design choice, not a flaw.
