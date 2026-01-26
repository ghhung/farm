export const config = {
  api: {
    bodyParser: true,
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  const BLYNK_AUTH_TOKEN = process.env.BLYNK_AUTH_TOKEN;
  if (!BLYNK_AUTH_TOKEN) {
    return res.status(500).json({
      message: "Missing Blynk token in environment vars",
    });
  }

  const data = req.body || {};
  console.log("Received body:", data);

  // -------------------------------
  // Range Parser
  // -------------------------------
  function parseRange(str) {
    if (!str || typeof str !== "string") return [0, 0];

    const parts = str.split(/[-–—\u2011]/).map((s) => {
      let clean = s.replace(/[^\d.,]/g, "").trim();
      clean = clean.replace(/[.,](?=\d{3}\b)/g, "");
      const n = Number(clean.replace(",", "."));
      return isNaN(n) ? 0 : n;
    });

    return parts.length === 2 ? parts : [0, 0];
  }

  // -------------------------------
  // Sunrise / Sunset Calculator
  // -------------------------------
  const DEG_TO_RAD = Math.PI / 180;

  function calcSunTime(year, month, day, lat, lon, isSunrise) {
    const Jday =
      367 * year -
      Math.floor(7 * (year + Math.floor((month + 9) / 12)) / 4) +
      Math.floor(275 * month / 9) +
      day +
      1721013.5 -
      lon / 360;

    const n = Jday - 2451545.0;
    const M = ((357.5291 + 0.98560028 * n) % 360 + 360) % 360;

    const C =
      1.9148 * Math.sin(M * DEG_TO_RAD) +
      0.0200 * Math.sin(2 * M * DEG_TO_RAD) +
      0.0003 * Math.sin(3 * M * DEG_TO_RAD);

    const lambda = ((M + 102.9372 + C + 180) % 360 + 360) % 360;

    const Jtransit =
      2451545 +
      n +
      0.0053 * Math.sin(M * DEG_TO_RAD) -
      0.0069 * Math.sin(2 * lambda * DEG_TO_RAD);

    const decl = Math.asin(
      Math.sin(lambda * DEG_TO_RAD) * Math.sin(23.44 * DEG_TO_RAD)
    );

    const hourAngle = Math.acos(
      (Math.sin(-0.83 * DEG_TO_RAD) -
        Math.sin(lat * DEG_TO_RAD) * Math.sin(decl)) /
        (Math.cos(lat * DEG_TO_RAD) * Math.cos(decl))
    );

    const J = isSunrise
      ? Jtransit - hourAngle / (2 * Math.PI)
      : Jtransit + hourAngle / (2 * Math.PI);

    return (((J - Math.floor(J)) * 24) + 7) % 24;
  }

  function decimalToHM(decimal) {
    let h = Math.floor(decimal);
    let m = Math.round((decimal - h) * 60);
    if (m === 60) { m = 0; h++; }
    if (h >= 24) h -= 24;
    return { h, m };
  }

  function getSunTimes(year, month, day, lat, lon) {
    const sunrise = decimalToHM(calcSunTime(year, month, day, lat, lon, true));
    const sunset  = decimalToHM(calcSunTime(year, month, day, lat, lon, false));
    if (lat && lon) {
      console.log("Using user latitude/longitude:", lat, lon);
    } else {
      console.log("⚠️ No lat/lon provided, using default");
    }

    return {
      sunrise_h: sunrise.h,
      sunrise_m: sunrise.m,
      sunset_h: sunset.h,
      sunset_m: sunset.m,
    };
  }

  // -------------------------------
  // Parse incoming ranges
  // -------------------------------
  const [ndLow, ndHigh] = parseRange(data.nd);
  const [daLow, daHigh] = parseRange(data.da);

  let asLow = 0,
    asHigh = 0;
  try {
    const asPart = (data.as || "").split(", ")[1] || "";
    [asLow, asHigh] = parseRange(asPart);
  } catch (e) {
    console.warn("⚠️ Failed to parse 'as':", data.as, e);
  }

  // -------------------------------
  // Sunrise / Sunset (if "~" provided)
  // -------------------------------
  let sunrise_h = 0,
    sunrise_m = 0,
    sunset_h = 0,
    sunset_m = 0;

  if ((data.as || "").includes("~")) {
    const today = new Date();
    const year  = today.getFullYear();
    const month = today.getMonth() + 1;
    const day   = today.getDate();

    const lat = data.lat ? Number(data.lat) : 10.9;
    const lon = data.lon ? Number(data.lon) : 106.7;
    console.log("Latitude used:", lat, "Longitude used:", lon);
    
    const times = getSunTimes(year, month, day, lat, lon);

    sunrise_h = times.sunrise_h;
    sunrise_m = times.sunrise_m;
    sunset_h  = times.sunset_h;
    sunset_m  = times.sunset_m;
  }

  // -------------------------------
  // Blynk Parameters
  // -------------------------------
  const parameters = {
    3: ndLow,
    4: ndHigh,
    8: daLow,
    9: daHigh,
    12: asLow,
    13: asHigh,
    20: sunrise_h,
    21: sunset_h,
    22: sunrise_m,
    23: sunset_m,
  };

  console.log("Parsed parameters:", parameters);

  // -------------------------------
  // Send to Blynk
  // -------------------------------
  const results = {};

  for (const [pin, value] of Object.entries(parameters)) {
    const url = `https://blynk.cloud/external/api/update?token=${BLYNK_AUTH_TOKEN}&pin=V${pin}&value=${value}`;

    try {
      const resp = await fetch(url);
      const text = await resp.text();

      results[`V${pin}`] = {
        value,
        success: resp.ok,
        status: resp.status,
        response: text,
      };

      if (!resp.ok)
        console.error(`❌ Failed V${pin}: HTTP ${resp.status} →`, text);
    } catch (e) {
      console.error(`❌ Error sending to V${pin}:`, e);
      results[`V${pin}`] = {
        value,
        success: false,
        status: 0,
        response: e.message,
      };
    }
  }

  const ok = Object.values(results).every((r) => r.success);

  res.status(ok ? 200 : 500).json({
    message: ok ? "🌿 All sent successfully!" : "⚠️ Some parameters failed.",
    details: results,
  });
}
