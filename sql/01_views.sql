-- QueueSense analytics views. Dataset: queuesense (BigQuery sandbox, project queuesense-apu).
-- Source tables are loaded from simulator/out/*.csv (all rows simulated = TRUE).
-- Times are stored in UTC and converted to Malaysia time here.

-- Journeys with Malaysia-time fields.
CREATE OR REPLACE VIEW queuesense.v_journeys AS
SELECT
  j.*,
  DATETIME(j.queue_join_ts, 'Asia/Kuala_Lumpur') AS join_myt,
  DATE(j.queue_join_ts, 'Asia/Kuala_Lumpur') AS join_date,
  FORMAT_DATE('%a', DATE(j.queue_join_ts, 'Asia/Kuala_Lumpur')) AS dow,
  MOD(EXTRACT(DAYOFWEEK FROM DATE(j.queue_join_ts, 'Asia/Kuala_Lumpur')) + 5, 7) AS dow_idx, -- 0 = Monday
  EXTRACT(HOUR FROM DATETIME(j.queue_join_ts, 'Asia/Kuala_Lumpur')) AS hour,
  j.wait_seconds / 60 AS wait_min
FROM queuesense.matched_journeys AS j;

-- Bus trips with Malaysia-time fields.
CREATE OR REPLACE VIEW queuesense.v_trips AS
SELECT
  t.*,
  DATE(t.departure_ts, 'Asia/Kuala_Lumpur') AS dep_date,
  FORMAT_DATE('%a', DATE(t.departure_ts, 'Asia/Kuala_Lumpur')) AS dow,
  MOD(EXTRACT(DAYOFWEEK FROM DATE(t.departure_ts, 'Asia/Kuala_Lumpur')) + 5, 7) AS dow_idx,
  EXTRACT(HOUR FROM DATETIME(t.departure_ts, 'Asia/Kuala_Lumpur')) AS hour,
  SAFE_DIVIDE(t.boarded_count, t.capacity) AS fill_rate
FROM queuesense.bus_trips AS t;

-- Heatmap: average and 90th-percentile wait by weekday and hour.
CREATE OR REPLACE VIEW queuesense.v_wait_heatmap AS
SELECT
  dow_idx, dow, hour,
  ROUND(AVG(wait_min), 1) AS avg_wait_min,
  ROUND(APPROX_QUANTILES(wait_min, 100)[OFFSET(90)], 1) AS p90_wait_min,
  COUNT(*) AS journeys,
  COUNT(DISTINCT join_date) AS days,
  LOGICAL_AND(simulated) AS simulated
FROM queuesense.v_journeys
GROUP BY dow_idx, dow, hour;

-- Headline KPIs over the whole history.
CREATE OR REPLACE VIEW queuesense.v_kpis AS
SELECT
  (SELECT ROUND(AVG(wait_min), 1) FROM queuesense.v_journeys) AS avg_wait_min,
  (SELECT ROUND(APPROX_QUANTILES(wait_min, 100)[OFFSET(90)], 1) FROM queuesense.v_journeys) AS p90_wait_min,
  (SELECT ROUND(AVG(left_behind_count), 1) FROM queuesense.v_trips) AS avg_left_behind_per_bus,
  (SELECT ROUND(AVG(fill_rate) * 100, 0) FROM queuesense.v_trips) AS avg_fill_pct,
  (SELECT COUNT(*) FROM queuesense.v_journeys) AS journeys,
  (SELECT COUNT(*) FROM queuesense.v_trips) AS trips,
  (SELECT MIN(join_date) FROM queuesense.v_journeys) AS from_date,
  (SELECT MAX(join_date) FROM queuesense.v_journeys) AS to_date,
  TRUE AS simulated;

-- Left-behind trend per day.
CREATE OR REPLACE VIEW queuesense.v_left_behind_daily AS
SELECT
  dep_date, dow,
  SUM(left_behind_count) AS left_behind_total,
  ROUND(AVG(left_behind_count), 1) AS left_behind_per_bus,
  MAX(left_behind_count) AS worst_bus,
  COUNT(*) AS trips,
  LOGICAL_AND(simulated) AS simulated
FROM queuesense.v_trips
GROUP BY dep_date, dow;

-- Bus fill rate and left-behind by weekday and hour (what the timetable delivers).
CREATE OR REPLACE VIEW queuesense.v_bus_slots AS
SELECT
  dow_idx, dow, hour,
  ROUND(AVG(fill_rate) * 100, 0) AS fill_pct,
  ROUND(AVG(left_behind_count), 1) AS left_behind_per_bus,
  ROUND(COUNT(*) / COUNT(DISTINCT dep_date), 1) AS buses_per_hour,
  ANY_VALUE(capacity) AS capacity,
  LOGICAL_AND(simulated) AS simulated
FROM queuesense.v_trips
GROUP BY dow_idx, dow, hour;

-- The demand series for the forecast (v_demand_slots) lives in 02_forecast.sql.
