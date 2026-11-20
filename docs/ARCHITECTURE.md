# 架构说明

## 进程与组件

```
Electron 主进程 (src/desktop-main.js)
 ├─ 主窗口 ── 加载 http://127.0.0.1:<随机端口>  ← src/runtime.js + src/server.js
 │             界面：public/index.html, app.js
 ├─ 本机控制器 (src/controller.js)
 │    └─ 通过 playwright-core 启动专用 Edge 浏览器（独立资料目录）
 │         读取“我的课堂”、逐页只读扫描视频列表 (src/chrome.js, src/inventory.js)
 └─ 观看管理 (src/local-manual-video.js)
      └─ 单条观看 SingleController (src/local-single-video/controller.mjs)
```

- **本机服务**只监听 `127.0.0.1`，会校验 `Host` 和 `Origin`；桌面模式下，每次启动生成一个 CSRF 令牌，所有写操作都要带上。
- **专用浏览器**使用独立的资料目录。用户在官方页面自己登录，应用不接触密码。
- **观看窗口**和主窗口之间通过 preload 暴露的 IPC 通信（`src/desktop-preload.cjs`、`src/local-single-video/preload.cjs`）。主进程会核对消息的发送方框架。

## 单条观看与进度

热力图上的百分比来自官方列表。用户点选方格后，助手核对课堂、列表位置和标题，再打开观看窗口。单条视频准备完成后保持暂停。用户可以查看官方窗口、用官方控件恢复本机记录，或手动开始播放。
本机观察到的播放位置单独保存。视频结束后，是否观看下一条由用户决定。

## 错误与恢复

- 网络或播放器出错时，助手保存已观察到的位置并显示提示，用户可以主动重试。
- 登录失效、检查点、身份核验、平台限制、视频身份不符时直接停止，交给用户处理。
- 本机记录先写临时文件再改名替换。读到损坏或较新的并发记录时保留原文件，不覆盖。

## 本机数据

位于 Electron `userData` 目录，包括：

| 文件 | 内容 |
|---|---|
| `course-inventory.json` | 最近一次扫描的课堂视频清单与官方进度 |
| 每条视频的本机记录 | 保存从实际观看中观察到的位置 |

升级时，`src/data-upgrade.js` 会先备份旧数据，再写入新版本标记。
