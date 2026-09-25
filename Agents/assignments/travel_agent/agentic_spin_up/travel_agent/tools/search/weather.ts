import { settings } from "../../config.ts";
import { geocode } from "./geo.ts";
import { requestJson } from "../http.ts";
import { type Dict, addDays, get, isoDate, numStr, parseIsoDate, pyOr, todayIso, truthy } from "../util.ts";

const FC_URL = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";

const WMO: Record<string, string> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Drizzle", 55: "Dense drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
  71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
  80: "Rain showers", 81: "Rain showers", 82: "Violent rain showers",
  95: "Thunderstorm", 96: "Thunderstorm w/ hail", 99: "Thunderstorm w/ hail",
};

function dateList(startDate: string | null | undefined, numDays: number): string[] {
  const start = parseIsoDate(startDate) ? startDate! : todayIso();
  return Array.from({ length: numDays }, (_, i) => addDays(start, i)!);
}

export async function getForecast(destination: string, numDays: number, startDate: string | null = null): Promise<Dict> {
  const days = Math.max(1, Math.min(numDays, 14));
  const wanted = dateList(startDate, days);
  const daily = "temperature_2m_max,temperature_2m_min";

  const [lat, lon] = await geocode(destination);
  if (lat !== null) {
    // Real forecasts only cover ~16 days ahead.
    const fc = await requestJson("GET", FC_URL, {
      params: {
        latitude: lat, longitude: lon, timezone: "auto",
        daily: `${daily},precipitation_probability_max,weather_code`,
        start_date: wanted[0], end_date: wanted.at(-1),
      },
    });
    let parsed = parseDaily(fc, wanted, "precipitation_probability_max", false);
    if (parsed) return { source: "open-meteo", unavailable: false, days: parsed };

    // Dates too far out: the same dates last year are a seasonal guide.
    const arch = await requestJson("GET", ARCHIVE_URL, {
      params: {
        latitude: lat, longitude: lon, timezone: "auto",
        daily: `${daily},precipitation_hours,weather_code`,
        start_date: shiftYear(wanted[0]), end_date: shiftYear(wanted.at(-1)!),
      },
    });
    parsed = parseDaily(arch, wanted, "precipitation_hours", true);
    if (parsed) return { source: "seasonal (same dates last year)", unavailable: false, days: parsed };
  }

  // Never invent weather when it can't be retrieved.
  return {
    source: "unavailable",
    unavailable: true,
    message: "Weather Tool: Open - Metreo api server down",
    days: wanted.map((date) => ({ date, condition: "unknown", rain_pct: 0, temp: null })),
  };
}

export function shiftYear(iso: string): string {
  const dt = parseIsoDate(iso)!;
  const [month, day] = [dt.getUTCMonth(), dt.getUTCDate()];
  const out = new Date(0);
  out.setUTCFullYear(dt.getUTCFullYear() - 1, month, month === 1 && day === 29 ? 28 : day);
  return isoDate(out);
}

function parseDaily(data: unknown, wantedDates: string[], rainKey: string, rainIsHours: boolean): Dict[] | null {
  const daily = pyOr(get(pyOr(data, {}), "daily"), {});
  const dates: unknown[] = pyOr(daily.time, []);
  if (!truthy(dates)) return null;
  const codes: unknown[] = pyOr(daily.weather_code, []);
  const rains: unknown[] = pyOr(daily[rainKey], []);
  const tmaxs: unknown[] = pyOr(daily.temperature_2m_max, []);
  const tmins: unknown[] = pyOr(daily.temperature_2m_min, []);

  return dates.map((date, i) => {
    const code = i < codes.length ? codes[i] : 0;
    const rawRain = Number(pyOr(i < rains.length ? rains[i] : 0, 0));
    const tmin = i < tmins.length ? tmins[i] : null;
    const tmax = i < tmaxs.length ? tmaxs[i] : null;
    return {
      date: i < wantedDates.length ? wantedDates[i] : date,
      condition: WMO[String(code)] ?? "Partly cloudy",
      rain_pct: rainIsHours ? Math.min(100, Math.trunc((rawRain / 24) * 100)) : Math.trunc(rawRain),
      temp: tmin !== null ? `${numStr(tmin)}°C – ${numStr(tmax)}°C` : null,
    };
  });
}

export function isBadWeather(forecast: Dict): boolean {
  if (truthy(forecast.unavailable)) return false;
  const bad = (forecast.days as Dict[]).filter((d) => d.rain_pct >= settings.badWeatherRainPct);
  return bad.length * 2 > forecast.days.length;
}
