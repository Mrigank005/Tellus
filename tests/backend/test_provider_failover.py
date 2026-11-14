"""LLM key failover: monkeypatched urllib, no real network, no real keys."""

from __future__ import annotations

import io
import json
import urllib.error
from dataclasses import replace

import pytest

from backend.app import provider
from backend.app.config import load_api_keys, load_settings
from backend.app.provider import ProviderUnavailable, generate_chat, generate_json

OK_BODY = {"choices": [{"message": {"role": "assistant", "content": "{\"kind\": \"answer\"}"}}]}


class _Response:
    def __init__(self, body):
        self._raw = json.dumps(body).encode()

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _http_error(code):
    return urllib.error.HTTPError("https://x/chat/completions", code, "err", {}, io.BytesIO(b"{}"))


class FakeNetwork:
    """Maps the bearer token to an outcome: dict body, int status, or Exception."""

    def __init__(self, outcomes):
        self.outcomes = outcomes
        self.calls: list[str] = []

    def __call__(self, request, timeout=None):
        token = request.get_header("Authorization").removeprefix("Bearer ")
        self.calls.append(token)
        outcome = self.outcomes[token]
        if isinstance(outcome, int):
            raise _http_error(outcome)
        if isinstance(outcome, Exception):
            raise outcome
        return _Response(outcome)


@pytest.fixture(autouse=True)
def _clean_state():
    provider.reset_key_state()
    yield
    provider.reset_key_state()


def _settings(*keys):
    return replace(load_settings(), llm_api_keys=tuple(keys))


def _install(monkeypatch, outcomes):
    net = FakeNetwork(outcomes)
    monkeypatch.setattr(provider.urllib.request, "urlopen", net)
    return net


def _chat(settings):
    return generate_chat(settings, messages=[{"role": "user", "content": "hi"}])


@pytest.mark.parametrize("status", [429, 401, 402, 403, 500, 502, 503])
def test_failover_statuses_use_second_key(monkeypatch, status):
    net = _install(monkeypatch, {"k1": status, "k2": OK_BODY})
    assert _chat(_settings("k1", "k2"))["role"] == "assistant"
    assert net.calls == ["k1", "k2"]


@pytest.mark.parametrize("error", [TimeoutError("t"), urllib.error.URLError("down"),
                                   ConnectionResetError("reset")])
def test_timeouts_and_connection_errors_use_second_key(monkeypatch, error):
    net = _install(monkeypatch, {"k1": error, "k2": OK_BODY})
    _chat(_settings("k1", "k2"))
    assert net.calls == ["k1", "k2"]


@pytest.mark.parametrize("status", [400, 404, 422])
def test_request_errors_do_not_burn_keys(monkeypatch, status):
    net = _install(monkeypatch, {"k1": status, "k2": OK_BODY})
    with pytest.raises(ProviderUnavailable) as exc:
        _chat(_settings("k1", "k2"))
    assert str(status) in str(exc.value)
    assert net.calls == ["k1"]
    assert provider.key_status(_settings("k1", "k2"))["activeKey"] == 1


def test_all_keys_failing_raises_provider_unavailable(monkeypatch):
    net = _install(monkeypatch, {"k1": 429, "k2": 503, "k3": TimeoutError("t")})
    with pytest.raises(ProviderUnavailable):
        _chat(_settings("k1", "k2", "k3"))
    assert net.calls == ["k1", "k2", "k3"]


def test_generate_json_fails_over_too(monkeypatch):
    net = _install(monkeypatch, {"k1": 429, "k2": OK_BODY})
    result = generate_json(_settings("k1", "k2"), system="s", user="u", schema={})
    assert result == {"kind": "answer"}
    assert net.calls == ["k1", "k2"]


def test_no_keys_is_unavailable_without_network(monkeypatch):
    net = _install(monkeypatch, {})
    with pytest.raises(ProviderUnavailable):
        _chat(_settings())
    assert net.calls == []


def test_rate_limited_key_cools_down_and_later_requests_start_with_next(monkeypatch):
    net = _install(monkeypatch, {"k1": 429, "k2": OK_BODY})
    settings = _settings("k1", "k2")
    assert provider.key_status(settings) == {"keysConfigured": 2, "activeKey": 1}
    _chat(settings)
    assert provider.key_status(settings) == {"keysConfigured": 2, "activeKey": 2}
    net.calls.clear()
    _chat(settings)
    assert net.calls == ["k2"]  # k1 is cooling down, not retried first


def test_payment_required_also_cools_down(monkeypatch):
    _install(monkeypatch, {"k1": 402, "k2": OK_BODY})
    settings = _settings("k1", "k2")
    _chat(settings)
    assert provider.key_order(settings) == [1, 0]


def test_server_errors_do_not_cool_a_key(monkeypatch):
    _install(monkeypatch, {"k1": 503, "k2": OK_BODY})
    settings = _settings("k1", "k2")
    _chat(settings)
    assert provider.key_order(settings) == [0, 1]


def test_cooldown_expires(monkeypatch):
    _install(monkeypatch, {"k1": 429, "k2": OK_BODY})
    settings = _settings("k1", "k2")
    clock = {"t": 1000.0}
    monkeypatch.setattr(provider, "_now", lambda: clock["t"])
    _chat(settings)
    assert provider.key_order(settings) == [1, 0]
    clock["t"] += provider.KEY_COOLDOWN_SECONDS - 1
    assert provider.key_order(settings) == [1, 0]
    clock["t"] += 2
    assert provider.key_order(settings) == [0, 1]


def test_cooling_keys_are_still_tried_as_last_resort(monkeypatch):
    net = _install(monkeypatch, {"k1": 429, "k2": 429})
    settings = _settings("k1", "k2")
    with pytest.raises(ProviderUnavailable):
        _chat(settings)
    net.calls.clear()
    net.outcomes["k1"] = OK_BODY  # quota came back early
    _chat(settings)
    assert net.calls == ["k1"] or net.calls == ["k2", "k1"]


def test_key_status_never_contains_key_material():
    status = provider.key_status(_settings("sk-secret-one", "sk-secret-two"))
    assert "secret" not in json.dumps(status)


def test_env_keys_are_ordered_and_backward_compatible(monkeypatch):
    for name in ("LLM_API_KEY", "LLM_API_KEY_1", "LLM_API_KEY_2", "LLM_API_KEY_3"):
        monkeypatch.delenv(name, raising=False)
    assert load_api_keys() == ()
    monkeypatch.setenv("LLM_API_KEY", "legacy")
    assert load_api_keys() == ("legacy",)
    monkeypatch.setenv("LLM_API_KEY_2", "b")
    monkeypatch.setenv("LLM_API_KEY_1", "a")
    monkeypatch.setenv("LLM_API_KEY_3", "c")
    assert load_api_keys() == ("a", "b", "c", "legacy")
    monkeypatch.setenv("LLM_API_KEY", "a")  # duplicate dropped
    assert load_api_keys() == ("a", "b", "c")
    assert _settings("a", "b").llm_api_key == "a"
