# Knowledge Hub Backend

企业知识库后端：文档入库、解析、发布，以及发布后的 **RAG 向量检索 / 全文搜索 / 知识图谱** 异步构建。

技术栈：**NestJS 11 + TypeScript**。HTTP 同步写主数据，RabbitMQ 异步驱动三条知识管线。

---

## 整体架构

```
┌──────────────────────────────── HTTP ─────────────────────────────────┐
│  POST /documents              创建草稿（JSON 正文）                     │
│  POST /documents/upload/parse 上传文件 → Markdown 草稿                  │
│  PUT  /documents/:id/publish  发布（写库成功即返回，管线异步）           │
│  GET / PATCH / DELETE         查询 / 更新 / 软删除                      │
└───────────────────────────────┬───────────────────────────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │   DocumentService     │
                    │  元数据 + 正文 + 发布   │
                    └─┬─────────┬─────────┬─┘
                      │         │         │
           PostgreSQL │    MongoDB │  RustFS (S3)
           kh_document│  document_ │  原文件 / PDF 抽图
           (元数据)   │  content   │
                      │  (Markdown)│
                      │         │
          发布 / 删除  │         │
                      ▼         ▼
              DocumentPipelinePublisher
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
   rag.reindex   search.index    kg.graph     ← RabbitMQ topic
        │             │             │
        ▼             ▼             ▼
   PipelineOrchestrator（消费后编排，不直接碰 MQ）
        │             │             │
        ▼             ▼             ▼
   Chunk → Embed   整篇快照      Chunk → LLM 抽实体
   → ES kh_chunk   → ES          → Neo4j
                   kh_document
```

设计原则：

- **热路径短**：创建 / 发布只写 Postgres + Mongo，立刻返回。
- **冷路径异步**：向量、全文、图谱失败不回滚「已发布」状态。
- **存储按职责拆分**：结构化元数据、大文本、对象、检索、图，各用合适的引擎。

---

## 模块划分

```
src/
├── main.ts / app.module.ts     启动、全局 ValidationPipe、多数据源接入
├── document/                   文档 CRUD、上传解析（同步域）
│   ├── document.controller.ts
│   ├── document.service.ts
│   ├── entities/document.entity.ts      Postgres 元数据
│   ├── schemas/document-content.schema.ts  Mongo 正文
│   └── parser/                 文件 → Markdown
├── mq/                         RabbitMQ 拓扑、生产者、消费者
├── pipeline/                   发布后知识管线（编排 + 具体服务）
├── storage/                    RustFS（S3 兼容）
└── common/                     雪花 ID、bigint transformer
```

| 模块 | 职责 |
|------|------|
| `DocumentModule` | HTTP 入口；元数据 / 正文读写；上传解析；发布时投递 MQ |
| `MqModule`（Global） | 交换机 / 队列绑定；`Publisher` 投递；`Consumer` 转交编排器 |
| `PipelineModule` | 分块、嵌入、ES 写入、LLM 抽实体、Neo4j 建图 |
| `StorageModule` | 原文件与 PDF 内嵌图上传 |

消费者只解析消息并调用 `PipelineOrchestrator`；编排器负责加载文档、调用具体服务，**不直接依赖 RabbitMQ**。

---

## 数据怎么存

| 存储 | 用途 | 关键结构 |
|------|------|----------|
| **PostgreSQL** | 文档元数据、列表筛选、状态 | `kh_document`，主键雪花 ID（`bigint` 在应用层当字符串） |
| **MongoDB** | Markdown 正文、版本、预览 | `document_content`；`_id` ↔ `kh_document.content_id` |
| **RustFS** | 原文件、PDF 抽图 | bucket `knowledge-hub`；前缀 `documents/`、`pdf-images/` |
| **Elasticsearch** | 关键词搜索 + RAG 向量 | `kh_document`（文档级）、`kh_chunk`（块 + `dense_vector`） |
| **Neo4j** | 知识图谱 | 见下方图模型 |
| **RabbitMQ** | 发布 / 删除后的异步任务 | 三条独立交换机，互不影响 |

关联约定：

