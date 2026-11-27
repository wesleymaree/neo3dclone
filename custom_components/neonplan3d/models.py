"""Own 3D models: furniture imported from .obj or .step files (fork).

The browser turns the file into a compact mesh (positions quantised to 16 bits in the item's box, triangle
indices, optional vertex colours, each base64) and sends it here. The models are kept in a store of their
own, apart from the signed packs: a backup restore of the packs never touches them, and every user gets
them (like the packs) to see the furniture.
"""

from __future__ import annotations

import base64
import binascii
import time
from typing import Any
import uuid

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store
import voluptuous as vol

from .const import DOMAIN, STORAGE_VERSION

STORAGE_KEY_MODELS = f"{DOMAIN}.models"
_STORE = f"{DOMAIN}_models"

MAX_MODELS = 200
# the websocket takes messages up to 4 MiB: one model stays well below that
MAX_VERTICES = 65_535 * 2
MAX_TRIANGLES = 60_000
_MAX_B64 = 3_000_000

KINDS = [
    "sofa",
    "seating",
    "table",
    "storage",
    "bed",
    "kitchen",
    "appliance",
    "bath",
    "lamp",
    "media",
    "office",
    "tech",
    "heating",
    "energy",
    "household",
    "deco",
    "plant",
    "outdoor",
    "kids",
    "sport",
    "pets",
    "vehicle",
    "stairs",
    "architecture",
]

# what a model is: decides what a linked entity does with it (a lamp glows, a TV shows its picture)
MODEL_KINDS = [
    "furniture",
    "lamp_ceiling",
    "lamp_pendant",
    "lamp_floor",
    "lamp_table",
    "lamp_wall",
    "lamp_strip",
    "tv",
    "appliance",
    "washer",
    "dryer",
    "dishwasher",
    "oven",
    "fridge",
    "plant",
    "sensor",
]

_METRES = vol.All(vol.Coerce(float), vol.Range(min=0.01, max=50))
_B64 = vol.All(str, vol.Length(min=4, max=_MAX_B64), vol.Match(r"^[A-Za-z0-9+/]+={0,2}$"))

MESH_SCHEMA = vol.Schema(
    {
        vol.Required("n"): vol.All(int, vol.Range(min=3, max=MAX_VERTICES)),
        vol.Required("t"): vol.All(int, vol.Range(min=1, max=MAX_TRIANGLES)),
        vol.Required("v"): _B64,
        vol.Required("i"): _B64,
        vol.Optional("c"): _B64,
        # the outline: m pairs of vertex indices (none when switched off)
        vol.Optional("e"): _B64,
        vol.Optional("m"): vol.All(int, vol.Range(min=0, max=MAX_TRIANGLES * 3)),
    }
)

MODEL_SCHEMA = vol.Schema(
    {
        vol.Required("name"): vol.All(str, vol.Strip, vol.Length(min=1, max=80)),
        vol.Required("size"): vol.All([_METRES], vol.Length(min=3, max=3)),
        vol.Optional("group", default="deco"): vol.In(KINDS),
        vol.Optional("kind", default="furniture"): vol.In(MODEL_KINDS),
        vol.Required("mesh"): MESH_SCHEMA,
    }
)

# what can be changed on a model after its import
CHANGES_SCHEMA = vol.Schema(
    {
        vol.Optional("name"): vol.All(str, vol.Strip, vol.Length(min=1, max=80)),
        vol.Optional("group"): vol.In(KINDS),
        vol.Optional("kind"): vol.In(MODEL_KINDS),
    }
)


class MeshError(Exception):
    """A mesh whose data does not fit its counts."""


def _decoded_length(text: str) -> int:
    try:
        return len(base64.b64decode(text, validate=True))
    except (binascii.Error, ValueError) as err:
        raise MeshError("not base64") from err


