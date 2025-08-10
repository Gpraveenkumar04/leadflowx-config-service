import os
import math
from typing import List, Optional
from datetime import datetime

from fastapi import FastAPI, Query, HTTPException, Body
from pydantic import BaseModel
from dotenv import load_dotenv
import psycopg2
from psycopg2.pool import SimpleConnectionPool
import uvicorn

load_dotenv()

DB_URL = os.getenv("DB_URL") or os.getenv("DATABASE_URL")
if not DB_URL:
    # Allow running without a database for now (UI will just see empty lists)
    pool: Optional[SimpleConnectionPool] = None
else:
    pool = SimpleConnectionPool(minconn=1, maxconn=5, dsn=DB_URL)

app = FastAPI(title="LeadFlowX Leads API")


def init_db():
    if not pool:
        return
    ddl = """
    CREATE TABLE IF NOT EXISTS raw_leads (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        company TEXT NOT NULL,
        website TEXT NOT NULL,
        phone TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    """
    conn = pool.getconn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(ddl)
    finally:
        pool.putconn(conn)


@app.on_event("startup")
def on_startup():
    init_db()


class Lead(BaseModel):
    id: int
    email: str
    name: str
    company: str
    website: str
    phone: str
    correlationId: str
    createdAt: datetime
    # UI extended / optional fields
    source: Optional[str] = "google_maps"
    scrapedAt: Optional[datetime] = None
    auditScore: Optional[float] = None
    leadScore: Optional[float] = None
    qaStatus: Optional[str] = None


class Pagination(BaseModel):
    page: int
    pageSize: int
    total: int
    totalPages: int


class ApiResponse(BaseModel):
    success: bool = True
    data: Optional[object] = None
    message: Optional[str] = None


class PaginatedResponse(ApiResponse):
    data: List[Lead]
    pagination: Pagination


class LeadIn(BaseModel):
    email: str
    name: str
    company: str
    website: str
    phone: str
    correlationId: Optional[str] = None
    source: Optional[str] = "google_maps"



def fetch_all(query: str, params: tuple = ()):  # helper
    if not pool:
        return []
    conn = pool.getconn()
    try:
        with conn.cursor() as cur:
            cur.execute(query, params)
            rows = cur.fetchall()
        return rows
    finally:
        pool.putconn(conn)


def fetch_one(query: str, params: tuple = ()):  # helper
    if not pool:
        return None
    conn = pool.getconn()
    try:
        with conn.cursor() as cur:
            cur.execute(query, params)
            row = cur.fetchone()
        return row
    finally:
        pool.putconn(conn)


@app.get("/health")
def health():
    return {"status": "ok", "db": bool(pool)}


@app.get("/api/leads", response_model=PaginatedResponse)
def list_leads(
    page: int = Query(1, ge=1),
    pageSize: int = Query(25, ge=1, le=200),
    search: Optional[str] = None,
    source: Optional[List[str]] = Query(None),  # For future multi-source
    dateFrom: Optional[str] = None,
    dateTo: Optional[str] = None,
):
    if not pool:
        return PaginatedResponse(data=[], pagination=Pagination(page=page, pageSize=pageSize, total=0, totalPages=0))

    filters = []
    params: List[object] = []

    if search:
        filters.append("(email ILIKE %s OR name ILIKE %s OR company ILIKE %s OR website ILIKE %s)")
        like = f"%{search}%"
        params.extend([like, like, like, like])

    # Currently only google_maps source exists; accept filter but ignore others gracefully
    if source:
        if "google_maps" not in source:
            # No matching sources
            return PaginatedResponse(data=[], pagination=Pagination(page=page, pageSize=pageSize, total=0, totalPages=0))

    if dateFrom:
        filters.append("created_at >= %s")
        params.append(dateFrom)
    if dateTo:
        filters.append("created_at <= %s")
        params.append(dateTo)

    where_clause = f"WHERE {' AND '.join(filters)}" if filters else ""

    count_row = fetch_one(f"SELECT COUNT(*) FROM raw_leads {where_clause}", tuple(params))
    total = count_row[0] if count_row else 0
    total_pages = math.ceil(total / pageSize) if total else 0
    offset = (page - 1) * pageSize

    rows = fetch_all(
        f"SELECT id, email, name, company, website, phone, correlation_id, created_at FROM raw_leads {where_clause} ORDER BY id DESC LIMIT %s OFFSET %s",
        tuple(params + [pageSize, offset]),
    )

    leads: List[Lead] = []
    for r in rows:
        (rid, email, name, company, website, phone, correlation_id, created_at) = r
        leads.append(
            Lead(
                id=rid,
                email=email,
                name=name,
                company=company,
                website=website,
                phone=phone,
                correlationId=correlation_id,
                createdAt=created_at,
                scrapedAt=created_at,
                source="google_maps",
            )
        )

    return PaginatedResponse(
        data=leads,
        pagination=Pagination(page=page, pageSize=pageSize, total=total, totalPages=total_pages),
    )


@app.get("/api/leads/raw/count", response_model=ApiResponse)
def raw_lead_count():
    if not pool:
        return ApiResponse(data={"count": 0})
    row = fetch_one("SELECT COUNT(*) FROM raw_leads")
    return ApiResponse(data={"count": row[0] if row else 0})


@app.get("/api/leads/by-source", response_model=ApiResponse)
def leads_by_source():
    if not pool:
        return ApiResponse(data=[{"source": "google_maps", "count": 0}])
    row = fetch_one("SELECT COUNT(*) FROM raw_leads")
    return ApiResponse(data=[{"source": "google_maps", "count": row[0] if row else 0}])


@app.get("/api/leads/status-funnel", response_model=ApiResponse)
def status_funnel():
    # Only raw currently available; others default to 0 until those pipelines are implemented
    if not pool:
        raw = 0
    else:
        row = fetch_one("SELECT COUNT(*) FROM raw_leads")
        raw = row[0] if row else 0
    funnel = {"raw": raw, "verified": 0, "audited": 0, "qaPassed": 0, "scored": 0}
    return ApiResponse(data=funnel)


@app.post("/v1/lead", response_model=ApiResponse)
def post_lead(payload: LeadIn = Body(...)):
    if not pool:
        raise HTTPException(status_code=503, detail="Database not configured")
    init_db()  # ensure table exists (idempotent)
    correlation_id = payload.correlationId or f"manual-{int(datetime.utcnow().timestamp())}-{payload.email}"
    conn = pool.getconn()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO raw_leads (email, name, company, website, phone, correlation_id)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (email) DO UPDATE SET
                    name = EXCLUDED.name,
                    company = EXCLUDED.company,
                    website = EXCLUDED.website,
                    phone = EXCLUDED.phone,
                    correlation_id = EXCLUDED.correlation_id
                RETURNING id, created_at
                """,
                (
                    payload.email,
                    payload.name,
                    payload.company,
                    payload.website,
                    payload.phone,
                    correlation_id,
                ),
            )
            row = cur.fetchone()
        lead_id, created_at = row
    finally:
        pool.putconn(conn)
    return ApiResponse(data={"id": lead_id, "correlationId": correlation_id, "createdAt": created_at}, message="Lead ingested")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("INGESTION_API_PORT", 8080)))
