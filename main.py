import os
from fastapi import FastAPI, Request
from dotenv import load_dotenv
import uvicorn

load_dotenv()

app = FastAPI()

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/v1/lead")
def post_lead(request: Request):
    # TODO: Implement Kafka publish and DB insert
    return {"message": "Lead received"}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("INGESTION_API_PORT", 8080)))
