# ---------- file: start.sh ----------
#!/usr/bin/env bash
set -eu

# Levanta ML (interno)
python3 -m uvicorn api.ml.main:app --host 0.0.0.0 --port 8000 &

# Levanta Node (externo) - DEBE escuchar en $PORT dentro de src/server.js
node src/server.js
