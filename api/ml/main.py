"""
Backend FastAPI para servir el modelo joblib.

Run:
  cd backend
  pip install -r requirements.txt
  uvicorn main:app --reload --port 8000
"""
from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import pandas as pd
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from joblib import dump as joblib_dump
from joblib import load
from pydantic import BaseModel, Field
from sklearn.linear_model import LinearRegression

MODEL_PATH = Path(__file__).with_name("modeloweblab.joblib")
AR1_MODEL_DIR = Path(__file__).parent  # guarda modelo_ar1_{userId}.joblib aquí

LABEL_MAP: Dict[int, str] = {
    0: "no_productivo",
    1: "productivo",
    2: "regular",
}

FEATURES = ["actividades", "revisiones_con_duracion", "revisiones_sin_duracion", "tiempo_total"]

app = FastAPI(title="Productividad API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if not MODEL_PATH.exists():
    raise FileNotFoundError(
        f"No encontré el modelo en {MODEL_PATH}. "
        "Copia 'modeloweblab.joblib' dentro de /backend/api/ml"
    )

model = load(MODEL_PATH)


# ---------------------------------------------------------------------------
# Schemas — prediccion diaria (sin cambios vs original)
# ---------------------------------------------------------------------------

class PredictIn(BaseModel):
    actividades: int = Field(..., ge=0)
    revisiones_con_duracion: int = Field(..., ge=0)
    revisiones_sin_duracion: int = Field(..., ge=0)
    tiempo_total: int = Field(..., ge=0)


class PredictOut(BaseModel):
    clase: int
    label: str
    probabilidades: Optional[Dict[str, float]] = None


# ---------------------------------------------------------------------------
# Schemas — AR(1) individual por usuario
# ---------------------------------------------------------------------------

class DayScore(BaseModel):
    day: str
    score: float = Field(..., ge=0.0, le=1.0)


class PredictTomorrowIn(BaseModel):
    user_id: str
    history: List[DayScore] = Field(..., min_length=2)


class PredictTomorrowOut(BaseModel):
    user_id: str
    score_predicho: float
    label: str
    phi: float
    c: float
    n_observaciones: int
    score_hoy: float


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def score_to_label(score: float) -> str:
    if score >= 0.6:
        return "productivo"
    if score >= 0.35:
        return "regular"
    return "no_productivo"


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

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


@app.post("/predict-tomorrow", response_model=PredictTomorrowOut)
def predict_tomorrow(payload: PredictTomorrowIn) -> PredictTomorrowOut:
    sorted_history = sorted(payload.history, key=lambda d: d.day)
    scores = [entry.score for entry in sorted_history]

    X = np.array(scores[:-1]).reshape(-1, 1)
    y = np.array(scores[1:])

    model_ar1 = LinearRegression()
    model_ar1.fit(X, y)

    phi = float(model_ar1.coef_[0])
    c = float(model_ar1.intercept_)

    # Guardar modelo AR(1) por usuario
    ar1_path = AR1_MODEL_DIR / f"modelo_ar1_{payload.user_id}.joblib"
    joblib_dump(model_ar1, ar1_path)

    score_hoy = scores[-1]
    score_raw = float(model_ar1.predict([[score_hoy]])[0])
    score_predicho = max(0.0, min(1.0, score_raw))

    return PredictTomorrowOut(
        user_id=payload.user_id,
        score_predicho=round(score_predicho, 4),
        label=score_to_label(score_predicho),
        phi=round(phi, 6),
        c=round(c, 6),
        n_observaciones=len(scores),
        score_hoy=round(score_hoy, 4),
    )