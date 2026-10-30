"""Emit independent Sparkplug B wire fixtures for the browser E2E runner."""

import base64
import json

from pysparkplug import DBirth, DData, DDeath, DataType, Metric, NBirth, NData
from pysparkplug import _protobuf as protobuf


def metric(name, datatype, value, alias=0):
    return Metric(timestamp=1, name=name, datatype=datatype, value=value, alias=alias)


def wire(kind, payload, device=False):
    topic = f"spBv1.0/E2E/{kind}/PythonNode"
    if device:
        topic += "/PythonDevice"
    return {
        "topic": topic,
        "payload": base64.b64encode(payload.encode()).decode("ascii"),
    }


node_birth = wire("NBIRTH", NBirth(1, 0, (
    metric("NodeCounter", DataType.UINT64, 2**64 - 1),
)))
device_birth = wire("DBIRTH", DBirth(1, 1, (
    metric("Temperature", DataType.DOUBLE, 20.0),
)), True)
device_data = wire("DDATA", DData(1, 2, (
    metric(None, DataType.DOUBLE, 21.5),
)), True)
node_data = wire("NDATA", NData(1, 3, (
    metric(None, DataType.UINT64, 2**64 - 1),
)))
rebirth = wire("DBIRTH", DBirth(1, 4, (
    metric("Pressure", DataType.DOUBLE, 30.0),
)), True)
death = wire("DDEATH", DDeath(1, 5), True)

# Confirm the Python encoder really omitted names/datatypes in DATA.
for item in (device_data, node_data):
    decoded = protobuf.Payload.FromString(base64.b64decode(item["payload"]))
    assert decoded.metrics[0].HasField("alias")
    assert not decoded.metrics[0].HasField("name")
    assert not decoded.metrics[0].HasField("datatype")

print(json.dumps([
    {
        "messages": [device_data],
        "name": None, "status": "unknown", "warning": "Missing DBIRTH",
    },
    {
        "messages": [node_birth, device_birth, device_data],
        "name": "Temperature", "type": "Double", "value": 21.5, "status": "online",
    },
    {
        "messages": [node_data],
        "name": "NodeCounter", "type": "UInt64", "value": str(2**64 - 1), "status": "online",
    },
    {
        "messages": [rebirth, device_data],
        "name": "Pressure", "type": "Double", "value": 21.5, "status": "online",
    },
    {
        "messages": [death],
        "name": None, "status": "offline",
    },
    {
        "messages": [device_data],
        "name": None, "status": "unknown", "warning": "Missing DBIRTH",
    },
]))
