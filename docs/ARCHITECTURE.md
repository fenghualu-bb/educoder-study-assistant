# 架构说明

## 进程与组件

```
Electron 主进程 (src/desktop-main.js)
 ├─ 主窗口 ── 加载 http://127.0.0.1:<随机端口>  ← src/runtime.js + src/server.js
 │             界面：public/index.html, app.js, personal-home.js
 ├─ 本机控制器 (src/controller.js)
 │    └─ 通过 playwright-core 启动专用 Edge 浏览器（独立资料目录）
 │         读取“我的课堂”、逐页只读扫描视频列表 (src/chrome.js, src/inventory.js)
 └─ 观看管理 (src/local-manual-video.js)
      ├─ 单条观看 SingleController (src/local-single-video/controller.mjs)
      └─ 多条连续播放 PersonalQueueController (src/personal-queue-controller.mjs)
```

- **本机服务**只监听 `127.0.0.1`，会校验 `Host` 和 `Origin`；桌面模式下，每次启动生成一个 CSRF 令牌，所有写操作都要带上。
- **专用浏览器**使用独立的资料目录。用户在官方页面自己登录，应用不接触密码。
- **观看窗口**和主窗口之间通过 preload 暴露的 IPC 通信（`src/desktop-preload.cjs`、`src/local-single-video/preload.cjs`）。主进程会核对消息的发送方框架。

## 播放控制原则

`src/local-single-video/official-player-controls.mjs` 是唯一操作官方播放器的地方：

- 写操作全部是对官方控件的普通点击：播放/暂停按钮、`#volume-button`、“倍速”菜单、进度条。
- 对 `<video>` 元素只读取状态（`paused`、`currentTime`、`duration`、`playbackRate`），不直接赋值。
- 每次点击后都会回读实际状态来确认，确认不了就报出明确的错误码，不会自动换别的方式强行操作。

## 完成判定

本机播放到结尾**不**算完成。连续播放时，一条视频要同时满足下面三点，才会进入下一条：

1. 媒体自然播放结束；
2. 本机位置记录保存成功；
3. 重新读取官方列表，确认该视频显示 100%。

官方确认在限定次数内还没出现，就暂停等待用户处理。

## 错误与恢复

- 能恢复的问题会间隔等待后重新核对所选视频，例如网络中断、媒体或官方控件尚未就绪、页面跳回首页（见 `recoverablePlaybackCodes`）。用户随时可以暂停或结束。
- 登录失效、检查点、身份核验、平台限制、视频身份不符时直接停止，交给用户处理。
- 本机记录先写临时文件再改名替换。读到损坏或较新的并发记录时保留原文件，不覆盖。

## 本机数据

位于 Electron `userData` 目录，包括：

| 文件 | 内容 |
|---|---|
| `course-inventory.json` | 最近一次扫描的课堂视频清单与官方进度 |
| `run-journal.json` | 早期自动任务的运行记录（桌面版中该入口已关闭） |
| 观看位置、播放设置、连续播放批次 | 每个课堂、每条视频的本机位置；静音/倍速设置；当前批次状态 |

升级时，`src/data-upgrade.js` 会先备份旧数据，再写入新版本标记。

## 早期自动任务入口

`controller.start()` 和 `/api/start` 是早期“受限试运行”（一次 1–3 条）的实现。桌面版通过 `legacyRunnerDisabled` 把它关闭了，界面上也不显示，只保留供测试和参考。实际观看都走热力图 → 观看窗口这条路径。
