"""Own 3D models (fork): imported .obj/.step furniture, kept in a store of their own."""

from __future__ import annotations

import base64
import struct

from homeassistant.core import HomeAssistant

from custom_components.neonplan3d.models import STORAGE_KEY_MODELS

from .test_init import _setup


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


# a single triangle: three vertices (16-bit positions), one triangle (16-bit indices), rgb per vertex
TRIANGLE = {
    "n": 3,
    "t": 1,
    "v": _b64(struct.pack("<9H", 0, 0, 0, 65535, 0, 0, 0, 65535, 65535)),
    "i": _b64(struct.pack("<3H", 0, 1, 2)),
    "c": _b64(bytes([255, 0, 0] * 3)),
}


async def _ws(client, **msg):
    await client.send_json_auto_id(msg)
    return await client.receive_json()


async def test_add_list_and_remove_a_model(hass: HomeAssistant, hass_ws_client, hass_storage) -> None:
    await _setup(hass)
    client = await hass_ws_client(hass)
    assert (await _ws(client, type="neonplan3d/models/list"))["result"] == {"models": []}
    model = {"name": " Sofa ", "size": [2, 1, 0.8], "group": "sofa", "mesh": TRIANGLE}
    added = (await _ws(client, type="neonplan3d/models/add", model=model))["result"]
    assert added["name"] == "Sofa"
    listed = (await _ws(client, type="neonplan3d/models/list"))["result"]["models"]
    assert [m["id"] for m in listed] == [added["id"]]
    assert listed[0]["mesh"] == TRIANGLE and listed[0]["size"] == [2.0, 1.0, 0.8]
    assert hass_storage[STORAGE_KEY_MODELS]["data"]["models"][0]["id"] == added["id"]
    assert (await _ws(client, type="neonplan3d/models/remove", model_id=added["id"]))["success"]
    assert (await _ws(client, type="neonplan3d/models/list"))["result"] == {"models": []}
    missing = await _ws(client, type="neonplan3d/models/remove", model_id=added["id"])
    assert missing["error"]["code"] == "not_found"


async def test_a_mesh_must_match_its_counts(hass: HomeAssistant, hass_ws_client) -> None:
    await _setup(hass)
    client = await hass_ws_client(hass)
    for mesh in (
        {**TRIANGLE, "n": 4},
        {**TRIANGLE, "t": 2},
        {**TRIANGLE, "c": _b64(bytes(3))},
        {**TRIANGLE, "v": "not base64!"},
    ):
        res = await _ws(client, type="neonplan3d/models/add", model={"name": "X", "size": [1, 1, 1], "mesh": mesh})
        assert res["error"]["code"] == "invalid_model", mesh
    res = await _ws(client, type="neonplan3d/models/add", model={"name": "X", "size": [0, 1, 1], "mesh": TRIANGLE})
    assert res["error"]["code"] == "invalid_model"


async def test_only_admins_add_models(hass: HomeAssistant, hass_ws_client, hass_read_only_access_token) -> None:
    await _setup(hass)
    client = await hass_ws_client(hass, hass_read_only_access_token)
    res = await _ws(client, type="neonplan3d/models/add", model={"name": "X", "size": [1, 1, 1], "mesh": TRIANGLE})
    assert res["error"]["code"] == "unauthorized"
    # everyone sees the furniture
    assert (await _ws(client, type="neonplan3d/models/list"))["success"]
