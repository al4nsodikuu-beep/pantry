FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY backend /app/backend
RUN useradd --uid 10001 --create-home pantry && mkdir /data && chown pantry:pantry /data
USER pantry
EXPOSE 8080
CMD ["uvicorn","backend.app:app","--host","0.0.0.0","--port","8080","--workers","1","--no-access-log"]
