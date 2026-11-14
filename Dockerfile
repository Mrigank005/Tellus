FROM python:3.12-slim
WORKDIR /app
COPY requirements-backend.txt .
RUN pip install --no-cache-dir -r requirements-backend.txt
COPY backend backend
COPY pipeline pipeline
COPY config config
COPY frontend/public/data frontend/public/data
COPY frontend/public/config-missions.json frontend/public/config-missions.json
ENV PYTHONUNBUFFERED=1 \
    PORT=8000
EXPOSE 8000
# Honour $PORT (Render and most PaaS set it); default 8000 for local Docker.
CMD ["sh", "-c", "uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
