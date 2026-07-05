import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const rawPath = resolve(root, "artwork/openrouter-icon-raw.png");
const finalPath = resolve(root, "app-icon.png");
const prompt = [
  "A polished macOS app icon for VoiZe, a local voice dictation utility.",
  "Create one single edge-to-edge icon artwork, not an app-icon mockup inside another icon.",
  "Subject: a dark graphite glass orb with a cyan-teal voice waveform subtly forming a V, floating on a deep graphite surface.",
  "Style: native Apple macOS icon, soft depth, premium material, crisp silhouette, clean at small sizes.",
  "Composition: centered subject with generous safe margins, but the background fills the whole square.",
  "Strict constraints: no white rounded square, no inner tile, no border, no frame, no outline, no UI chrome, no text, no letters, no microphone object, no screenshot background.",
  "Palette: deep graphite, luminous cyan-teal signal, one tiny warm amber highlight.",
].join(" ");

function keyFromKeychain() {
  try {
    return execFileSync("security", [
      "find-generic-password",
      "-a",
      "voize",
      "-s",
      "de.agentz.voize.openrouter_api_key",
      "-w",
    ], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function extractImage(value) {
  const candidates = [
    value?.data?.[0]?.b64_json,
    value?.data?.[0]?.b64,
    value?.images?.[0]?.b64_json,
    value?.choices?.[0]?.message?.images?.[0]?.image_url?.url,
    value?.choices?.[0]?.message?.images?.[0]?.url,
  ].filter(Boolean);
  const first = candidates[0];
  if (!first) return null;
  if (typeof first === "string" && first.startsWith("data:")) {
    return Buffer.from(first.split(",")[1], "base64");
  }
  if (typeof first === "string" && /^[A-Za-z0-9+/=]+$/.test(first.slice(0, 80))) {
    return Buffer.from(first, "base64");
  }
  return null;
}

async function generate() {
  const key = process.env.OPENROUTER_API_KEY || keyFromKeychain();
  mkdirSync(dirname(rawPath), { recursive: true });
  if (!key) return false;
  const response = await fetch("https://openrouter.ai/api/v1/images", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/AgentZ-Media/VoiZe",
      "X-OpenRouter-Title": "VoiZe",
    },
    body: JSON.stringify({
      model: "google/gemini-3.1-flash-lite-image",
      prompt,
      resolution: "1K",
      aspect_ratio: "1:1",
      output_format: "png",
      background: "transparent",
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    writeFileSync(resolve(root, "artwork/openrouter-icon-error.json"), text);
    return false;
  }
  const value = JSON.parse(text);
  const image = extractImage(value);
  if (!image) {
    writeFileSync(resolve(root, "artwork/openrouter-icon-response.json"), text);
    return false;
  }
  writeFileSync(rawPath, image);
  return true;
}

const ok = await generate().catch(() => false);
execFileSync("python3", [
  resolve(root, "scripts/postprocess_icon.py"),
  ok ? rawPath : "-",
  finalPath,
], { stdio: "inherit" });

console.log(ok ? `Generated ${finalPath} from OpenRouter.` : `Generated ${finalPath} from local fallback.`);
