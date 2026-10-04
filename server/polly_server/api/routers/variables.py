from __future__ import annotations

from fastapi import APIRouter, HTTPException

from polly_server import variables
from polly_server.api.schemas import VariableIn, VariableList, VariableOut

router = APIRouter(prefix="/variables", tags=["variables"])


def _list() -> VariableList:
    return VariableList(variables=[VariableOut.of(v) for v in variables.all_variables()])


@router.get("", response_model=VariableList)
def list_variables() -> VariableList:
    """Settings and secrets for agents. Secret values are never sent back."""
    return _list()


@router.put("/{name}", response_model=VariableOut)
def put_variable(name: str, body: VariableIn) -> VariableOut:
    try:
        saved = variables.put(name, **body.model_dump(exclude_none=True))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    return VariableOut.of(saved)


@router.delete("/{name}", response_model=VariableList)
def delete_variable(name: str) -> VariableList:
    if not variables.delete(name):
        raise HTTPException(404, f"no variable {name!r}")
    return _list()
