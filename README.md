# 头歌学习助手

一个 Windows 桌面应用，用来查看[头歌（EduCoder）](https://www.educoder.net)课堂里每条视频的官方完成进度，并在本机打开所选视频观看。

- **只读扫描进度**：在专用浏览器里自行登录头歌，读取“我的课堂”，逐页扫描“视频直播”总列表。
- **热力图**：一行对应一页，一格对应一条视频，颜色从白到深蓝表示官方完成百分比，读不到的进度单独标出。
- **观看所选视频**：点击热力图上的一个方格，打开单条视频观看窗口。可以保存并恢复本机观看位置。

> [!WARNING]
> **使用前请阅读**
>
> - 本项目与头歌平台及任何学校**没有关联**，是供本人学习使用的非官方工具。
> - 使用前请自行确认所在学校、课程和头歌[用户协议](https://www.educoder.net)是否允许使用此类工具。违反规定可能导致账号受限或其他后果，责任由使用者自行承担。
> - 本工具不会自动播放或替你完成视频。请自行观看并在官方页面处理课堂检查点。
> - 头歌官网更新后，部分读取功能可能需要适配。

## 系统要求

- Windows 10 / 11 x64
- Microsoft Edge（应用使用系统自带的 Edge 打开头歌官方页面）

## 安装

从 [Releases](../../releases) 下载 `educoder-study-assistant-<版本>-candidate-win-x64-setup.exe`，双击安装。安装在当前用户目录下，不需要管理员权限，会在桌面创建快捷方式。

安装包**没有代码签名**，Windows SmartScreen 可能提示“未知发布者”。请先核对 Release 页面给出的 SHA256，再决定是否运行。

## 使用

1. 点击“打开官方登录窗口”，在弹出的头歌页面里自己登录。
2. 回到助手，点击“读取我的课堂”，选择一个课堂；助手会只读扫描它的视频列表。
3. 点击热力图上的一个方格，打开观看窗口，再点击“准备所选视频”。
4. 如果有本机记录，可以先选择恢复位置。点击“播放”后开始观看。视频结束后，可返回课堂自行选另一条。

## 数据与隐私

- 所有数据都保存在本机，路径为 `%APPDATA%\educoder-local-study-control\` 和 Electron 会话目录。没有任何服务器端，也不会上传数据。
- 头歌账号只在官方页面登录，助手不读取、不保存你的密码。
- 本机记录包括课堂视频清单和本机观看位置。头歌登录状态由专用浏览器保存。

## 开发

需要 Node.js 20 或更高版本（开发时使用 Node 24）。

```bash
npm install
```

使用系统 Edge 启动桌面应用（开发模式）：

```bash
npm run desktop:start -- --study-browser=edge
```

运行测试：

```bash
npm test
```

界面测试会用无头模式启动 Chrome。默认路径是 `C:\Program Files\Google\Chrome\Application\chrome.exe`；装在别处的话，用环境变量 `CHROME_PATH` 指定。

### 构建安装包

```bash
npm run desktop:installer
```

构建依赖：

- [7-Zip](https://www.7-zip.org/)，安装在 `C:\Program Files\7-Zip\7z.exe`
- Windows 自带的 .NET Framework 4 编译器 `csc.exe`

构建过程会审计安装包内容（不得包含 data、浏览器资料、测试、文档），核对运行源码是否一致，并用打包的可执行文件验证运行模块能够加载。产物在 `out/installers/`，同目录的 JSON 文件记录了 SHA256 和逐文件哈希。

## 项目结构

```
src/
  desktop-main.js          Electron 入口
  desktop-lifecycle.js     主窗口与安全关闭
  runtime.js / server.js   本机 127.0.0.1 控制台服务（带 CSRF 令牌）
  controller.js            官方会话、课堂读取与只读扫描
  chrome.js / inventory.js 解析头歌视频列表页
  local-manual-video.js    热力图选择与单视频窗口
  local-single-video/      单条视频观看：官方控件操作、位置记录、恢复
public/                    控制台界面（热力图、主页）
installer/                 自解压安装器（C#）
scripts/                   构建、打包审计、启动冒烟测试
test/                      node:test 测试
```

更多设计说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 已知限制

- 依赖头歌当前的页面结构，比如 `#video-controls` 与视频列表的 DOM。官网改版后需要更新定位规则。
- 只处理课堂“视频直播”总列表里的视频，不处理直播、测验、作业、签到或检查点。
- 电脑需要保持开机、不休眠，播放才能继续。
- 只支持 Windows。

## 许可证

[MIT](LICENSE)
