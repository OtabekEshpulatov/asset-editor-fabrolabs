# Single image: build the React app, then run it from the Python backend.
# uvicorn serves the API, the /storage proxy, AND the static frontend (SPA).

# --- stage 1: build the frontend ---
FROM node:20-alpine AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build          # -> /fe/dist  (index.html + static/*)

# --- stage 2: backend + bundled frontend ---
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    ASSET_EDITOR_DATA_DIR=/data

WORKDIR /srv
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app
# Built frontend, served by uvicorn (config.WEB_DIR = /srv/web).
COPY --from=frontend /fe/dist ./web

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
