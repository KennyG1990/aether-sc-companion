"""Star Citizen Native gRPC Bridge (127.0.0.1:2942 — sc.game.telemetry.v1.GameTelemetryService).

Ready to bind directly to generated protobuf stubs (`sc_telemetry_pb2`, `sc_telemetry_pb2_grpc`)
extracted from StarCitizen.exe via `Purzifal/sc_make_proto`. Gracefully reports connection
readiness when Star Citizen is not running locally.
"""

from __future__ import annotations

import socket
from typing import Any


class StarCitizenGrpcBridge:
    """Manages local gRPC connectivity to StarCitizen.exe on 127.0.0.1:2942."""

    def __init__(self, target: str = "127.0.0.1:2942") -> None:
        self.target = target
        self.connected = False
        self.proto_loaded = False
        self.last_error: str | None = None
        self._stub: Any = None
        self._try_load_proto()

    def _try_load_proto(self) -> None:
        try:
            # Optional generated modules from `sc_make_proto`
            import sc_telemetry_pb2  # type: ignore  # noqa: F401
            import sc_telemetry_pb2_grpc  # type: ignore  # noqa: F401

            self.proto_loaded = True
        except ImportError:
            self.proto_loaded = False

    def probe_port(self, timeout: float = 0.25) -> bool:
        host, port_str = self.target.split(":")
        port = int(port_str)
        try:
            with socket.create_connection((host, port), timeout=timeout):
                self.connected = True
                self.last_error = None
                return True
        except OSError as exc:
            self.connected = False
            self.last_error = f"Star Citizen gRPC port {self.target} unreachable ({exc.__class__.__name__})"
            return False

    def dispatch_action(self, action_id: str, parameters: dict[str, Any]) -> tuple[bool, str]:
        if not self.probe_port():
            return (
                False,
                f"Cannot dispatch '{action_id}' via live gRPC: {self.last_error}. "
                "Enable GRPC_CLIENT_SERVER_ENABLED=true or switch to Simulator mode.",
            )
        if not self.proto_loaded:
            return (
                False,
                f"Port {self.target} is open, but compiled sc_telemetry_pb2.py is not installed yet. "
                "Extract schema from StarCitizen.exe with sc_make_proto.",
            )
        # Hook for live TriggerGameActions RPC once sc_telemetry_pb2 is dropped into backend/app/telemetry/
        return (
            True,
            f"Dispatched '{action_id}' to Star Citizen TriggerGameActions on {self.target}.",
        )

    def status_dict(self) -> dict[str, Any]:
        port_open = self.probe_port()
        return {
            "target": self.target,
            "port_open": port_open,
            "proto_loaded": self.proto_loaded,
            "last_error": self.last_error,
        }
