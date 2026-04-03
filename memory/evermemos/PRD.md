# **Project Requirements Document (PRD) v2**

# **Social Copilot: Cross-Platform Edition**

**版本:** 2

**架构核心:** Local LLM + EverMemOS (Dual-Mirror) + Visual Monitor

**平台:** Windows / macOS (Electron + Python Backend)

**开发目标:** 开源、本地部署、隐私优先的 AI 社交军师

---

## **1. 项目概览 (Project Overview)**

### **1.1 产品定义**

**Social Copilot** 是一款跨平台的桌面应用程序。它不依赖侵入式的 Hook 或特定系统的 Accessibility API，而是通过**“像人眼一样看屏幕”**（计算机视觉技术）来感知聊天上下文。它利用本地 LLM 和 EverMemOS 记忆引擎，为用户提供高情商、风格化且安全的聊天建议。

### **1.2 核心差异化**

1. **通用性 (Universality):** 基于 OCR 技术，理论上支持微信、QQ、Telegram 等任何聊天软件，且完美兼容 Windows 和 macOS。
2. **双重镜像 (Dual-Mirror):** 复用 EverMemOS 架构，分别构建“自我镜像”（模仿我的风格）和“联系人镜像”（洞察对方意图）。
3. **零数据上传:** 所有截图、OCR 识别、向量存储和 LLM 推理均在本地闭环运行。

---

## **2. 系统架构 (System Architecture)**

系统分为前端交互层（Electron）和后端智能层（Python）。

### **2.1 架构数据流**

```mermaid
graph TD
    subgraph "输入源 (Input Sources)"
        History[历史记录: 解密数据库] --> |JSON| Importer
        Screen[实时屏幕: 微信窗口] --> |MSS 截图| VisualMonitor
    end

    subgraph "视觉监控模块 (Visual Monitor)"
        VisualMonitor --> |Hash 去重| FrameDiff[帧差检测]
        FrameDiff --> |变化区域| OCR[RapidOCR 识别]
        OCR --> |文本+坐标| Parser[结构化解析器]
        Parser --> |(Sender, Text)| SessionBuffer
    end

    subgraph "记忆引擎 (EverMemOS Dual-Mirror)"
        Importer --> SelfMirror
        Importer --> ContactMirror
        SessionBuffer --> |实时增量| SelfMirror[EverMemOS A: Self-Mirror]
        SessionBuffer --> |实时增量| ContactMirror[EverMemOS B: Contact-Mirror]
    end
    
    subgraph "推理与交互 (Inference)"
        SelfMirror --> |Retrieve Style| Coach[Social Coach Agent]
        ContactMirror --> |Retrieve Facts| Coach
        Coach --> |Advice| UI[悬浮窗界面]
    end

```

---

## **3. 详细功能需求 (Functional Requirements)**

### **3.1 模块一：冷启动数据提取 (Offline History)**

**目标:** 提取历史聊天记录，完成 EverMemOS 的初始化训练。

