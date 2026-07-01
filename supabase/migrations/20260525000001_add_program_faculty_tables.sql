-- CDI Factory — Program, Faculty, and Prerequisite Supporting Tables
-- These tables complete the relational schema for the Hub-to-Cloud replication contract.

CREATE TABLE program_requirements (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      TEXT NOT NULL,
    program_id     UUID REFERENCES programs(id) ON DELETE CASCADE,
    degree_name    TEXT NOT NULL,
    logic_tree     TEXT NOT NULL,
    created_at     TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE program_requirement_courses (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      TEXT NOT NULL,
    requirement_id UUID REFERENCES program_requirements(id) ON DELETE CASCADE,
    course_id      UUID REFERENCES courses(id) ON DELETE CASCADE,
    group_name     TEXT,
    or_group_id    INTEGER,
    is_required    BOOLEAN DEFAULT true,
    created_at     TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE course_prerequisite_links (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       TEXT NOT NULL,
    course_id       UUID REFERENCES courses(id) ON DELETE CASCADE,
    prereq_course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE faculty (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  TEXT NOT NULL,
    name       TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE TABLE program_faculty (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  TEXT NOT NULL,
    program_id UUID REFERENCES programs(id) ON DELETE CASCADE,
    faculty_id UUID REFERENCES faculty(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- RLS
ALTER TABLE program_requirements       ENABLE ROW LEVEL SECURITY;
ALTER TABLE program_requirement_courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_prerequisite_links  ENABLE ROW LEVEL SECURITY;
ALTER TABLE faculty                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE program_faculty            ENABLE ROW LEVEL SECURITY;

-- Dropped tenant isolation policy for spoke

-- Dropped tenant isolation policy for spoke

-- Dropped tenant isolation policy for spoke

-- Dropped tenant isolation policy for spoke

-- Dropped tenant isolation policy for spoke
