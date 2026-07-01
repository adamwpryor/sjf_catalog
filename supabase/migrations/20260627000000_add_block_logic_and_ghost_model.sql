-- CDI Factory — AIP-parity block/edge logic model + ghost-course support (WS2 + WS3 schema)
--
-- Brings the hub's relational model to parity with the AIP yardstick
-- (Supabase thsrwztyvqjkhcfzapnl), which encodes prerequisites and program
-- requirements as logic BLOCKS (ALL_OF / CHOOSE_N / CREDITS_FROM / OPTIONAL)
-- with member edges, rather than the hub's current flat link tables.
--
-- The existing flat tables (course_prerequisite_links, program_requirement_courses)
-- are RETAINED as a denormalized rollup for back-compat and the spoke's simpler
-- views; the populator emits both from the LLM AST (see table_populator.py).
--
-- NB: PKs follow the hub convention (UUID gen_random_uuid()), not the BIGSERIAL
-- sketch in HUB_UPGRADE_AIP_PARITY.md, so FKs line up with courses(id)/programs(id).

-- ---------------------------------------------------------------------------
-- WS2a — Prerequisites as logic blocks
-- ---------------------------------------------------------------------------
CREATE TABLE course_prereq_blocks (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      TEXT NOT NULL,
    course_id      UUID REFERENCES courses(id) ON DELETE CASCADE,
    document_id    UUID REFERENCES documents(id) ON DELETE CASCADE,
    logic_type     TEXT NOT NULL CHECK (logic_type IN ('ALL_OF','CHOOSE_N','CREDITS_FROM','OPTIONAL')),
    required_value INTEGER,          -- N for CHOOSE_N; credit count for CREDITS_FROM
    sequence_order INTEGER,          -- ordering of blocks within a course's prereqs
    created_at     TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE course_prereq_edges (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       TEXT NOT NULL,
    block_id        UUID REFERENCES course_prereq_blocks(id) ON DELETE CASCADE,
    target_course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT now(),
    UNIQUE (block_id, target_course_id)
);

-- ---------------------------------------------------------------------------
-- WS2b — Program requirements as logic blocks
-- ---------------------------------------------------------------------------
CREATE TABLE requirement_blocks (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      TEXT NOT NULL,
    program_id     UUID REFERENCES programs(id) ON DELETE CASCADE,
    document_id    UUID REFERENCES documents(id) ON DELETE CASCADE,
    block_code     TEXT,
    title          TEXT,
    logic_type     TEXT NOT NULL CHECK (logic_type IN ('ALL_OF','CHOOSE_N','CREDITS_FROM','OPTIONAL')),
    required_value INTEGER,          -- N for CHOOSE_N
    credits_min    INTEGER,
    credits_max    INTEGER,
    description    TEXT,
    sequence_order INTEGER,
    created_at     TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE block_courses (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  TEXT NOT NULL,
    block_id   UUID REFERENCES requirement_blocks(id) ON DELETE CASCADE,
    course_id  UUID REFERENCES courses(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    UNIQUE (block_id, course_id)
);

-- ---------------------------------------------------------------------------
-- WS3 schema — ghost courses (stop silently dropping unresolved prereq refs)
-- A prereq referencing a code absent from the catalog gets a placeholder course
-- (is_ghost = true) + a ghost_log row, then a normal edge to it, instead of a drop.
-- ---------------------------------------------------------------------------
ALTER TABLE courses ADD COLUMN IF NOT EXISTS is_ghost BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE ghost_log (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        TEXT NOT NULL,
    document_id      UUID REFERENCES documents(id) ON DELETE CASCADE,
    source_course_id UUID REFERENCES courses(id) ON DELETE CASCADE,  -- course that stated the prereq
    referenced_code  TEXT NOT NULL,                                  -- the unresolved code, e.g. "BIO-450"
    ghost_course_id  UUID REFERENCES courses(id) ON DELETE CASCADE,  -- the placeholder we created/linked
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Indexes (FK lookups + tenant filtering on the export hot path)
-- ---------------------------------------------------------------------------
CREATE INDEX idx_course_prereq_blocks_course   ON course_prereq_blocks (course_id);
CREATE INDEX idx_course_prereq_blocks_tenant   ON course_prereq_blocks (tenant_id);
CREATE INDEX idx_course_prereq_edges_block     ON course_prereq_edges (block_id);
CREATE INDEX idx_course_prereq_edges_target    ON course_prereq_edges (target_course_id);
CREATE INDEX idx_requirement_blocks_program    ON requirement_blocks (program_id);
CREATE INDEX idx_requirement_blocks_tenant     ON requirement_blocks (tenant_id);
CREATE INDEX idx_block_courses_block           ON block_courses (block_id);
CREATE INDEX idx_block_courses_course          ON block_courses (course_id);
CREATE INDEX idx_ghost_log_tenant              ON ghost_log (tenant_id);
CREATE INDEX idx_courses_is_ghost              ON courses (is_ghost) WHERE is_ghost = true;

-- ---------------------------------------------------------------------------
-- RLS — tenant isolation, mirroring the existing relational tables
-- ---------------------------------------------------------------------------
ALTER TABLE course_prereq_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_prereq_edges  ENABLE ROW LEVEL SECURITY;
ALTER TABLE requirement_blocks   ENABLE ROW LEVEL SECURITY;
ALTER TABLE block_courses        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ghost_log            ENABLE ROW LEVEL SECURITY;

-- Dropped tenant isolation policy for spoke

-- Dropped tenant isolation policy for spoke

-- Dropped tenant isolation policy for spoke

-- Dropped tenant isolation policy for spoke

-- Dropped tenant isolation policy for spoke
