# file: Dockerfile
FROM node:20-bookworm

WORKDIR /app

# Python + venv + deps comunes (pandas/sklearn pueden necesitar build tools)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    build-essential gfortran libopenblas-dev \
  && rm -rf /var/lib/apt/lists/*

# Node deps (cache)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Python deps en venv (PEP 668 safe)
ENV VENV_PATH=/opt/venv
RUN python3 -m venv ${VENV_PATH}
ENV PATH="${VENV_PATH}/bin:${PATH}"

COPY api/ml/requirements.txt ./api/ml/requirements.txt
RUN pip install --upgrade pip setuptools wheel \
 && pip install --no-cache-dir -r api/ml/requirements.txt

# App code
COPY . .

RUN chmod +x /app/start.sh

ENV NODE_ENV=production
ENV ML_BASE_URL=http://127.0.0.1:8000
ENV MODEL_PATH=/app/api/ml/modeloweblab.joblib

CMD ["/app/start.sh"]
