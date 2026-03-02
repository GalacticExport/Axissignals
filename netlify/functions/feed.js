// netlify/functions/feed.js
// Real-time-ish feed: USGS + NASA EONET + GDELT proxy, returns a unified payload.
// Works on Netlify Functions (Node runtime with fetch available).

export async function handler() {
  try {
    const now = new Date();
    const updated = now.toISOString();

    // ---- 1) USGS Earthquakes (past 24h, min mag 4.5) ----
    // USGS FDSN Event API supports GeoJSON output.  [oai_citation:3‡USGS](https://earthquake.usgs.gov/fdsnws/event/1/?utm_source=chatgpt.com)
    const end = new Date(now);
    const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const toISODateTime = (d) => d.toISOString().slice(0, 19);

    const usgsUrl =
      `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson` +
      `&starttime=${encodeURIComponent(toISODateTime(start))}` +
      `&endtime=${encodeURIComponent(toISODateTime(end))}` +
      `&minmagnitude=4.5&orderby=time`;

    const usgs = await fetch(usgsUrl).then(r => r.json());
    const quakes = (usgs.features || []).slice(0, 25).map(f => ({
      type: "earthquake",
      title: `M${(f.properties.mag ?? "?")} — ${f.properties.place ?? "Unknown"}`,
      summary: `Depth: ${(f.geometry?.coordinates?.[2] ?? "?")} km`,
      severity: Math.max(35, Math.min(95, Math.round((f.properties.mag || 4.5) * 18))),
      lat: f.geometry?.coordinates?.[1],
      lng: f.geometry?.coordinates?.[0],
      link: f.properties?.url,
      updated: new Date(f.properties?.time || Date.now()).toISOString()
    }));

    // ---- 2) NASA EONET (open events, geojson) ----
    // EONET v3 geojson endpoint + filters.  [oai_citation:4‡EONET](https://eonet.gsfc.nasa.gov/docs/v3?utm_source=chatgpt.com)
    const eonetUrl =
      "https://eonet.gsfc.nasa.gov/api/v3/events/geojson?status=open&limit=30";

    const eonet = await fetch(eonetUrl).then(r => r.json());
    const eonetFeatures = (eonet.features || []).slice(0, 30);

    const eonetItems = eonetFeatures
      .map(f => {
        const coords = f.geometry?.coordinates; // [lng, lat] in GeoJSON
        const cat = (f.properties?.categories || []).map(c => c.title).join(", ") || "Event";
        const title = f.properties?.title || "EONET event";
        const link = (f.properties?.sources || [])[0]?.url;

        // crude severity proxy by category keywords
        const sevBase =
          /Wildfire/i.test(cat) ? 72 :
          /Severe Storm/i.test(cat) ? 65 :
          /Volcano/i.test(cat) ? 70 :
          /Flood/i.test(cat) ? 60 :
          55;

        return {
          type: "eonet",
          title: `${title}`,
          summary: `Category: ${cat}`,
          severity: sevBase,
          lat: Array.isArray(coords) ? coords[1] : null,
          lng: Array.isArray(coords) ? coords[0] : null,
          link,
          updated: f.properties?.date || updated
        };
      })
      .filter(x => Number.isFinite(x.lat) && Number.isFinite(x.lng));

    // ---- 3) GDELT proxy (news volume count) ----
    // Using GDELT as near-real-time coverage proxy.  [oai_citation:5‡GDELT Project](https://www.gdeltproject.org/?utm_source=chatgpt.com)
    // We fetch up to 250 recent matching articles and use the count as “volume”.
    const gdeltQuery = encodeURIComponent(
      '(war OR conflict OR sanctions OR "military tension" OR escalation OR invasion OR missile) lang:english'
    );
    const gdeltUrl =
      `https://api.gdeltproject.org/api/v2/doc/doc?query=${gdeltQuery}` +
      `&mode=ArtList&format=json&maxrecords=250&sort=datedesc`;

    let gdeltCount = 0;
    try {
      const gdelt = await fetch(gdeltUrl).then(r => r.json());
      gdeltCount = Array.isArray(gdelt.articles) ? gdelt.articles.length : 0;
    } catch {
      gdeltCount = 0; // don’t fail the whole feed if GDELT throttles
    }

    // ---- Axis Index (0–100) ----
    // Weighted blend: GDELT volume + quake count + eonet count
    const quakeCount = quakes.length;
    const eonetCount = eonetItems.length;

    // Normalize each component into 0..100-ish
    const gdeltScore = Math.min(100, Math.round((gdeltCount / 250) * 100));
    const quakeScore = Math.min(100, quakeCount * 10);   // 0..100
    const eonetScore = Math.min(100, eonetCount * 3.5);  // 0..100

    const axisIndex = Math.round(
      0.55 * gdeltScore + 0.25 * quakeScore + 0.20 * eonetScore
    );

    // Combined items for map + feed
    const items = [
      ...quakes,
      ...eonetItems
    ]
      .sort((a, b) => (b.severity || 0) - (a.severity || 0))
      .slice(0, 40);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      },
      body: JSON.stringify({
        updated,
        axisIndex,
        breakdown: { gdeltCount, quakeCount, eonetCount, gdeltScore, quakeScore, eonetScore },
        items
      })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "feed_failed", details: String(e) })
    };
  }
}
