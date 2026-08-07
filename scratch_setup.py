import json
import psycopg2
from verification_harness.cli import _load_env_local
from verification_harness.db import _dsn

_load_env_local()

conn = psycopg2.connect(_dsn())
conn.set_session(autocommit=True)
cur = conn.cursor()

# Clean up any previous run
cur.execute("DELETE FROM courses WHERE id = 'scratch-1'")

# Insert scratch row
cur.execute("INSERT INTO courses (id, course_code, title, credits, is_ghost) VALUES ('scratch-1', 'TEST 999', 'Scratch Course', 4, false)")
print("Inserted scratch row with credits=4")

# Write a fake finding
with open("scratch_findings.jsonl", "w") as f:
    f.write(json.dumps({
        "id": "scratch:B1", 
        "check": "B1", 
        "entity_id": "scratch-1", 
        "verdict": "CONFIRMED", 
        "claim": "Credits mismatch for TEST 999: page says 3, DB says 4"
    }) + "\n")
print("Created scratch_findings.jsonl")