* **REQ-1.1 数据源解密 (Decryption Pipeline):**
* **方案:** 采用基于本地数据库解密的方案（参考 [知乎教程](https://zhuanlan.zhihu.com/p/1991993423289413743)）。
* **执行:** 用户需运行提供的 Python 脚本，解密微信本地存储的 SQLite 数据库（`msg.db` / `MicroMsg.db`），导出为标准 JSON 格式。
* **格式要求:** 导出的 JSON 需包含 `timestamp`, `sender_id` (0=Me, 1=Contact), `content`, `msg_type`。


* **REQ-1.2 记忆库初始化 (Batch Ingestion):**
* **入口:** 应用内提供“导入历史记录”按钮，选择上述导出的 JSON 文件。
* **并行构建:**
* 将 `sender_id == 0` 的数据喂给 **Self-Mirror**（学习风格）。
* 将 `sender_id == 1` 的数据喂给 **Contact-Mirror**（建立画像）。


* **反馈:** 由于处理耗时，需在 UI 上显示“记忆构建进度条”。



### **3.2 模块二：通用视觉监控 (Universal Visual Monitor)**

**目标:** 实时、低功耗地获取当前聊天窗口的最新消息。此模块替代原有的 Accessibility API。

* **REQ-2.1 区域校准 (ROI Calibration):**
* **交互:** 首次启动或窗口位置改变时，用户点击“校准区域”按钮。
* **实现:** 呼出一个半透明遮罩层（Overlay），引导用户框选**“消息列表区域”**。记录该区域相对于屏幕的坐标 `(x, y, w, h)`。


* **REQ-2.2 智能截图与去重 (Smart Capture):**
* **技术栈:** `mss` (Python库，极速截图)。
* **频率:** 默认 2Hz (每秒 2 次)。
* **防空转逻辑:**
* 对当前截图计算感知哈希 (Perceptual Hash) 或直方图。
* 与上一帧对比，相似度 > 99% 则跳过 OCR，进入休眠（节省 CPU）。
* 仅当屏幕发生变化（有新消息滚动/弹出）时触发后续流程。




* **REQ-2.3 本地 OCR 推理 (RapidOCR):**
* **技术栈:** `rapidocr_onnxruntime`。
* **输入:** 变化后的 ROI 截图区域。
* **输出:** 包含文本内容 (`text`) 和包围盒坐标 (`box`) 的列表。
* **隐私:** 仅在内存中处理图片，处理完立即释放，不保存截图文件到硬盘。


* **REQ-2.4 结构化解析 (Structure Parser) - 关键逻辑:**
* **目标:** 从 OCR 结果中区分“谁发的消息”。
* **坐标算法:**
* 获取 ROI 区域的中心线 X 轴坐标 `Center_X`。
* 遍历 OCR 结果的 `box`：
* 若 `box.x < Center_X` (偏左)  判定为 **Contact (对方)**。
* 若 `box.x > Center_X` (偏右)  判定为 **User (我)**。




* **清洗:** 使用正则过滤掉时间戳（如 "12:30"）、系统提示文字。
* **输出:** 生成标准的 `(Sender, Text)` 对象流，推入 Session Buffer。



### **3.3 模块三：EverMemOS 记忆系统**

**目标:** 利用双 EverMemOS 实例处理数据流。

* **REQ-3.1 扩展 Schema:**
* **Self-Mirror:** 增加 `style_vector` (风格向量) 和 `habit_tags` (习惯标签)。
* **Contact-Mirror:** 增加 `intent_prediction` (意图预测) 和 `risk_flag` (风险标记)。


* **REQ-3.2 实时增量更新 (Real-time Formation):**
* **Buffer 策略:** 当 OCR 解析出 3-5 条新消息后，打包为一个 `Micro-Episode`。
* **异步写入:** 将 `Micro-Episode` 传入 EverMemOS 的 `add_memory` 接口。**注意：** 仅执行 Phase I (Trace Formation) 生成短期记忆，Phase II (聚类) 放在后台闲时执行，避免阻塞。



### **3.4 模块四：交互与建议生成**

* **REQ-4.1 双源检索 (Dual Retrieval):**
* **Trigger:** 当 OCR 检测到最后一条消息是“对方”发送，且用户停止输入超过 2 秒。
* **Query Self:** "针对此类话题，我历史上的高频回复词和语气是什么？"  检索 Self-Mirror。
* **Query Contact:** "对方提到这个话题的潜在意图是什么？我们之前有过相关约定吗？"  检索 Contact-Mirror。


* **REQ-4.2 生成与展示:**
* **Prompt:** 结合检索结果，让 LLM 生成 3 个选项。
* **UI:** 悬浮窗展示建议。点击建议可直接复制到剪贴板。



---

## **4. 技术栈与开发环境 (Development Stack)**

### **4.1 前端 (App UI)**

* **Electron:** 负责窗口管理、系统托盘、Global Shortcut。
* **React + TailwindCSS:** 构建悬浮窗 UI 和“区域校准”遮罩层。
* **IPC:** 使用 Electron 的 `ipcRenderer` 与 Python 后端通信。

### **4.2 后端 (Core Logic)**

* **Python 3.10+:** 核心逻辑宿主。
* **API Framework:** **FastAPI** 或 **ZeroMQ** (推荐 ZeroMQ，进程间通信延迟更低)。
* **OCR:** `rapidocr_onnxruntime` (CPU 推理速度极快，无需 CUDA)。
* **Screen Capture:** `mss`。
* **LLM Runtime:** **Ollama** (需预装 Qwen2.5-7B-Instruct-4bit)。
* **Memory:** EverMemOS (修改版)。

---

## **5. 给开发者的特别提示 (Notes for Developer)**

* **OCR 坐标调试:** 不同分辨率屏幕（Retina vs 普通屏）的 Scaling Factor 不同，`mss` 截图的像素坐标可能与 Electron 窗口坐标有倍数关系（通常是 2x）。在开发“区域校准”功能时，务必注意坐标换算。
* **性能优化:** OCR 是 CPU 密集型任务。务必确保“Hash 去重”逻辑生效，**只有画面变动时才 OCR**，否则会让用户电脑风扇狂转。
* **模型推荐:** 对于 8GB-16GB 内存的笔记本，推荐使用 **Qwen2.5-7B-Instruct (q4_k_m)**。它在指令遵循和中文理解上平衡得最好。