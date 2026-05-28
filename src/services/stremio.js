import pkg from "stremio-addon-sdk";
const { addonBuilder, serveHTTP } = pkg;
import fetch from "node-fetch";
import http from "http";
import url from "url";

const CONFIG = {
  PORT: process.env.PORT || 8080,
  PUBLIC_URL: (
    process.env.PUBLIC_URL || `http://127.0.0.1:${process.env.PORT || 8080}`
  ).replace(/\/$/, ""),
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_MODEL: "gemini-2.5-flash",
  TARGET_LANG: "Português Brasileiro",
  SUBTITLE_ADDONS: ["https://opensubtitles-v3.strem.io"],
  MAX_SUBTITLES: 10,
  TRANSLATION_CHUNK_SIZE: 25,
};

const englishStore = new Map();
const translatedStore = new Map();
const pendingTranslations = new Map();
const SESSION_TS = Date.now();

const manifest = {
  id: "com.ai.translate.subtitles",
  version: "1.0.0",
  name: "🤖 AI Translate Subtitles",
  description: "English subtitles translated to PT-BR with AI",
  resources: ["subtitles"],
  types: ["movie", "series"],
  catalogs: [],
};

const builder = new addonBuilder(manifest);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodePayload(encoded) {
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

function encodePayload(data) {
  return Buffer.from(JSON.stringify(data)).toString("base64");
}

async function buscarLegendasExternas(type, id, videoHash, videoSize) {
  const extraArgs = {};

  if (videoHash) extraArgs.videoHash = videoHash;
  if (videoSize) extraArgs.videoSize = String(videoSize);

  const extraSegment = Object.keys(extraArgs).length
    ? `/${encodeURIComponent(JSON.stringify(extraArgs))}`
    : "";

  const requests = CONFIG.SUBTITLE_ADDONS.map(async (base) => {
    const api = extraSegment
      ? `${base}/subtitles/${type}/${id}${extraSegment}.json`
      : `${base}/subtitles/${type}/${id}.json`;

    try {
      console.log("[Addon Search]", api);

      const res = await fetch(api, { timeout: 10000 });

      if (!res.ok) {
        console.log(`[Addon HTTP ${res.status}]`, base);
        return [];
      }

      const text = await res.text();

      if (text.trimStart().startsWith("<")) {
        console.log("[Addon HTML Error]", base);
        return [];
      }

      const json = JSON.parse(text);

      if (!json.subtitles?.length) return [];

      console.log(`[Addon OK] ${base} → ${json.subtitles.length} subs`);
      return json.subtitles.map((sub) => ({ ...sub, source: base }));
    } catch (err) {
      console.log("[Addon Error]", base, err.message);
      return [];
    }
  });

  const results = await Promise.all(requests);
  const all = results.flat();

  const seen = new Set();

  const english = all.filter((s) => {
    const lang = (s.lang || "").toLowerCase();

    if (!lang.includes("eng") && lang !== "en") return false;

    if (seen.has(s.url)) return false;

    seen.add(s.url);

    return true;
  });

  console.log(`[ENGLISH FOUND] ${english.length} legendas únicas`);
  return english.slice(0, CONFIG.MAX_SUBTITLES);
}

async function baixarLegenda(fileUrl) {
  if (englishStore.has(fileUrl)) return englishStore.get(fileUrl);

  console.log("[DOWNLOAD]", fileUrl);

  const res = await fetch(fileUrl, { timeout: 15000 });

  if (!res.ok) throw new Error(`Subtitle download failed ${res.status}`);

  const text = await res.text();

  if (!text.includes("-->")) throw new Error("Invalid subtitle");

  englishStore.set(fileUrl, text);

  return text;
}

function splitSRT(srt, chunkSize = 80) {
  const normalized = srt.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split(/\n\n+/).filter(Boolean);

  const chunks = [];

  for (let i = 0; i < blocks.length; i += chunkSize) {
    chunks.push(blocks.slice(i, i + chunkSize).join("\n\n"));
  }

  return chunks;
}

async function chamarGemini(prompt) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, topP: 0.8, maxOutputTokens: 8192 },
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeout: 120000,
  });

  const raw = await res.text();

  if (!res.ok) {
    console.log(raw);
    throw new Error(`Gemini ${res.status}`);
  }

  const json = JSON.parse(raw);
  return json.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function traduzirChunk(chunk) {
  const prompt = `Translate this SRT subtitle to Brazilian Portuguese.

RULES:
- Preserve numbering
- Preserve timestamps
- Preserve SRT format
- Do not explain
- Do not use markdown
- Return ONLY translated SRT

${chunk}`;
  return chamarGemini(prompt);
}

