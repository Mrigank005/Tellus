import numpy as np

from pipeline.anomaly import candidate_change_points, robust_anomalies


def test_robust_anomaly_finds_isolated_spike():
    years = np.arange(1981, 2026)
    values = np.zeros(45)
    values[22] = 10
    events = robust_anomalies(years, values)
    assert events and events[0]["year"] == 2003


def test_change_point_finds_mean_shift():
    years = np.arange(1981, 2026)
    values = np.r_[np.zeros(22), np.ones(23) * 5]
    events = candidate_change_points(years, values)
    assert events
    assert abs(events[0]["year"] - 2003) <= 1
