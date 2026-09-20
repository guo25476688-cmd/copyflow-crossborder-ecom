CREATE TABLE IF NOT EXISTS generations (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  product_name TEXT NOT NULL,
  product_features TEXT,
  platform TEXT NOT NULL,
  result_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_generations_created_at ON generations (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generations_request_id ON generations (request_id);
