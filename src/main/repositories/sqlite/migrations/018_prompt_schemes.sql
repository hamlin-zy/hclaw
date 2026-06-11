-- HClaw 扩展 Schema v18: 提示词方案表
-- prompt_schemes 表：方案元数据
CREATE TABLE IF NOT EXISTS prompt_schemes
(
    id
    TEXT
    PRIMARY
    KEY,
    name
    TEXT
    NOT
    NULL,
    description
    TEXT
    DEFAULT
    '',
    enabled
    INTEGER
    NOT
    NULL
    DEFAULT
    1,
    created_at
    INTEGER
    NOT
    NULL,
    updated_at
    INTEGER
    NOT
    NULL
);

-- prompt_scheme_nodes 表：每个方案的节点覆盖
CREATE TABLE IF NOT EXISTS prompt_scheme_nodes
(
    id
    TEXT
    PRIMARY
    KEY,
    scheme_id
    TEXT
    NOT
    NULL,
    node_key
    TEXT
    NOT
    NULL,
    content
    TEXT
    NOT
    NULL
    DEFAULT
    '',
    created_at
    INTEGER
    NOT
    NULL,
    updated_at
    INTEGER
    NOT
    NULL,
    FOREIGN
    KEY
(
    scheme_id
) REFERENCES prompt_schemes
(
    id
) ON DELETE CASCADE
    );

CREATE INDEX IF NOT EXISTS idx_prompt_nodes_scheme ON prompt_scheme_nodes(scheme_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_nodes_key ON prompt_scheme_nodes(scheme_id, node_key);
