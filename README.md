# dsh-plugins

本目录的**根项目**：负责安装（并构建、测试）本仓库下的全部 dsh 插件。

当前收录的插件：

| 目录 | 包名 | 类型 | 安装目标 profile |
|------|------|------|------------------|
| `acp4idea` | `@xiongqiang521/dsh-acp4idea` | bundle | `acp` |

## 目录结构

```
dsh-plugins/
├── package.json            # 根项目：脚本入口（workspace 根）
├── pnpm-workspace.yaml     # pnpm 工作区：* 匹配所有插件目录
├── plugins.json            # 插件 → dsh profile 映射（安装目标）
├── scripts/
│   └── plugins.mjs         # 发现并安装全部插件
├── README.md
└── <plugin>/               # 每个 dsh 插件一个目录（bundle / plugin）
```

## 安装全部插件

```sh
# 1) 安装所有插件的依赖（pnpm 工作区，一次搞定）
pnpm install

# 2) 把全部插件安装进 dsh profile（等价于逐个执行 dsh plugin add）
pnpm run install:plugins
# 或者一步到位：
pnpm run install:all
```

`install:plugins` 会扫描根目录下所有声明了 `dsh` 字段的插件包，并按
`plugins.json` 中的映射逐个执行：

```sh
dsh plugin --profile <profile> add link:<插件绝对路径>
```

`link:` 协议让 profile 始终指向本仓库的实时源码 —— 修改插件后重新
`pnpm run build` 即可生效，无需重新安装。`dsh plugin add` 会自动创建
不存在的 profile，并把声明了 `dsh.bundle.patch` 的依赖自动写入该
profile 的 `dsh.profile.bundles` 层列表。

## 常用命令

| 命令 | 作用 |
|------|------|
| `pnpm install` | 安装所有插件的依赖（工作区） |
| `pnpm run install:plugins` | 把全部插件安装进 dsh profiles |
| `pnpm run install:all` | 上面两步一起 |
| `pnpm run plugins:list` | 列出已发现的插件及安装目标 |
| `pnpm run build` | 构建所有插件（`pnpm -r build`） |
| `pnpm run test` | 测试所有插件（`pnpm -r test`） |
| `pnpm run typecheck` | 类型检查所有插件 |
| `pnpm run lint` | 代码规范检查所有插件（`pnpm -r lint`，ESLint + @typescript-eslint） |

只安装到某一个 profile（忽略 `plugins.json`）：

```sh
node scripts/plugins.mjs install --profile web
```

预览将要执行的命令（不实际安装）：

```sh
node scripts/plugins.mjs install --dry-run
```

## 新增一个插件

1. 在根目录下新建插件目录，例如 `my-plugin/`，保证其 `package.json` 声明
   `dsh` 字段（bundle 用 `dsh.bundle.patch`，普通插件用 `dsh.plugin`）。
2. 在 `plugins.json` 里加一行映射，指定要装进哪些 profile：
   ```json
   { "my-plugin": ["default"] }
   ```
   未配置的插件默认装进 `default` profile（首次使用时自动创建）。
3. 运行 `pnpm install && pnpm run install:plugins`。

## 说明

- 插件发现规则：根目录下**直接子目录**中的 `package.json` 包含 `dsh`
  字段即视为插件；不匹配的目录会被忽略。
- `plugins.json` 的值可以是数组（多个 profile）或单个字符串。
- 如果 profile 使用 `autoInstallPeers: false`（生成 profile 的 pnpm 默认
  值），bundle 的 peer 依赖需要手动补装一次，例如 acp4idea 需要：
  ```sh
  cd ~/.dsh/profiles/acp && pnpm add @deepseek-ai/dsh-agent-presets
  ```
- 普通插件（非 bundle）会被安装为 profile 的普通依赖，不会进入
  `dsh.profile.bundles` 层列表，`dsh plugin` 会打印一条提示。
