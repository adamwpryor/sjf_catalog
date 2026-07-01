# Hub-Spoke Contract

The SJFU catalog (spoke) is a consumer of the CDI Factory (hub).
- **Ingestion**: Hub (Spark) is responsible for all SIS data ingestion and markdown extraction.
- **Data Load**: `deploy_client_db.py` on the hub pushes Postgres records to the spoke's Supabase instance.
- **Runtime decoupling**: The spoke has no runtime dependency on the hub.
- **Embeddings**: The spoke uses `gemini-embedding-001` at 1536 dimensions. Re-embedding of hub chunks is performed locally on the spoke during initialization.
