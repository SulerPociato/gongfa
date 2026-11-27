-- Qoder Sites Function backend schema（2026-11-27）
-- 表都在 app schema；业务授权由 Function 内的 token 校验负责。
CREATE TABLE app.players (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.runs (
  id text PRIMARY KEY,
  player_id text NOT NULL,
  realm integer NOT NULL,
  elapsed_ms integer NOT NULL,
  rate jsonb NOT NULL,
  seed bigint NOT NULL,
  build text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, realm)
);

CREATE INDEX runs_realm_elapsed_idx ON app.runs (realm, elapsed_ms);

CREATE TABLE app.posts (
  id text PRIMARY KEY,
  author_id text NOT NULL,
  author_name text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  build text NOT NULL DEFAULT '',
  seed bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX posts_created_at_idx ON app.posts (created_at);

CREATE TABLE app.post_likes (
  post_id text NOT NULL,
  player_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, player_id)
);

CREATE TABLE app.comments (
  id text PRIMARY KEY,
  post_id text NOT NULL,
  author_id text NOT NULL,
  author_name text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX comments_post_created_at_idx ON app.comments (post_id, created_at);

CREATE TABLE app.reports (
  id text PRIMARY KEY,
  post_id text NOT NULL,
  player_id text NOT NULL,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