```
Postgres kh_document.id          ↔  Mongo document_content.documentId
Postgres kh_document.content_id  ↔  Mongo document_content._id
```

创建顺序：先写 Mongo 拿 `ObjectId`，再写 Postgres；Postgres 失败则删除刚写入的 Mongo 文档，避免孤儿正文。

文档状态：`0` 草稿 / `1` 已发布 / `2` 已归档。归档文档不作为知识被检索。

---

## 文档生命周期

```
上传/创建 ──► 草稿 (Draft)
                │
                │  PUT /documents/:id/publish
                ▼
           已发布 (Published)
                │
     ┌──────────┼──────────┐
     ▼          ▼          ▼
    RAG       Search       KG     （MQ 并行投递）
     │          │          │
     ▼          ▼          ▼
  ES kh_chunk  ES kh_document  Neo4j

软删除 ──► deleted=true（Postgres + Mongo）
         ──► MQ 通知三条管线按 documentId 清理索引 / 图
```

发布约束：

- 仅草稿或已发布可发布；已发布再次发布会 **全量重建** 索引与图谱。
- MQ 投递失败只打日志，**不回滚** 已发布状态。
- ES / Neo4j 不可用时管线跳过写入，不阻断消费。

---

## 三条知识管线

发布成功后，`DocumentPipelinePublisher.afterPublish` 并行投递三条消息。

### 1. RAG（语义检索）

交换机 `rag.reindex.exchange` → 队列 `kh.rag.reindex.queue`

1. 按 ID 加载 Postgres 元数据 + Mongo 正文  
2. 删除该文档旧的 `kh_chunk`  
3. Markdown 感知分块（LangChain `RecursiveCharacterTextSplitter`）  
4. Embedding 批量向量化  
5. bulk 写入 ES `kh_chunk`（含 `dense_vector`）

分块默认：`RAG_CHUNK_SIZE=512` token、重叠 `64`；按约 1 token ≈ 2 字符换算。块 ID 为 `sha256(documentId:index)` 前 64 位，重建可覆盖。

### 2. Search（关键词检索）

交换机 `search.index.exchange` → 队列 `kh.search.index.queue`

消息里直接带文档快照（正文只截前 1000 字），消费者无需再查库即可写入 ES `kh_document`。

与 RAG 的区别：Search 是 **一篇文档一条记录**（标题 / 摘要 / 正文前缀）；RAG 是 **多块 + 向量**。

### 3. KG（知识图谱）

交换机 `kg.graph.exchange` → 队列 `kh.kg.graph.queue`

1. 删除该文档旧图（含孤儿实体清理）  
2. `MERGE` 文档节点  
3. **复用与 RAG 相同的分块**，粒度一致  
4. 每块调用 LLM structured output 抽实体 / 关系  
5. 写入 Neo4j  

图模型：

```
(KnowledgeDocument)-[:HAS_CHUNK]->(DocumentChunk)-[:MENTIONS]->(KnowledgeEntity)
(KnowledgeEntity)-[:RELATED_TO {relation}]->(KnowledgeEntity)
```

实体类型示例：`PERSON` / `ORGANIZATION` / `CONCEPT` / `PROCESS` / `POLICY` 等。  
关系类型写在 `RELATED_TO` 边的 `relation` 属性上（如 `REQUIRES`、`BELONGS_TO`）。

单块抽取失败只跳过该块，不中断整篇建图。

---

## RabbitMQ 拓扑

| 交换机 | 队列 | 路由键 | 消息 type |
|--------|------|--------|-----------|
| `rag.reindex.exchange` | `kh.rag.reindex.queue` | `rag.reindex.by_ids` / `rag.reindex.delete` | `BY_DOC_IDS` / `DELETE_BY_DOC_IDS` |
| `search.index.exchange` | `kh.search.index.queue` | `search.index.document` / `search.index.delete` | `INDEX` / `DELETE` |
| `kg.graph.exchange` | `kh.kg.graph.queue` | `kg.graph.build.by_ids` / `kg.graph.delete` | `BUILD_BY_DOC_IDS` / `DELETE_BY_DOC_IDS` |

