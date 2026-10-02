from __future__ import annotations

from fastapi import APIRouter

from polly_server import model_registry
from polly_server.api.schemas import ModelList, ModelOption
from polly_server.config import settings

router = APIRouter(tags=["models"])


@router.get("/models", response_model=ModelList)
def list_models() -> ModelList:
    return ModelList(
        models=[
            ModelOption(
                id=m.id,
                label=m.label,
                vendor=m.vendor,
                context_window=m.context_window,
                reasoning=m.reasoning,
                is_default=m.id == settings.model,
                is_default_fast=m.id == settings.fast_model,
            )
            for m in model_registry.MODELS
        ],
        default=settings.model,
        default_fast=settings.fast_model,
    )
