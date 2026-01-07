from __future__ import annotations

import secrets
import socket

from services.saw_api.app.service_manager import allocate_free_local_port


def test_allocate_free_local_port_retries_on_collision(monkeypatch) -> None:
    host = "127.0.0.1"
    port_min = 50000
    port_max = 50001

    # Occupy port_min so first attempt collides.
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((host, port_min))

    # Force first pick -> port_min, second pick -> port_max
    picks = [0, 1]

    def fake_randbelow(n: int) -> int:
        return picks.pop(0)

    monkeypatch.setattr(secrets, "randbelow", fake_randbelow)

    try:
        p = allocate_free_local_port(host=host, port_min=port_min, port_max=port_max, retries=2)
        assert p == port_max
    finally:
        s.close()


