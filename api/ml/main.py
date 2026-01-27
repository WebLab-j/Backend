# """
# Backend FastAPI para servir el modelo joblib.

# Run:
#   cd backend
#   pip install -r requirements.txt
#   uvicorn main:app --reload --port 8000
# """
# from __future__ import annotations

# from pathlib import Path
# from typing import Dict, Optional

# import pandas as pd
# from fastapi import FastAPI
# from fastapi.middleware.cors import CORSMiddleware
# from pydantic import BaseModel, Field
# from joblib import load

# MODEL_PATH = Path(__file__).with_name("modelo_productividad.joblib")

# # ✅ Mapeo corregido
# LABEL_MAP: Dict[int, str] = {
#     0: "no_productivo",
#     1: "productivo",
#     2: "regular",
# }

# FEATURES = ["actividades", "revisiones", "tiempo_total"]

# app = FastAPI(title="Productividad API", version="1.0.0")

# # CORS (ajusta el puerto/origen si tu React usa otro)
# app.add_middleware(
#     CORSMiddleware,
#     allow_origins=[
#         "http://localhost:5173",  # Vite
#         "http://localhost:3000",  # CRA/Next dev
#     ],
#     allow_credentials=True,
#     allow_methods=["*"],
#     allow_headers=["*"],
# )

# if not MODEL_PATH.exists():
#     raise FileNotFoundError(
#         f"No encontré el modelo en {MODEL_PATH}. "
#         "Copia 'modelo_productividad.joblib' dentro de /backend"
#     )

# model = load(MODEL_PATH)


# class PredictIn(BaseModel):
#     actividades: int = Field(..., ge=0)
#     revisiones: int = Field(..., ge=0)
#     tiempo_total: int = Field(..., ge=0)


# class PredictOut(BaseModel):
#     clase: int
#     label: str
#     probabilidades: Optional[Dict[str, float]] = None


# @app.get("/health")
# def health():
#     return {"status": "ok"}


# @app.post("/predict", response_model=PredictOut)
# def predict(payload: PredictIn) -> PredictOut:
#     row = pd.DataFrame([payload.model_dump()])[FEATURES]
#     pred = int(model.predict(row)[0])

#     out = PredictOut(clase=pred, label=LABEL_MAP.get(pred, str(pred)))

#     if hasattr(model, "predict_proba"):
#         probs = model.predict_proba(row)[0]
#         labels_sorted = [LABEL_MAP[i] for i in sorted(LABEL_MAP.keys())]
#         out.probabilidades = {labels_sorted[i]: float(probs[i]) for i in range(len(labels_sorted))}

#     return out



# """
# Backend FastAPI para servir el modelo joblib.

# Run:
#   cd backend
#   pip install -r requirements.txt
#   uvicorn main:app --reload --port 8000
# """
# from __future__ import annotations

# from pathlib import Path
# from typing import Dict, Optional

# import pandas as pd
# from fastapi import FastAPI
# from fastapi.middleware.cors import CORSMiddleware
# from pydantic import BaseModel, Field
# from joblib import load

# MODEL_PATH = Path(__file__).with_name("modelo_productividad.joblib")

# # ✅ Mapeo corregido
# LABEL_MAP: Dict[int, str] = {
#     0: "no_productivo",
#     1: "productivo",
#     2: "regular",
# }

# # ✅ ACTUALIZADO: Ahora incluye los 2 nuevos campos
# FEATURES = ["actividades", "revisiones_con_duracion", "revisiones_sin_duracion", "tiempo_total"]

# app = FastAPI(title="Productividad API", version="1.0.0")

# # CORS (ajusta el puerto/origen si tu React usa otro)
# app.add_middleware(
#     CORSMiddleware,
#     allow_origins=[
#         "http://localhost:5173",  # Vite
#         "http://localhost:3000",  # CRA/Next dev
#     ],
#     allow_credentials=True,
#     allow_methods=["*"],
#     allow_headers=["*"],
# )

# if not MODEL_PATH.exists():
#     raise FileNotFoundError(
#         f"No encontré el modelo en {MODEL_PATH}. "
#         "Copia 'modelo_productividad.joblib' dentro de /backend"
#     )

# model = load(MODEL_PATH)


# class PredictIn(BaseModel):
#     actividades: int = Field(..., ge=0)
#     revisiones_con_duracion: int = Field(..., ge=0)  # ✅ NUEVO
#     revisiones_sin_duracion: int = Field(..., ge=0)  # ✅ NUEVO
#     tiempo_total: int = Field(..., ge=0)


# class PredictOut(BaseModel):
#     clase: int
#     label: str
#     probabilidades: Optional[Dict[str, float]] = None


# @app.get("/health")
# def health():
#     return {"status": "ok"}


# @app.post("/predict", response_model=PredictOut)
# def predict(payload: PredictIn) -> PredictOut:
#     row = pd.DataFrame([payload.model_dump()])[FEATURES]
#     pred = int(model.predict(row)[0])

#     out = PredictOut(clase=pred, label=LABEL_MAP.get(pred, str(pred)))

#     if hasattr(model, "predict_proba"):
#         probs = model.predict_proba(row)[0]
#         labels_sorted = [LABEL_MAP[i] for i in sorted(LABEL_MAP.keys())]
#         out.probabilidades = {labels_sorted[i]: float(probs[i]) for i in range(len(labels_sorted))}

#     return out
"""
Backend FastAPI para servir el modelo joblib.

Run:
  cd backend
  pip install -r requirements.txt
  uvicorn main:app --reload --port 8000
"""
from __future__ import annotations

from pathlib import Path
from typing import Dict, Optional

import pandas as pd
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from joblib import load

MODEL_PATH = Path(__file__).with_name("modeloweblab.joblib")

# ✅ Mapeo corregido
LABEL_MAP: Dict[int, str] = {
    0: "no_productivo",
    1: "productivo",
    2: "regular",
}

# ✅ SIMPLE: Solo 4 features (sin colaborador, sin fechas)
FEATURES = ["actividades", "revisiones_con_duracion", "revisiones_sin_duracion", "tiempo_total"]

app = FastAPI(title="Productividad API", version="1.0.0")

# CORS (ajusta el puerto/origen si tu React usa otro)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",  # Vite
        "http://localhost:3000",  # CRA/Next dev
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if not MODEL_PATH.exists():
    raise FileNotFoundError(
        f"No encontré el modelo en {MODEL_PATH}. "
        "Copia 'modeloweblab.joblib' dentro de /backend"
    )

model = load(MODEL_PATH)


class PredictIn(BaseModel):
    actividades: int = Field(..., ge=0)
    revisiones_con_duracion: int = Field(..., ge=0)
    revisiones_sin_duracion: int = Field(..., ge=0)
    tiempo_total: int = Field(..., ge=0)


class PredictOut(BaseModel):
    clase: int
    label: str
    probabilidades: Optional[Dict[str, float]] = None


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/predict", response_model=PredictOut)
def predict(payload: PredictIn) -> PredictOut:
    row = pd.DataFrame([payload.model_dump()])[FEATURES]
    pred = int(model.predict(row)[0])

    out = PredictOut(clase=pred, label=LABEL_MAP.get(pred, str(pred)))

    if hasattr(model, "predict_proba"):
        probs = model.predict_proba(row)[0]
        labels_sorted = [LABEL_MAP[i] for i in sorted(LABEL_MAP.keys())]
        out.probabilidades = {labels_sorted[i]: float(probs[i]) for i in range(len(labels_sorted))}

    return out