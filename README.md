# 微醺屿 · TipsyIsle

一个可在 Windows、Android 和本地网页上使用的 AI 角色扮演工作台。导入角色卡、世界书和预设，连接自己的模型服务，就能开始对话。

- **剧情分支**：可以从一段剧情重新选择，同时保留原路线。在路线图中预览剧情摘要，切换时恢复对应的消息和变量。
- **局域网互通**：电脑和手机配对后可以接续存档，不需要搭建云端同步服务器。
- **外观与插件**：用外观工作台预览和保存界面调整；在「设置 → 插件」导入 `.tipsy-plugin`，查看权限与运行日志。酒馆扩展的兼容范围因扩展而异。

## 从源码启动

安装 [Node.js](https://nodejs.org/) 22.19.0 或更新版本，在项目目录运行：

```sh
npm ci
npm start
```

打开 [http://localhost:5179](http://localhost:5179)。`npm start` 会构建网页并启动本地模型网关与兼容服务。首次打开可跟随引导，导入角色卡后在「设置 → 模型连接」填写服务地址、密钥和模型。

单独构建网页运行 `npm run build`。Windows 与 Android 安装包需要配置对应的 [Tauri 开发环境](https://v2.tauri.app/start/prerequisites/)，分别使用 `npm run windows:build` 和 `npm run android:build`。本项目的 Android 发布脚本面向 Windows 上的 ARM64 构建，需要 Android SDK 37、NDK 28.2.13676358 与本机的 `src-tauri/gen/android/keystore.properties`。签名文件不随仓库分发。

插件 SDK 位于 [`packages/plugin-sdk`](packages/plugin-sdk)，第三方代码来源与许可见 [第三方声明](docs/THIRD_PARTY_NOTICES.md)。