def check_mesh(mesh: dict[str, Any]) -> None:
    """The byte lengths must match the vertex and triangle counts (16-bit indices up to 65535 vertices)."""
    n, t = mesh["n"], mesh["t"]
    if _decoded_length(mesh["v"]) != n * 3 * 2:
        raise MeshError("positions do not match the vertex count")
    index_size = 2 if n <= 65_535 else 4
    if _decoded_length(mesh["i"]) != t * 3 * index_size:
        raise MeshError("indices do not match the triangle count")
    if "c" in mesh and _decoded_length(mesh["c"]) != n * 3:
        raise MeshError("colours do not match the vertex count")
    if "e" in mesh and _decoded_length(mesh["e"]) != mesh.get("m", -1) * 2 * index_size:
        raise MeshError("the outline does not match its count")


class ModelStore:
    """The imported models, kept in .storage."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Set up the store."""
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY_MODELS)
        self.models: list[dict[str, Any]] = []
        self._loaded = False

    async def async_load(self) -> None:
        """Load once."""
        if self._loaded:
            return
        stored = await self._store.async_load()
        models = (stored or {}).get("models", [])
        self.models = [m for m in models if isinstance(m, dict) and isinstance(m.get("id"), str)]
        self._loaded = True

    async def async_add(self, model: dict[str, Any]) -> dict[str, Any]:
        """Keep a new model and return it with its id."""
        entry = {**model, "id": uuid.uuid4().hex[:12], "created": time.time()}
        self.models = [*self.models, entry]
        await self._store.async_save({"models": self.models})
        return entry

    async def async_update(self, model_id: str, changes: dict[str, Any]) -> dict[str, Any] | None:
        """Change a model's name, category or kind; None when there is no such model."""
        model = next((m for m in self.models if m["id"] == model_id), None)
        if model is None:
            return None
        changed = {**model, **changes}
        self.models = [changed if m["id"] == model_id else m for m in self.models]
        await self._store.async_save({"models": self.models})
        return changed

    async def async_remove(self, model_id: str) -> bool:
        """Remove a model (furniture using it stays in the plan as a plain box)."""
        kept = [m for m in self.models if m["id"] != model_id]
        if len(kept) == len(self.models):
            return False
        self.models = kept
        await self._store.async_save({"models": self.models})
        return True


async def _models(hass: HomeAssistant) -> ModelStore:
    store: ModelStore | None = hass.data.get(_STORE)
    if store is None:
        store = hass.data[_STORE] = ModelStore(hass)
    await store.async_load()
    return store


@websocket_api.websocket_command({vol.Required("type"): "neonplan3d/models/list"})
@websocket_api.async_response
async def ws_models_list(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """All imported models (every user needs them to see the furniture)."""
    store = await _models(hass)
    connection.send_result(msg["id"], {"models": store.models})


@websocket_api.websocket_command({vol.Required("type"): "neonplan3d/models/add", vol.Required("model"): dict})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_models_add(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Check a converted model and keep it."""
    try:
        model = MODEL_SCHEMA(msg["model"])
        check_mesh(model["mesh"])
    except (vol.Invalid, MeshError) as err:
        connection.send_error(msg["id"], "invalid_model", str(err))
        return
    store = await _models(hass)
    if len(store.models) >= MAX_MODELS:
        connection.send_error(msg["id"], "too_many", f"at most {MAX_MODELS} models")
        return
    entry = await store.async_add(model)
    connection.send_result(msg["id"], {"id": entry["id"], "name": entry["name"]})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "neonplan3d/models/update",
        vol.Required("model_id"): vol.All(str, vol.Length(max=32)),
        vol.Required("changes"): dict,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_models_update(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Rename a model, or change its category or kind."""
    try:
        changes = CHANGES_SCHEMA(msg["changes"])
    except vol.Invalid as err:
        connection.send_error(msg["id"], "invalid_model", str(err))
        return
    store = await _models(hass)
    if await store.async_update(msg["model_id"], changes) is None:
        connection.send_error(msg["id"], "not_found", "Model not found")
        return
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {vol.Required("type"): "neonplan3d/models/remove", vol.Required("model_id"): vol.All(str, vol.Length(max=32))}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_models_remove(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Remove an imported model."""
    store = await _models(hass)
    if not await store.async_remove(msg["model_id"]):
        connection.send_error(msg["id"], "not_found", "Model not found")
        return
    connection.send_result(msg["id"])


COMMANDS = (ws_models_list, ws_models_add, ws_models_update, ws_models_remove)
