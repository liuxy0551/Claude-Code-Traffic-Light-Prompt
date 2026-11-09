
  # Agent 红绿灯

  Agent（Claude Code / Codex / Antigravity）的红绿灯状态提示器，支持用量查询。

  ![效果图](public/demo.gif)

  ## 功能特性

  - 🔴 红灯：思考中
  - 🟡 黄灯：等待中
  - 🟢 绿灯：已完成
  - 📊 用量查询（MiMo / Codex / Antigravity）
  - 🎨 多种样式（单灯 / 横版三灯 / 竖版三灯）

  ## 支持的工具

  - [x] Claude Code
  - [x] Codex
  - [x] Antigravity

  ## 运行

  ```bash
  npm i          # 安装依赖
  npm run dev    # 开发模式
  npm run watch  # 本地预览
  npm run dist   # 打包
  ```

  ## 余量查询

  - [x] 支持查询 Codex 余量
  - [x] 支持查询 Antigravity 余量（根据当前模型显示 5h / 周剩余配额与重置倒计时）
  - [x] 支持查询 Xiaomi MiMo 余量
  - [x] 支持横版三灯
  - [x] 支持 ClaudeCode hooks
  - [x] 支持 Codex hooks

  ![Codex 余量查询](public/codex-usage.png)

  ![Antigravity 余量查询](public/agy-usage.png)

  ![MiMo 余量查询](public/mimo-usage.png)

  ![横版三灯](public/horizontal.png)
