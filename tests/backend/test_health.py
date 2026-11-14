"""/health must be cheap, answer GET and HEAD, and never leak keys."""

from fastapi.testclient import TestClient

from backend.app import main, provider
from backend.app.config import load_settings


def test_health_get_and_head(monkeypatch):
    def boom(*args, **kwargs):
        raise AssertionError("health must not call the LLM")
    monkeypatch.setattr(provider.urllib.request, "urlopen", boom)
    client = TestClient(main.app)
    body = client.get("/health").json()
    assert body["ok"] is True
    assert body["keysConfigured"] == len(main.settings.llm_api_keys)
    assert body["activeKey"] in range(0, body["keysConfigured"] + 1)
    for key in main.settings.llm_api_keys:
        assert key not in str(body)
    head = client.head("/health")
    assert head.status_code == 200 and head.content == b""


def test_allowed_origins_come_from_env_with_localhost_expansion(monkeypatch):
    monkeypatch.setenv("TELLUS_ALLOWED_ORIGINS",
                       "https://tellus.onrender.com, http://localhost:5173 ,")
    origins = load_settings().allowed_origins
    assert "https://tellus.onrender.com" in origins
    assert "http://127.0.0.1:5173" in origins
    assert "" not in origins
