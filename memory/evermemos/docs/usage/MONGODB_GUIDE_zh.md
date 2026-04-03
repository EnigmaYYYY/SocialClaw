# MongoDB 安装指南

本文档为 MemSys 项目的开发者提供在 macOS、Windows 和 Linux 上直接安装和配置 MongoDB 的指导。

## 1. 安装 MongoDB Community Server

请根据您的操作系统选择相应的安装方法。

### 1.1. macOS 用户

我们推荐使用 [Homebrew](https://brew.sh/) 进行安装。Homebrew 是 macOS 的包管理器，能极大地简化软件安装过程。

1.  **安装 Homebrew** (如果尚未安装):
    ```bash
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    ```

2.  **添加 MongoDB 的 Homebrew Tap**:
    ```bash
    brew tap mongodb/brew
    ```

3.  **安装 MongoDB**:
    ```bash
    brew install mongodb-community
    ```

### 1.2. Windows 用户

#### 方法一：使用官方安装程序 (推荐)
1.  前往 [MongoDB Community Server 下载页面](https://www.mongodb.com/try/download/community)。
2.  选择最新版本的 `MSI` 安装包并下载。
3.  运行安装程序。在安装过程中，**请务必勾选 "Install MongoDB Compass"** 选项，以便同时安装图形化管理工具。
4.  跟随向导完成安装。安装程序会自动将 MongoDB 设置为 Windows 服务，默认开机自启。

#### 方法二：使用 Chocolatey 包管理器
如果您使用 [Chocolatey](https://chocolatey.org/)，可以通过运行以下命令进行安装：
```powershell
choco install mongodb
```

### 1.3. Linux 用户 (以 Ubuntu 20.04/22.04 LTS 为例)

1.  **导入 MongoDB 的 GPG 密钥**:
    ```bash
    sudo apt-get install gnupg
    curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | \
       sudo gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg \
       --dearmor
    ```

2.  **为 MongoDB 创建列表文件**:
    ```bash
    echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu $(lsb_release -cs)/mongodb-org/7.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list
    ```

3.  **更新本地包数据库并安装 MongoDB**:
    ```bash
    sudo apt-get update
    sudo apt-get install -y mongodb-org
    ```

## 2. 安装 MongoDB Compass (图形化工具)

如果您在 Windows 安装过程中没有选择捆绑安装，或者是 macOS/Linux 用户，可以单独安装 Compass。

*   **macOS**:
    ```bash
    brew install --cask mongodb-compass
    ```

*   **Windows**:
    前往 [MongoDB Compass 下载页面](https://www.mongodb.com/try/download/compass)，下载 `MSI` 安装包并执行。

*   **Linux (Ubuntu)**:
    前往 [MongoDB Compass 下载页面](https://www.mongodb.com/try/download/compass)，下载 `deb` 格式的包，然后用以下命令安装 (请将文件名替换为您实际下载的文件名):
    ```bash
    sudo dpkg -i mongodb-compass_x.x.x_amd64.deb
    ```

## 3. 运行 MongoDB 服务

*   **macOS (通过 Homebrew)**:
    ```bash
    brew services start mongodb-community
    ```

*   **Windows**:
    如果您通过官方安装程序安装，MongoDB 会被注册为 Windows 服务并自动运行。您可以在“服务”应用中找到并管理它。

*   **Linux (Ubuntu)**:
    ```bash
    sudo systemctl start mongod
    # 设置开机自启
    sudo systemctl enable mongod
    ```
    您可以通过 `sudo systemctl status mongod` 查看服务状态。

## 4. 连接与配置

### 4.1. 使用 MongoDB Compass 连接

无论何种操作系统，打开您安装好的 MongoDB Compass。它通常会自动探测到您本地正在运行的 MongoDB 实例，您只需点击“连接”按钮，使用默认的连接字符串 `mongodb://localhost:27017` 即可成功连接。

### 4.2. 配置项目 `.env` 文件

为了让 MemSys 应用程序能够连接到本地的 MongoDB，您需要配置项目的环境变量。

1.  首先，在项目根目录下，将 `env.template` 文件复制为 `.env` (如果您尚未这样做):
    ```bash
    cp env.template .env
    ```

2.  打开 `.env` 文件，找到 MongoDB 配置部分。由于本地安装的 MongoDB 默认未开启用户认证，您需要进行如下修改：

    ```ini
    # ===================
    # MongoDB Configuration
    # ===================

    MONGODB_HOST=127.0.0.1
    MONGODB_PORT=27017
    MONGODB_USERNAME=
    MONGODB_PASSWORD=
    MONGODB_DATABASE=memsys
    MONGODB_URI_PARAMS=
    ```
    **注意**: 将 `MONGODB_USERNAME` 和 `MONGODB_PASSWORD` 留空，同时将 `MONGODB_URI_PARAMS` 也设置为空。`MONGODB_DATABASE` 您可以自定义，这里我们继续使用 `memsys`。

现在，您的开发环境已配置完毕，MemSys 应用程序可以成功连接到本地运行的 MongoDB 实例。
