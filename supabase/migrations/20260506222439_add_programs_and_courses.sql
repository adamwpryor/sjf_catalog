CREATE TABLE programs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    degree_type TEXT,
    description TEXT,
    total_credits INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE courses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    section TEXT,
    course_code TEXT NOT NULL,
    title TEXT NOT NULL,
    credits INTEGER,
    description TEXT,
    prerequisites TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Apply Row Level Security (RLS) as mandated by Zero-Trust
ALTER TABLE programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE courses ENABLE ROW LEVEL SECURITY;

-- Dropped tenant isolation policy for spoke

-- Dropped tenant isolation policy for spoke
