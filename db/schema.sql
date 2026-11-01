-- AfyaStock schema (domain-neutral core)
-- "locations" and "items" are generic: in the health pack they are
-- facilities and medicines; in a retail pack, branches and products.
-- Data flows top to bottom: raw input -> clean data -> model outputs -> human decisions.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------- Reference data (from the domain pack) ----------

CREATE TABLE locations (
    id            SERIAL PRIMARY KEY,
    code          TEXT UNIQUE NOT NULL,          -- e.g. 'KBU-DSP-001'
    name          TEXT NOT NULL,
    location_type TEXT NOT NULL,                 -- health: dispensary, health_centre, hospital
    region        TEXT,                          -- health: sub-county / ward
    latitude      NUMERIC(9,6),
    longitude     NUMERIC(9,6),
    attributes    JSONB NOT NULL DEFAULT '{}',   -- pack-specific extras (rural/urban, catchment size...)
    active        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE items (
    id                 SERIAL PRIMARY KEY,
    code               TEXT UNIQUE NOT NULL,
    name               TEXT NOT NULL,
    category           TEXT,                     -- health: antimalarial, antibiotic...
    unit               TEXT NOT NULL,            -- pack, tablet, vial, sachet
    unit_cost          NUMERIC(12,2),            -- used by budget ranking
    shelf_life_months  INTEGER,
    attributes         JSONB NOT NULL DEFAULT '{}'
);

-- ---------- Input layer ----------

-- Reports exactly as submitted (mistakes included). Never edited.
CREATE TABLE raw_reports (
    id               BIGSERIAL PRIMARY KEY,
    location_code    TEXT NOT NULL,
    item_code        TEXT NOT NULL,
    period           DATE NOT NULL,              -- first day of the reporting month
    opening_balance  NUMERIC,
    quantity_received NUMERIC,
    quantity_used    NUMERIC,
    losses           NUMERIC,                    -- expired, damaged
    closing_balance  NUMERIC,
    expiring_soon    NUMERIC,                    -- stock expiring within 3 months
    source           TEXT NOT NULL,              -- 'synthetic', 'import', 'photo_form'
    payload          JSONB,                      -- original record / extraction details
    ingested_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Clean layer (written by the validation pipeline) ----------

CREATE TABLE stock_reports (
    id                BIGSERIAL PRIMARY KEY,
    location_id       INTEGER NOT NULL REFERENCES locations(id),
    item_id           INTEGER NOT NULL REFERENCES items(id),
    period            DATE NOT NULL,
    opening_balance   NUMERIC NOT NULL,
    quantity_received NUMERIC NOT NULL,
    quantity_used     NUMERIC NOT NULL,
    losses            NUMERIC NOT NULL DEFAULT 0,
    closing_balance   NUMERIC NOT NULL,
    expiring_soon     NUMERIC NOT NULL DEFAULT 0,
    is_imputed        BOOLEAN NOT NULL DEFAULT FALSE,   -- filled in for a missing month
    raw_report_id     BIGINT REFERENCES raw_reports(id), -- provenance: where this came from
    UNIQUE (location_id, item_id, period)
);

CREATE TABLE data_issues (
    id             BIGSERIAL PRIMARY KEY,
    raw_report_id  BIGINT REFERENCES raw_reports(id),
    location_code  TEXT,
    item_code      TEXT,
    period         DATE,
    rule           TEXT NOT NULL,                -- 'balance_mismatch', 'missing_report', 'negative_value'...
    severity       TEXT NOT NULL CHECK (severity IN ('info','warning','error')),
    message        TEXT NOT NULL,
    action_taken   TEXT,                         -- what the pipeline did about it
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Model outputs (written by forecasting and optimiser jobs) ----------

CREATE TABLE model_runs (
    id          SERIAL PRIMARY KEY,
    job         TEXT NOT NULL,                   -- 'forecast', 'optimise'
    model       TEXT,                            -- 'lightgbm', 'seasonal_naive'...
    version     TEXT,
    params      JSONB NOT NULL DEFAULT '{}',
    metrics     JSONB NOT NULL DEFAULT '{}',     -- backtest results
    data_until  DATE,                            -- last period of data used
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE forecasts (
    id            BIGSERIAL PRIMARY KEY,
    run_id        INTEGER NOT NULL REFERENCES model_runs(id),
    location_id   INTEGER NOT NULL REFERENCES locations(id),
    item_id       INTEGER NOT NULL REFERENCES items(id),
    period        DATE NOT NULL,
    predicted_use NUMERIC NOT NULL,
    lower_bound   NUMERIC,
    upper_bound   NUMERIC
);

CREATE TABLE alerts (
    id               BIGSERIAL PRIMARY KEY,
    run_id           INTEGER NOT NULL REFERENCES model_runs(id),
    location_id      INTEGER NOT NULL REFERENCES locations(id),
    item_id          INTEGER NOT NULL REFERENCES items(id),
    alert_type       TEXT NOT NULL CHECK (alert_type IN ('stockout_risk','overstock','expiry_risk')),
    horizon_days     INTEGER NOT NULL,           -- 30 or 60
    risk_score       NUMERIC NOT NULL,           -- 0..1
    months_of_stock  NUMERIC,
    drivers          JSONB NOT NULL DEFAULT '[]',-- SHAP reasons, plain-language ready
    confidence       TEXT,                       -- 'high', 'low' (e.g. patchy reporting)
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE transfer_suggestions (
    id               BIGSERIAL PRIMARY KEY,
    run_id           INTEGER NOT NULL REFERENCES model_runs(id),
    from_location_id INTEGER NOT NULL REFERENCES locations(id),
    to_location_id   INTEGER NOT NULL REFERENCES locations(id),
    item_id          INTEGER NOT NULL REFERENCES items(id),
    quantity         NUMERIC NOT NULL,
    distance_km      NUMERIC,
    reason           TEXT NOT NULL
);

CREATE TABLE reorder_plans (
    id             BIGSERIAL PRIMARY KEY,
    run_id         INTEGER NOT NULL REFERENCES model_runs(id),
    location_id    INTEGER NOT NULL REFERENCES locations(id),
    item_id        INTEGER NOT NULL REFERENCES items(id),
    quantity       NUMERIC NOT NULL,
    cost           NUMERIC NOT NULL,
    priority_rank  INTEGER NOT NULL,
    budget_ceiling NUMERIC,
    within_budget  BOOLEAN NOT NULL,
    stockouts_prevented NUMERIC                  -- expected, from the forecast
);

-- ---------- Knowledge base for the assistant ----------

CREATE TABLE guidance_documents (
    id          SERIAL PRIMARY KEY,
    title       TEXT NOT NULL,
    source_url  TEXT,
    pack        TEXT NOT NULL,                   -- 'health'
    loaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE guidance_chunks (
    id           BIGSERIAL PRIMARY KEY,
    document_id  INTEGER NOT NULL REFERENCES guidance_documents(id) ON DELETE CASCADE,
    chunk_index  INTEGER NOT NULL,
    content      TEXT NOT NULL,
    page         INTEGER,
    embedding    vector(384)                     -- matches a 384-dim open-source model; change if the model changes
);

-- ---------- Human decisions (written by the API) ----------

CREATE TABLE decisions (
    id           BIGSERIAL PRIMARY KEY,
    target_type  TEXT NOT NULL CHECK (target_type IN ('alert','transfer','reorder')),
    target_id    BIGINT NOT NULL,
    action       TEXT NOT NULL CHECK (action IN ('approved','rejected','deferred')),
    decided_by   TEXT NOT NULL,
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Indexes for the queries the API will run most ----------

CREATE INDEX idx_raw_reports_lookup   ON raw_reports (location_code, item_code, period);
CREATE INDEX idx_stock_reports_period ON stock_reports (period);
CREATE INDEX idx_forecasts_lookup     ON forecasts (run_id, location_id, item_id, period);
CREATE INDEX idx_alerts_run_risk      ON alerts (run_id, risk_score DESC);
CREATE INDEX idx_chunks_embedding     ON guidance_chunks USING hnsw (embedding vector_cosine_ops);
