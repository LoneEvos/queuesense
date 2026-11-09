-- Demand forecast with BigQuery ML ARIMA_PLUS (free in the sandbox within the monthly quota).
-- One daily time series per hour-of-day slot (6:00-21:00 Malaysia time), so each series has a clear
-- weekly cycle (busy Mondays, quiet Saturdays, no Sunday service). Forecasts the next 7 days.
-- First version used one continuous hourly series; ARIMA only found daily seasonality there and missed Mondays.

-- People joining the queue per (date, hour), zeros filled in.
CREATE OR REPLACE VIEW queuesense.v_demand_slots AS
WITH dates AS (
  SELECT d FROM UNNEST(GENERATE_DATE_ARRAY(
    (SELECT MIN(DATE(queue_join_ts, 'Asia/Kuala_Lumpur')) FROM queuesense.matched_journeys),
    (SELECT DATE_ADD(DATE_TRUNC(MAX(DATE(queue_join_ts, 'Asia/Kuala_Lumpur')), WEEK(MONDAY)), INTERVAL 6 DAY)
     FROM queuesense.matched_journeys))) AS d
),
slots AS (SELECT d, h FROM dates, UNNEST(GENERATE_ARRAY(6, 21)) AS h),
counts AS (
  SELECT join_date AS d, hour AS h, COUNT(*) AS joins
  FROM queuesense.v_journeys GROUP BY d, h
)
SELECT
  s.h AS hour,
  TIMESTAMP(s.d) AS day_ts, -- ARIMA_PLUS wants a TIMESTAMP; the date is the Malaysia-time date
  IFNULL(c.joins, 0) AS joins
FROM slots AS s LEFT JOIN counts AS c USING (d, h);

CREATE OR REPLACE MODEL queuesense.m_demand
OPTIONS (
  model_type = 'ARIMA_PLUS',
  time_series_timestamp_col = 'day_ts',
  time_series_data_col = 'joins',
  time_series_id_col = 'hour',
  data_frequency = 'DAILY',
  auto_arima = TRUE,
  decompose_time_series = TRUE
) AS
SELECT hour, day_ts, joins FROM queuesense.v_demand_slots;

-- Forecast table (re-run to refresh). Negative forecasts are clipped to 0.
CREATE OR REPLACE TABLE queuesense.forecasts AS
SELECT
  'stopA' AS stop_id,
  DATE(forecast_timestamp) AS slot_date,
  hour,
  FORMAT_DATE('%a', DATE(forecast_timestamp)) AS dow,
  MOD(EXTRACT(DAYOFWEEK FROM DATE(forecast_timestamp)) + 5, 7) AS dow_idx,
  GREATEST(0, ROUND(forecast_value)) AS forecast_joins,
  GREATEST(0, ROUND(prediction_interval_lower_bound)) AS joins_low,
  GREATEST(0, ROUND(prediction_interval_upper_bound)) AS joins_high,
  -- Buses needed to carry the forecast demand in that hour (40 seats each).
  CAST(CEIL(GREATEST(0, forecast_value) / 40) AS INT64) AS buses_needed,
  TRUE AS simulated
FROM ML.FORECAST(MODEL queuesense.m_demand, STRUCT(7 AS horizon, 0.8 AS confidence_level));
