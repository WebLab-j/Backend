FROM node:20-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY api/ml/requirements.txt ./api/ml/requirements.txt
RUN pip3 install --no-cache-dir -r api/ml/requirements.txt

COPY . .

RUN chmod +x /app/start.sh

ENV NODE_ENV=production
ENV ML_BASE_URL=http://127.0.0.1:8000
ENV MODEL_PATH=/app/api/ml/modeloweblab.joblib

CMD ["/app/start.sh"]
