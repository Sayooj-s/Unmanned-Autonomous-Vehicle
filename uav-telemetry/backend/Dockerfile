# Cloud Run container for the UAV telemetry backend.
# Cloud Run injects $PORT at runtime (defaults to 8080) — the CMD below
# binds to whatever it's given, so don't hardcode a port here.

FROM python:3.12-slim

WORKDIR /app

# System deps for psycopg2 (Postgres) — omit if you stay on SQLite only.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Backend code + the static frontend it can also serve directly if you
# choose not to split hosting via Firebase (see DEPLOY.md).
COPY main.py .
COPY frontend ./frontend

ENV PYTHONUNBUFFERED=1

CMD exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}