async function traduzirSRT(srt) {
  const chunks = splitSRT(srt, CONFIG.TRANSLATION_CHUNK_SIZE);
  console.log("[TRANSLATE CHUNKS]", chunks.length);

  const translated = [];

  for (let i = 0; i < chunks.length; i++) {
    console.log(`[CHUNK ${i + 1}/${chunks.length}]`);
    const part = await traduzirChunk(chunks[i]);
    translated.push(part);
    if (i < chunks.length - 1) await sleep(300);
  }

  const result = translated.join("\n\n");

  return result.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

function garantirTraducao(fileUrl) {
  if (translatedStore.has(fileUrl) || pendingTranslations.has(fileUrl)) return;

  console.log("[START TRANSLATION]", fileUrl);

  const promise = (async () => {
    try {
      const srt = await baixarLegenda(fileUrl);
      const translated = await traduzirSRT(srt);
      translatedStore.set(fileUrl, translated);
      console.log("[TRANSLATION DONE]", fileUrl);
      return translated;
    } catch (err) {
      console.error("[TRANSLATION ERROR]", err.message);
      throw err;
    } finally {
      pendingTranslations.delete(fileUrl);
    }
  })();

  pendingTranslations.set(fileUrl, promise);
}

const requestCache = new Map();

function montarResultado(subtitles) {
  const result = [];

  subtitles.forEach((sub, index) => {
    const payload = encodePayload({
      url: sub.url,
      filename: sub.filename,
      index,
    });

    result.push({
      id: `en-${index}`,
      lang: `🇺🇸 EN ${index + 1}`,
      url: `${CONFIG.PUBLIC_URL}/english/${payload}.srt`,
      label: sub.label || sub.filename || "English",
    });

    const payloadPT = encodePayload({
      url: sub.url,
      filename: sub.filename,
      index,
      ts: SESSION_TS,
    });

    result.push({
      id: `pt-${index}`,
      lang: `🤖 PT ${index + 1}`,
      url: `${CONFIG.PUBLIC_URL}/translate/${payloadPT}.srt`,
      label: sub.label || sub.filename || "AI Translation",
    });
  });

  return result;
}

builder.defineSubtitlesHandler(async ({ type, id, extra }) => {
  const { videoHash, videoSize } = extra || {};
  const cacheKey = `${type}:${id}`;

  if (!videoHash && requestCache.has(cacheKey)) {
    console.log("[CACHE HIT] pulando busca sem hash para", cacheKey);
    return requestCache.get(cacheKey);
  }

  try {
    console.log(
      "\n[REQUEST]",
      type,
      id,
      videoHash ? `hash:${videoHash}` : "sem hash",
    );

    const subtitles = await buscarLegendasExternas(type, id);
    const result = { subtitles: montarResultado(subtitles) };

    console.log("[RETURN SUBTITLES]", result.subtitles.length);
    if (videoHash) requestCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.error(err);
    return { subtitles: [] };
  }
});

const addonInterface = builder.getInterface();

export function createServer() {
  return http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept",
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    const parsed = url.parse(req.url);
    const pathname = parsed.pathname;

    if (pathname.startsWith("/english/")) {
      try {
        const encoded = pathname.replace("/english/", "").replace(".srt", "");

        const decoded = decodePayload(encoded);

        const srt = await baixarLegenda(decoded.url);

        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        });

        return res.end(srt, "utf8");
      } catch (err) {
        console.error(err);
        res.writeHead(500);
        return res.end("English subtitle error");
      }
    }

    if (pathname.startsWith("/translate/")) {
      try {
        const encoded = pathname.replace("/translate/", "").replace(".srt", "");
        const decoded = decodePayload(encoded);
        const fileUrl = decoded.url;

        if (translatedStore.has(fileUrl)) {
          console.log("[PT CACHE]", fileUrl);

          res.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          });

          return res.end(translatedStore.get(fileUrl), "utf8");
        }

        garantirTraducao(fileUrl);

        const translated = await pendingTranslations.get(fileUrl);

        console.log("[PT OK]", fileUrl);

        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        });

        return res.end(translated, "utf8");
      } catch (err) {
        console.error(err);
        res.writeHead(500);
        return res.end("Translation error");
      }
    }

    serveHTTP(addonInterface, req, res);
  });
}

export { CONFIG };
