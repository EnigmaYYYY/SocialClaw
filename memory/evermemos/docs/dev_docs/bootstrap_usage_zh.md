# Bootstrap 脚本使用指南

## 概述

`src/bootstrap.py` 是一个脚本运行器，让您能够无认知负担地运行任何测试脚本，自动处理所有环境设置。

## 基本用法

```bash
python src/bootstrap.py [脚本路径] [脚本参数...]
```

脚本路径可以是：
- 相对于项目根目录的路径：`unit_test/memory_manager_single_test.py`
- 相对于当前目录的路径：`../tests/test_convert_rest.py`
- 绝对路径：`/path/to/your/script.py`

## 使用示例

### 1. 运行单元测试

```bash
# 运行内存管理器测试
python src/bootstrap.py unit_test/memory_manager_single_test.py

# 使用相对路径运行测试
python src/bootstrap.py ../tests/test_convert_rest.py

# 运行带参数的测试
python src/bootstrap.py unit_test/memory_manager_single_test.py --verbose
```

### 2. 运行评估脚本

```bash
# 运行动态内存评估
python src/bootstrap.py evaluation/dynamic_memory_evaluation/locomo_eval.py

# 运行带数据集参数的评估
python src/bootstrap.py evaluation/dynamic_memory_evaluation/locomo_eval.py --dataset small
```

### 3. 运行算法调试脚本

```bash
# 运行算法调试脚本
python src/bootstrap.py tests/algorithms/debug_my_model.py

# 运行带配置文件的脚本
python src/bootstrap.py tests/algorithms/debug_my_model.py --config config.json
```

### 4. 运行测试模板

```bash
# 运行 Bootstrap 测试模板，学习如何使用 DI 和 MongoDB
python src/bootstrap.py tests/bootstrap_test_template.py
```

## 命令行选项

### `--env-file`
指定要加载的环境变量文件（默认: `.env`）

```bash
python src/bootstrap.py your_script.py --env-file .env.test
```

### `--mock`
启用 Mock 模式（用于测试和开发）

```bash
python src/bootstrap.py your_script.py --mock
```

## 环境变量

### `MOCK_MODE`
设置为 `true` 启用 Mock 模式

```bash
MOCK_MODE=true python src/bootstrap.py your_script.py
```

## 测试模板

项目提供了一个完整的测试模板 `tests/bootstrap_test_template.py`，展示了如何：

- **使用依赖注入**：通过 `get_bean_by_type()` 和 `get_bean()` 获取单例对象
- **操作 MongoDB**：使用仓库模式进行数据库查询和操作
- **集成测试**：结合多个组件进行综合测试

模板包含以下示例：
```python
# 获取 MongoDB 仓库
from core.di.utils import get_bean_by_type
repo = get_bean_by_type(MemCellRawRepository)

# 查询数据
memcells = await repo.find_all(limit=5)
total_count = await repo.count_all()
```

## 最佳实践

### 1. 日常使用
直接运行您的脚本：
```bash
python src/bootstrap.py 你的脚本.py
```

### 2. 学习开发
先运行测试模板了解项目结构：
```bash
python src/bootstrap.py tests/bootstrap_test_template.py
```

### 3. 开发和测试
开发时可以使用 Mock 模式：
```bash
python src/bootstrap.py your_script.py --mock
```

### 4. CI/CD 集成
在持续集成中可以指定不同的环境文件：
```bash
python src/bootstrap.py test_script.py --env-file .env.ci
```

## 故障排除

### 1. 相对导入错误
如果遇到 `ImportError: attempted relative import with no known parent package` 错误：
- Bootstrap 会自动检测并切换到模块模式运行
- 无需手动干预，脚本会自动重试

### 2. 导入错误
如果遇到其他模块导入错误，检查：
- 是否在项目根目录执行
- `.env` 文件是否存在且配置正确

### 3. 脚本执行错误
如果目标脚本执行失败：
- 检查脚本路径是否正确
- 确认脚本本身没有语法错误