队列带 `kh.` 前缀，避免与本机其他项目冲突。`RABBITMQ_ENABLED=false` 时跳过连接。

---

## 文件解析

`POST /documents/upload/parse`（form-data 字段名 `file`，上限 50MB）

| 格式 | 解析方式 |
|------|----------|
| pdf | 文本 + 表格；有 RustFS 时抽图上传并插入 Markdown 图片 |
| docx | mammoth → HTML → Markdown |
| xlsx | exceljs 结构化表格；失败降级 officeparser |
| pptx | officeparser |
| txt / md | 纯文本 |

解析成功后创建 **草稿**，原文件上传到 RustFS（未启用则跳过）。再调用发布接口才会进入三条管线。

---

## 基础设施

`docker-compose.yml` 提供本地依赖（应用进程在宿主机跑）：

| 服务 | 端口 | 说明 |
|------|------|------|
| postgres (pgvector/pg16) | 5432 | 元数据；init-scripts 建 `kh_document` |
| pgadmin | 8088 | Postgres GUI |
| mongodb | 27017 | 正文 |
| mongo-express | 8081 | Mongo GUI |
| rabbitmq | 5672 / 15672 | AMQP + 管理台 |
| elasticsearch 8.17 + IK | 9200 | 中文分词 |
| kibana | 5601 | ES 控制台 |
| rustfs | 9000 / 9001 | S3 API + Console |
| neo4j | 7474 / 7687 | Browser + Bolt |

```bash
docker compose up -d
```

管理台默认账号见 compose 文件（均为本地开发凭据，勿用于生产）。

---

## 本地启动

```bash
pnpm install
cp .env.example .env   # 若无示例文件，对照下方环境变量自行配置
pnpm run start:dev
```

默认监听 `PORT=3000`。

常用脚本：`start` / `start:dev` / `start:debug` / `build` / `start:prod` / `test` / `test:e2e`。

API 联调示例见仓库根目录 `curl.md`。

---

## HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/documents` | 创建文档（可直接带 `status: 1` 创建即发布，但不会自动投递管线；知识索引请走 publish） |
| POST | `/documents/upload/parse` | 上传并解析为草稿 |
| GET | `/documents` | 分页列表（仅元数据） |
| GET | `/documents/:id` | 详情（含正文） |
| PATCH | `/documents/:id` | 更新 |
| PUT | `/documents/:id/publish` | 发布并触发 RAG / Search / KG |
| DELETE | `/documents/:id` | 软删除并清理索引 / 图 |

---

## 环境变量

| 变量 | 含义 |
|------|------|
| `POSTGRES_*` / `MONGO_URI` | 主库连接 |
| `SNOWFLAKE_WORKER_ID` / `SNOWFLAKE_OFFSET` | 文档 ID |
| `RUSTFS_ENABLED` / `RUSTFS_ENDPOINT` / `RUSTFS_*` | 对象存储 |
| `RABBITMQ_ENABLED` / `RABBITMQ_URL` | 消息队列 |
| `RAG_CHUNK_SIZE` / `RAG_CHUNK_OVERLAP` | 分块 |
| `EMBEDDING_*` / `OPENAI_API_KEY` / `OPENAI_BASE_URL` | 向量模型（OpenAI 兼容，如 DashScope / 302.ai） |
| `MODEL_NAME` / `KG_LLM_TIMEOUT_MS` | KG 抽取用 Chat 模型 |
| `ELASTICSEARCH_ENABLED` / `ELASTICSEARCH_NODE` | ES |
| `NEO4J_ENABLED` / `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | 图谱 |

Embedding 维度须与 ES `kh_chunk.embedding` 的 `dense_vector.dims` 一致（默认 1024）。

---

## 容错约定

- 基础设施（ES / Neo4j / RabbitMQ / RustFS）均可单独关闭或暂时不可用，应用仍能启动。
- 发布：库成功即成功；管线尽力而为。
- RAG / KG：单篇或单块失败记日志，继续处理其余文档 / 块。
- 删除：主数据先软删，再异步清检索与图；清理投递失败只告警。
