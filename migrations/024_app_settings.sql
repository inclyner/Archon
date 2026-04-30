-- Generic key/value bag for user-editable app-level settings.
-- First use case (Phase D): storing Jira credentials so the user can configure
-- them via the Settings UI instead of editing .env. Single-developer tool —
-- values are stored plaintext; if you want encryption, add a layer above this.
CREATE TABLE IF NOT EXISTS remote_agent_app_settings (
  key        VARCHAR(100) PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
