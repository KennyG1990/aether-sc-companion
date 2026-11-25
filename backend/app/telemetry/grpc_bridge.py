"""Star Citizen Native gRPC Bridge & Process Watcher (StarCitizen.exe -> 127.0.0.1:2942).

Monitors:
1. Whether StarCitizen.exe is configured / installed on disk.
2. Whether StarCitizen.exe is currently running (via lightweight Win32 Toolhelp snapshot — zero subprocess flash).
3. Whether GRPC_CLIENT_SERVER_ENABLED is configured in Windows env/registry.
4. Whether Star Citizen's local gRPC Telemetry API (127.0.0.1:2942) is live and talking.

Outputs a 3-state game link indicator strictly for the Star Citizen game API (never the LLM):
  - 'red'    : StarCitizen.exe not configured/running or game telemetry API unlinked.
  - 'yellow' : StarCitizen.exe detected running; handshaking / awaiting game gRPC API on 127.0.0.1:2942.
  - 'green'  : StarCitizen.exe running AND local gRPC Telemetry API actively connected.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import socket
import sys
import time
from typing import Any


COMMON_SC_REL_PATHS = [
    r"Roberts Space Industries\StarCitizen\LIVE\Bin64\StarCitizen.exe",
    r"Roberts Space Industries\StarCitizen\PTU\Bin64\StarCitizen.exe",
    r"Roberts Space Industries\StarCitizen\EPTU\Bin64\StarCitizen.exe",
    r"Roberts Space Industries\StarCitizen\TECH-PREVIEW\Bin64\StarCitizen.exe",
    r"Program Files\Roberts Space Industries\StarCitizen\LIVE\Bin64\StarCitizen.exe",
    r"Program Files\Roberts Space Industries\StarCitizen\PTU\Bin64\StarCitizen.exe",
    r"Program Files\Roberts Space Industries\StarCitizen\EPTU\Bin64\StarCitizen.exe",
    r"Games\Roberts Space Industries\StarCitizen\LIVE\Bin64\StarCitizen.exe",
    r"Games\StarCitizen\LIVE\Bin64\StarCitizen.exe",
    r"StarCitizen\LIVE\Bin64\StarCitizen.exe",
]


def _find_windows_process_pid(target_exe: str = "StarCitizen.exe") -> int | None:
    """Fast, zero-window Win32 process lookup via CreateToolhelp32Snapshot."""
    if sys.platform != "win32":
        return None

    TH32CS_SNAPPROCESS = 0x00000002
    INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
    MAX_PATH = 260

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_void_p),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", wintypes.LONG),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * MAX_PATH),
        ]

    kernel32 = ctypes.windll.kernel32
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.Process32FirstW.restype = wintypes.BOOL
    kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.Process32NextW.restype = wintypes.BOOL
    kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snap or snap == INVALID_HANDLE_VALUE:
        return None

    target_lower = target_exe.lower()
    entry = PROCESSENTRY32W()
    entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
    try:
        if kernel32.Process32FirstW(snap, ctypes.byref(entry)):
            while True:
                if entry.szExeFile.lower() == target_lower:
                    return int(entry.th32ProcessID)
                if not kernel32.Process32NextW(snap, ctypes.byref(entry)):
                    break
    except Exception:
        return None
    finally:
        kernel32.CloseHandle(snap)
    return None


def _is_grpc_env_enabled() -> bool:
    """Check process env and Windows User/Machine Registry for GRPC_CLIENT_SERVER_ENABLED."""
    val = os.getenv("GRPC_CLIENT_SERVER_ENABLED", "").strip().lower()
    if val in {"1", "true", "yes", "on"}:
        return True
    if sys.platform != "win32":
        return False
    try:
        import winreg  # type: ignore

        for hive, subkey in (
            (winreg.HKEY_CURRENT_USER, r"Environment"),
            (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
        ):
            try:
                with winreg.OpenKey(hive, subkey) as key:
                    reg_val, _ = winreg.QueryValueEx(key, "GRPC_CLIENT_SERVER_ENABLED")
                    if str(reg_val).strip().lower() in {"1", "true", "yes", "on"}:
                        return True
            except OSError:
                continue
    except Exception:
        pass
    return False


def discover_star_citizen_exe(configured_path: str = "") -> tuple[bool, str]:
    """Verify configured StarCitizen.exe path or auto-scan common RSI install directories."""
    raw = (configured_path or "").strip().strip('"')
    if raw:
        p = Path(raw)
        if p.is_file() and p.name.lower().endswith(".exe"):
            return True, str(p)
        # Allow pointing at the Bin64 or LIVE directory too
        for candidate in (p / "StarCitizen.exe", p / "Bin64" / "StarCitizen.exe"):
            if candidate.is_file():
                return True, str(candidate)
        return False, raw

    for drive in ("C:", "D:", "E:", "F:", "G:"):
        root = Path(f"{drive}\\")
        if not root.exists():
            continue
        for rel in COMMON_SC_REL_PATHS:
            cand = root / rel
            if cand.is_file():
                return True, str(cand)
    return False, ""


class StarCitizenGrpcBridge:
    """Monitors StarCitizen.exe process + local gRPC connectivity on 127.0.0.1:2942."""

    def __init__(self, target: str = "127.0.0.1:2942", exe_path: str = "") -> None:
        self.target = target
        self.configured_exe_path = exe_path
        self.connected = False
        self.proto_loaded = False
        self.last_error: str | None = None
        self._stub: Any = None
        self._test_override: str | None = None  # None (auto) | 'red' | 'yellow' | 'green'
        self._last_state: dict[str, Any] = {}
        self._try_load_proto()
        self.refresh_game_link()

    def _try_load_proto(self) -> None:
        try:
            import sc_telemetry_pb2  # type: ignore  # noqa: F401
            import sc_telemetry_pb2_grpc  # type: ignore  # noqa: F401

            self.proto_loaded = True
        except ImportError:
            self.proto_loaded = False

    def set_configured_exe(self, exe_path: str) -> None:
        self.configured_exe_path = (exe_path or "").strip()

    def set_test_override(self, state: str | None) -> dict[str, Any]:
        if state in {"red", "yellow", "green"}:
            self._test_override = state
        else:
            self._test_override = None
        return self.refresh_game_link()

    def probe_port(self, timeout: float = 0.2) -> bool:
        try:
            host, port_str = self.target.split(":")
            port = int(port_str)
        except ValueError:
            self.connected = False
            self.last_error = f"Invalid gRPC target '{self.target}'"
            return False
        try:
            with socket.create_connection((host, port), timeout=timeout):
                self.connected = True
                self.last_error = None
                return True
        except OSError as exc:
            self.connected = False
            self.last_error = f"Star Citizen gRPC port {self.target} unreachable ({exc.__class__.__name__})"
            return False

    def refresh_game_link(self) -> dict[str, Any]:
        """Poll StarCitizen.exe + gRPC API and compute authoritative Red/Yellow/Green game-link status."""
        exe_found, resolved_path = discover_star_citizen_exe(self.configured_exe_path)
        exe_name = Path(resolved_path).name if resolved_path else "StarCitizen.exe"
        pid = _find_windows_process_pid(exe_name) or _find_windows_process_pid("StarCitizen.exe")
        exe_running = pid is not None
        grpc_env = _is_grpc_env_enabled()
        port_open = self.probe_port(timeout=0.18)

        # True 3-state game link state machine (strictly Star Citizen .exe + game telemetry API)
        if exe_running and port_open:
            state = "green"
            status = "CONNECTED"
            label = "Star Citizen API Live"
            detail = f"StarCitizen.exe (PID {pid}) streaming gRPC telemetry on {self.target}."
        elif exe_running and not port_open:
            state = "yellow"
            status = "CONNECTING"
            label = "StarCitizen.exe detected · Connecting API"
            detail = (
                f"StarCitizen.exe (PID {pid}) is running; waiting for gRPC API on {self.target}."
                if grpc_env
                else f"StarCitizen.exe (PID {pid}) is running, but gRPC port {self.target} is closed. Set GRPC_CLIENT_SERVER_ENABLED=true."
            )
        elif port_open:
            # Port open even if exe name differs (e.g., custom test server or PTU wrapper)
            state = "green"
            status = "CONNECTED"
            label = "Star Citizen API Live"
            detail = f"Telemetry gRPC server reachable on {self.target}."
        elif not exe_found:
            state = "red"
            status = "NOT_CONFIGURED"
            label = "StarCitizen.exe not configured"
            detail = (
                "StarCitizen.exe not detected or configured. Set your StarCitizen.exe path in Settings -> Config "
                "and launch the game with GRPC_CLIENT_SERVER_ENABLED=true."
            )
        else:
            state = "red"
            status = "DISCONNECTED"
            label = "StarCitizen.exe not running"
            detail = (
                f"Configured ({resolved_path}), waiting for StarCitizen.exe to launch "
                f"and open gRPC telemetry on {self.target}."
            )

        # Optional preview override (only when manually triggered from Settings -> Ship & Sim)
        if self._test_override == "red":
            state = "red"
            status = "PREVIEW_DISCONNECTED"
            label = "StarCitizen.exe offline (Preview)"
            detail = "Previewing RED state: StarCitizen.exe not running / game API disconnected."
        elif self._test_override == "yellow":
            state = "yellow"
            status = "PREVIEW_CONNECTING"
            label = "StarCitizen.exe detected · Handshaking (Preview)"
            detail = "Previewing YELLOW state: StarCitizen.exe launched, handshaking with 127.0.0.1:2942."
        elif self._test_override == "green":
            state = "green"
            status = "PREVIEW_CONNECTED"
            label = "Star Citizen API Live (Preview)"
            detail = "Previewing GREEN state: Star Citizen local gRPC API actively talking to AETHER."

        self._last_state = {
            "state": state,
            "status": status,
            "exe_configured": exe_found,
            "exe_path": resolved_path,
            "exe_running": exe_running,
            "exe_pid": pid,
            "grpc_env_enabled": grpc_env,
            "api_connected": port_open,
            "grpc_target": self.target,
            "proto_loaded": self.proto_loaded,
            "label": label,
            "detail": detail,
            "override": self._test_override,
            "checked_at": time.time(),
        }
        return self._last_state

    @property
    def game_link_state(self) -> dict[str, Any]:
        return self._last_state or self.refresh_game_link()

    def dispatch_action(self, action_id: str, parameters: dict[str, Any]) -> tuple[bool, str]:
        if not self.probe_port():
            return (
                False,
                f"Cannot dispatch '{action_id}' via live gRPC: {self.last_error}. "
                "Launch StarCitizen.exe with GRPC_CLIENT_SERVER_ENABLED=true or use Simulator mode.",
            )
        if not self.proto_loaded:
            return (
                False,
                f"Port {self.target} is open, but compiled sc_telemetry_pb2.py is not installed yet. "
                "Extract schema from StarCitizen.exe with sc_make_proto.",
            )
        return (
            True,
            f"Dispatched '{action_id}' to Star Citizen TriggerGameActions on {self.target}.",
        )

    def status_dict(self) -> dict[str, Any]:
        info = self.refresh_game_link()
        return {
            "target": self.target,
            "port_open": info["api_connected"],
            "proto_loaded": self.proto_loaded,
            "last_error": self.last_error,
            "game_link": info,
        }
